import assert from 'node:assert/strict';
import { once } from 'node:events';
import { constants } from 'node:http2';
import net from 'node:net';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture } from '../fixtures/server.mjs';
import { createClient, getProfile } from '../packages/omreq/dist/index.mjs';

async function until(check) {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await delay(5);
  }
  assert.fail('TCP state deadline');
}
function tracked(p) {
  void p.catch(() => {});
  return p;
}
async function zero(c) {
  await c.close();
  const s = c.getStats();
  for (const k of [
    'connections',
    'creatingConnections',
    'waitingConnections',
    'nativeTasks',
    'activeOperations',
    'queuedOperations',
  ])
    assert.equal(s[k], 0, k);
  assert.deepEqual(s.connectionOrigins, []);
}
test('T02/T16: live TCP count includes reused idle sockets and reaches zero only after close', async () => {
  const s = await fixture(),
    c = createClient();
  try {
    assert.equal(c.getStats().connections, 0);
    assert.deepEqual(c.getStats().connectionLimits, {
      maxConnections: 256,
      maxConnectionsPerOrigin: 32,
    });
    for (let i = 0; i < 3; i++) {
      await (await c.get(`${s.url}/echo`)).bytes();
      assert.equal(c.getStats().connections, 1);
    }
    assert.equal(s.stats.connections, 1);
    assert.equal(c.getStats().creatingConnections, 0);
    assert.deepEqual(c.getStats().connectionOrigins, [
      { origin: s.url, connections: 1, waitingConnections: 0 },
    ]);
    await zero(c);
    await until(() => s.stats.connections === s.stats.closed);
  } finally {
    await c.close();
    await s.close();
  }
});
test('T16: global TCP cap blocks another origin until the previous socket closes', async () => {
  const a = await fixture(),
    b = await fixture(),
    c = createClient({ maxConnections: 1, maxConnectionsPerOrigin: 1, connectMs: 1500 });
  try {
    const held = await c.get(`${a.url}/slow`);
    const next = tracked(c.get(`${b.url}/echo`));
    await until(() => c.getStats().waitingConnections === 1);
    assert.equal(c.getStats().connections, 1);
    assert.equal(b.stats.connections, 0);
    await held.dispose();
    assert.equal((await (await next).json()).url, '/echo');
    assert.equal(c.getStats().connections, 1);
    assert.equal(c.getStats().waitingConnections, 0);
    await zero(c);
  } finally {
    await c.close();
    await Promise.all([a.close(), b.close()]);
  }
});
test('T16: per-origin TCP cap leaves global capacity for another origin', async () => {
  const a = await fixture(),
    b = await fixture(),
    c = createClient({ maxConnections: 2, maxConnectionsPerOrigin: 1, connectMs: 1500 });
  try {
    const held = await c.get(`${a.url}/slow`),
      next = tracked(c.get(`${a.url}/echo`));
    await until(() => c.getStats().waitingConnections === 1);
    assert.equal((await (await c.get(`${b.url}/echo`)).json()).url, '/echo');
    assert.equal(c.getStats().connections, 2);
    assert(c.getStats().connectionOrigins.every((o) => o.connections <= 1));
    await held.dispose();
    await (await next).bytes();
    assert.equal(c.getStats().connections, 2);
    await zero(c);
  } finally {
    await c.close();
    await Promise.all([a.close(), b.close()]);
  }
});
for (const tls of [false, true])
  test(`T02/T16: parallel ${tls ? 'TLS ' : ''}HTTP1 requests reuse pooled sockets instead of reconnecting`, async () => {
    const s = await fixture({ tls }),
      c = createClient({
        ca: s.ca,
        maxConnectionsPerOrigin: 8,
        profile: { ...getProfile('omreq/custom-default'), transport: { httpVersion: '1.1' } },
      });
    try {
      // Eight workers keep every per-origin socket busy; between requests each
      // socket is briefly idle and must stay pooled for the next one.
      await Promise.all(
        Array.from({ length: 8 }, async () => {
          for (let i = 0; i < 25; i++) await (await c.get(`${s.url}/echo`)).bytes();
        }),
      );
      assert(s.stats.connections <= 8, `${s.stats.connections} sockets for 200 requests`);
      assert(c.getStats().connections <= 8);
      await zero(c);
    } finally {
      await c.close();
      await s.close();
    }
  });
test('T16: idle sockets of finished origins yield global TCP capacity LRU-first', async () => {
  const a = await fixture(),
    b = await fixture(),
    d = await fixture(),
    c = createClient({ maxConnections: 2, maxConnectionsPerOrigin: 1, connectMs: 3000 });
  try {
    await (await c.get(`${a.url}/echo`)).bytes();
    await (await c.get(`${b.url}/echo`)).bytes();
    assert.equal(c.getStats().connections, 2);
    const started = performance.now();
    assert.equal((await (await c.get(`${d.url}/echo`)).json()).url, '/echo');
    assert(performance.now() - started < 1500, 'waited for the idle timeout');
    await until(() => a.stats.closed === 1);
    assert.equal(b.stats.closed, 0, 'the more recently used idle socket survives');
    assert.equal(c.getStats().connections, 2);
    await zero(c);
  } finally {
    await c.close();
    await Promise.all([a.close(), b.close(), d.close()]);
  }
});
for (const mode of ['timeout', 'abort', 'close'])
  test(`T08/T16/T17: ${mode} unlinks TCP-cap waiters without creating a socket`, async () => {
    const a = await fixture(),
      b = await fixture(),
      c = createClient({
        maxConnections: 1,
        maxConnectionsPerOrigin: 1,
        connectMs: mode === 'timeout' ? 100 : 1500,
      });
    try {
      const held = await c.get(`${a.url}/slow`),
        controller = new AbortController();
      let pulls = 0;
      const body = {
        async *[Symbol.asyncIterator]() {
          pulls++;
          yield Buffer.from('data');
        },
      };
      const pending = tracked(c.post(`${b.url}/echo`, { body, signal: controller.signal }));
      await until(() => c.getStats().waitingConnections === 1);
      assert.equal(pulls, 0);
      const rejected = assert.rejects(pending, {
        code:
          mode === 'timeout'
            ? 'ERR_TIMEOUT'
            : mode === 'abort'
              ? 'ERR_ABORTED'
              : 'ERR_CLIENT_CLOSED',
        ...(mode === 'timeout' ? { phase: 'connect' } : {}),
      });
      if (mode === 'abort') controller.abort();
      if (mode === 'close') await c.close();
      await rejected;
      assert.equal(b.stats.connections, 0);
      assert.equal(c.getStats().waitingConnections, 0);
      if (mode !== 'close') {
        assert.equal(c.getStats().connections, 1);
        await held.dispose();
      }
      await zero(c);
    } finally {
      await c.close();
      await Promise.all([a.close(), b.close()]);
    }
  });
test('T08/T14: close interrupts a stalled TLS handshake and waits for socket drop', async () => {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', () => {});
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const c = createClient({ connectMs: 2000 });
  try {
    const pending = tracked(c.get(`https://127.0.0.1:${server.address().port}/`));
    await until(() => sockets.size === 1 && c.getStats().creatingConnections === 0);
    assert.equal(c.getStats().connections, 1);
    const rejected = assert.rejects(pending, { code: 'ERR_CLIENT_CLOSED' });
    await zero(c);
    await rejected;
    await until(() => sockets.size === 0);
  } finally {
    await c.close();
    for (const s of sockets) s.destroy();
    await new Promise((r) => server.close(r));
  }
});
test('T02/T09: many HTTP2 streams share one counted TCP socket without orphaned dial waiters', async () => {
  const s = await fixture({ tls: true }),
    c = createClient({ ca: s.ca, maxConnections: 1, maxConnectionsPerOrigin: 1, connectMs: 1500 });
  try {
    const rs = await Promise.all(Array.from({ length: 16 }, () => c.get(`${s.url}/echo`)));
    assert(rs.every((r) => r.httpVersion === '2'));
    assert.equal(s.stats.connections, 1);
    await until(() => c.getStats().waitingConnections === 0);
    assert.equal(c.getStats().connections, 1);
    await Promise.all(rs.map((r) => r.bytes()));
    await zero(c);
  } finally {
    await c.close();
    await s.close();
  }
});
test('T08: failed TCP connects release every reservation and origin record', async () => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  // Windows retries a refused loopback SYN for about two seconds, so there the
  // short connect deadline fires first; either way the slot must be released.
  const c = createClient({ connectMs: 500 });
  const codes = process.platform === 'win32' ? ['ERR_CONNECT', 'ERR_TIMEOUT'] : ['ERR_CONNECT'];
  try {
    for (let i = 0; i < 10; i++) {
      await assert.rejects(c.get(`http://127.0.0.1:${port}`), (e) => codes.includes(e.code));
      assert.equal(c.getStats().connections, 0);
      assert.deepEqual(c.getStats().connectionOrigins, []);
    }
  } finally {
    await zero(c);
  }
});
test('T16: invalid TCP limits fail before native initialization', () => {
  for (const key of ['maxConnections', 'maxConnectionsPerOrigin'])
    for (const value of [0, -1, 1.5, 5000, null, '1'])
      assert.throws(() => createClient({ [key]: value }), { code: 'ERR_INVALID_ARGUMENT' });
});
test('T13: HTTP2 REFUSED_STREAM does not replay a materialized request', async () => {
  let refused = 0;
  const s = await fixture({
    tls: true,
    route(req) {
      if (req.url !== '/refuse') return false;
      refused++;
      req.stream.on('error', () => {});
      req.stream.close(constants.NGHTTP2_REFUSED_STREAM);
      return true;
    },
  });
  const c = createClient({ ca: s.ca, timeouts: { totalMs: 1000 } });
  try {
    await (await c.get(`${s.url}/echo`)).bytes();
    await assert.rejects(c.post(`${s.url}/refuse`, { body: 'must not replay' }), {
      code: 'ERR_HTTP_PROTOCOL',
      phase: 'headers',
    });
    await delay(30);
    assert.equal(refused, 1);
    assert.equal(s.stats.requests, 2);
    await (await c.get(`${s.url}/echo`)).bytes();
    assert.equal(s.stats.requests, 3);
    await zero(c);
  } finally {
    await c.close();
    await s.close();
  }
});
