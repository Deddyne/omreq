import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';
import { fixture } from '../fixtures/server.mjs';
import { createClient } from '../packages/omreq/dist/index.mjs';

/** HTTP forward proxy with CONNECT support and optional Basic auth. */
async function httpProxy({ auth } = {}) {
  const seen = { forwarded: [], connects: [], authorizations: [] };
  const sockets = new Set();
  const authorized = (header) => {
    seen.authorizations.push(header ?? null);
    return !auth || header === `Basic ${Buffer.from(auth).toString('base64')}`;
  };
  const server = http.createServer((req, res) => {
    if (!authorized(req.headers['proxy-authorization'])) {
      res.writeHead(407, { 'proxy-authenticate': 'Basic' }).end();
      return;
    }
    seen.forwarded.push(req.url);
    const target = new URL(req.url);
    const headers = { ...req.headers };
    delete headers['proxy-authorization'];
    delete headers['proxy-connection'];
    const upstream = http.request(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: req.method,
        headers,
      },
      (response) => {
        res.writeHead(response.statusCode, { ...response.headers, 'x-via-proxy': '1' });
        response.pipe(res);
      },
    );
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
  });
  server.on('connect', (req, client, head) => {
    client.on('error', () => {});
    if (!authorized(req.headers['proxy-authorization'])) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nproxy-authenticate: Basic\r\n\r\n');
      return;
    }
    seen.connects.push(req.url);
    const [host, port] = req.url.split(':');
    const upstream = net.connect(Number(port), host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    seen,
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, 'close');
    },
  };
}

/** Minimal SOCKS5 proxy (CONNECT only) with optional username/password auth. */
async function socks5({ user, pass } = {}) {
  const seen = { connects: [], auth: [] };
  const sockets = new Set();
  const server = net.createServer((client) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => {});
    let buffer = Buffer.alloc(0);
    let stage = 'greeting';
    const take = (n) => {
      const chunk = buffer.subarray(0, n);
      buffer = buffer.subarray(n);
      return chunk;
    };
    const onData = (data) => {
      buffer = Buffer.concat([buffer, data]);
      for (;;) {
        if (stage === 'greeting') {
          if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return;
          const methods = [...take(2 + buffer[1]).subarray(2)];
          const wanted = user ? 2 : 0;
          if (!methods.includes(wanted)) return client.end(Buffer.from([5, 0xff]));
          client.write(Buffer.from([5, wanted]));
          stage = user ? 'auth' : 'request';
        } else if (stage === 'auth') {
          if (buffer.length < 2) return;
          const ulen = buffer[1];
          if (buffer.length < 3 + ulen || buffer.length < 3 + ulen + buffer[2 + ulen]) return;
          const plen = buffer[2 + ulen];
          const chunk = take(3 + ulen + plen);
          const u = chunk.subarray(2, 2 + ulen).toString();
          const p = chunk.subarray(3 + ulen).toString();
          seen.auth.push(`${u}:${p}`);
          const ok = u === user && p === pass;
          client.write(Buffer.from([1, ok ? 0 : 1]));
          if (!ok) return client.end();
          stage = 'request';
        } else if (stage === 'request') {
          if (buffer.length < 5) return;
          const type = buffer[3];
          const length = type === 1 ? 4 : type === 4 ? 16 : 1 + buffer[4];
          if (buffer.length < 4 + length + 2) return;
          const chunk = take(4 + length + 2);
          const address =
            type === 1
              ? [...chunk.subarray(4, 8)].join('.')
              : type === 3
                ? chunk.subarray(5, 5 + chunk[4]).toString()
                : null;
          const port = chunk.readUInt16BE(4 + length);
          seen.connects.push(`${address}:${port}`);
          client.off('data', onData);
          const upstream = net.connect(port, address, () => {
            client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
            if (buffer.length) upstream.write(buffer);
            upstream.pipe(client);
            client.pipe(upstream);
          });
          upstream.on('error', () => client.destroy());
          stage = 'piped';
          return;
        } else return;
      }
    };
    client.on('data', onData);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    seen,
    port: server.address().port,
    async close() {
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, 'close');
    },
  };
}

async function echo(client, url) {
  const response = await client.get(url);
  return { response, body: await response.json() };
}

test('HTTP forward proxy carries plain HTTP with Basic credentials from the URL', async () => {
  const target = await fixture();
  const proxy = await httpProxy({ auth: 'ada:s3cr@t' });
  const url = new URL(proxy.url);
  url.username = 'ada';
  url.password = 's3cr@t';
  const client = createClient({ proxy: url });
  try {
    const { response, body } = await echo(client, `${target.url}/echo?x=1`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-via-proxy'), '1');
    assert.equal(body.url, '/echo?x=1');
    assert.deepEqual(proxy.seen.forwarded, [`${target.url}/echo?x=1`]);
    assert.equal(body.headers['proxy-authorization'], undefined);
  } finally {
    await client.close();
    await proxy.close();
    await target.close();
  }
});

test('HTTPS targets tunnel through CONNECT and still verify the origin certificate', async () => {
  const target = await fixture({ tls: true });
  const proxy = await httpProxy();
  const client = createClient({ ca: target.ca, proxy: proxy.url });
  try {
    const { response, body } = await echo(client, `${target.url}/echo`);
    assert.equal(response.status, 200);
    assert.equal(body.url, '/echo');
    assert.equal(response.headers.get('x-via-proxy'), null);
    assert.deepEqual(proxy.seen.connects, [new URL(target.url).host]);
    // The tunnel is pooled: a second request reuses it.
    await (await client.get(`${target.url}/echo`)).dispose();
    assert.equal(proxy.seen.connects.length, 1);
    assert.deepEqual(
      client.getStats().connectionOrigins.map((o) => o.origin),
      [target.url],
      'TCP accounting is per target origin',
    );
  } finally {
    await client.close();
    await proxy.close();
    await target.close();
  }
});

test('a CONNECT tunnel cannot bypass certificate verification', async () => {
  const target = await fixture({ tls: true });
  const proxy = await httpProxy();
  const client = createClient({ proxy: proxy.url });
  try {
    await assert.rejects(client.get(`${target.url}/echo`), { code: 'ERR_TLS', phase: 'tls' });
  } finally {
    await client.close();
    await proxy.close();
    await target.close();
  }
});

test('a proxy rejecting credentials fails with ERR_PROXY and no credential in the message', async () => {
  const target = await fixture({ tls: true });
  const proxy = await httpProxy({ auth: 'ada:right' });
  const url = new URL(proxy.url);
  url.username = 'ada';
  url.password = 'wrong-secret';
  const client = createClient({ ca: target.ca, proxy: url });
  try {
    const error = await client.get(`${target.url}/echo`).then(
      () => assert.fail('expected a proxy failure'),
      (e) => e,
    );
    assert.equal(error.code, 'ERR_PROXY');
    assert.equal(error.phase, 'proxy');
    assert.doesNotMatch(`${error.message} ${error.stack}`, /wrong-secret|ada:/);
  } finally {
    await client.close();
    await proxy.close();
    await target.close();
  }
});

for (const auth of [false, true])
  test(`SOCKS5${auth ? ' with username/password' : ''} carries HTTP and HTTPS`, async () => {
    const plain = await fixture();
    const secure = await fixture({ tls: true });
    const proxy = await socks5(auth ? { user: 'ada', pass: 'pw' } : {});
    const client = createClient({
      ca: secure.ca,
      proxy: `socks5://${auth ? 'ada:pw@' : ''}127.0.0.1:${proxy.port}`,
    });
    try {
      assert.equal((await echo(client, `${plain.url}/echo`)).body.url, '/echo');
      assert.equal((await echo(client, `${secure.url}/echo`)).body.url, '/echo');
      assert.deepEqual(proxy.seen.connects, [new URL(plain.url).host, new URL(secure.url).host]);
      if (auth) assert.deepEqual(proxy.seen.auth, ['ada:pw', 'ada:pw']);
    } finally {
      await client.close();
      await proxy.close();
      await plain.close();
      await secure.close();
    }
  });

test('socks5h resolves the target name at the proxy', async () => {
  const target = await fixture();
  const proxy = await socks5();
  const client = createClient({ proxy: `socks5h://127.0.0.1:${proxy.port}` });
  try {
    const port = new URL(target.url).port;
    assert.equal((await echo(client, `http://localhost:${port}/echo`)).body.url, '/echo');
    assert.deepEqual(proxy.seen.connects, [`localhost:${port}`]);
  } finally {
    await client.close();
    await proxy.close();
    await target.close();
  }
});

test('per-scheme routes and noProxy choose the route for each target', async () => {
  const plain = await fixture();
  const secure = await fixture({ tls: true });
  const proxy = await httpProxy();
  const bypass = createClient({
    ca: secure.ca,
    proxy: { url: proxy.url, noProxy: ['127.0.0.1'] },
  });
  const httpsOnly = createClient({ ca: secure.ca, proxy: { https: proxy.url } });
  try {
    await (await bypass.get(`${plain.url}/echo`)).dispose();
    await (await bypass.get(`${secure.url}/echo`)).dispose();
    assert.deepEqual(proxy.seen, { forwarded: [], connects: [], authorizations: [] });
    await (await httpsOnly.get(`${plain.url}/echo`)).dispose();
    assert.equal(proxy.seen.forwarded.length, 0, 'plain HTTP went direct');
    await (await httpsOnly.get(`${secure.url}/echo`)).dispose();
    assert.deepEqual(proxy.seen.connects, [new URL(secure.url).host]);
  } finally {
    await bypass.close();
    await httpsOnly.close();
    await proxy.close();
    await plain.close();
    await secure.close();
  }
});

test("proxy: 'env' reads HTTP_PROXY/HTTPS_PROXY/NO_PROXY once; omitted ignores them", async () => {
  const target = await fixture();
  const proxy = await httpProxy();
  const saved = { ...process.env };
  try {
    // Clear first: on Windows environment names are case-insensitive, so
    // deleting http_proxy after setting HTTP_PROXY would remove it again.
    delete process.env.http_proxy;
    delete process.env.no_proxy;
    delete process.env.NO_PROXY;
    process.env.HTTP_PROXY = new URL(proxy.url).host; // bare host:port
    const implicit = createClient();
    const fromEnv = createClient({ proxy: 'env' });
    process.env.NO_PROXY = '*';
    const bypassed = createClient({ proxy: 'env' });
    try {
      await (await implicit.get(`${target.url}/echo`)).dispose();
      assert.equal(proxy.seen.forwarded.length, 0);
      await (await fromEnv.get(`${target.url}/echo`)).dispose();
      assert.equal(proxy.seen.forwarded.length, 1);
      await (await bypassed.get(`${target.url}/echo`)).dispose();
      assert.equal(proxy.seen.forwarded.length, 1);
    } finally {
      await implicit.close();
      await fromEnv.close();
      await bypassed.close();
    }
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    await proxy.close();
    await target.close();
  }
});

test('an unreachable proxy fails the request without leaking the operation', async () => {
  const closed = net.createServer();
  closed.listen(0, '127.0.0.1');
  await once(closed, 'listening');
  const port = closed.address().port;
  closed.close();
  await once(closed, 'close');
  const client = createClient({ proxy: `http://127.0.0.1:${port}` });
  try {
    await assert.rejects(client.get('http://127.0.0.1:9/never'), (e) =>
      ['ERR_PROXY', 'ERR_CONNECT'].includes(e.code),
    );
    assert.equal(client.getStats().activeOperations, 0);
  } finally {
    await client.close();
  }
});

test('invalid proxy options fail at construction', () => {
  for (const proxy of [
    'ftp://proxy:21',
    'http://',
    'http://proxy:8080/path',
    'http://proxy:8080?x=1',
    { url: 'http://proxy:1', extra: true },
    { url: 'http://proxy:1', noProxy: ['a b'] },
    { http: 42 },
    true,
    'socks9://proxy:1',
  ])
    assert.throws(() => createClient({ proxy }), { code: 'ERR_INVALID_ARGUMENT' }, String(proxy));
  for (const proxy of [
    false,
    undefined,
    'proxy.local:3128',
    'https://proxy.local',
    'socks4a://proxy.local:1080',
    { noProxy: 'a,b' },
    { http: 'http://p:1', https: new URL('http://p:2'), noProxy: ['.internal', '10.0.0.0/8'] },
  ])
    createClient({ proxy });
});
