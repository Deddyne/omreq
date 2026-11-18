import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture } from '../fixtures/server.mjs';
import { createClient, defineProfile, getProfile } from '../packages/omreq/dist/index.mjs';

async function withServer(fn, opts = {}) {
  const server = await fixture(opts);
  try {
    await fn(server);
  } finally {
    await server.close();
  }
}
async function zero(client) {
  for (let i = 0; i < 100; i++) {
    const s = client.getStats();
    if (s.nativeTasks === 0) {
      assert.equal(s.activeOperations, 0);
      assert.equal(s.queuedOperations, 0);
      assert.equal(s.openBodies, 0);
      assert.equal(s.uploadBridgeBytes, 0);
      assert.equal(s.downloadBridgeBytes, 0);
      assert.equal(s.retainedRequestBodyBytes, 0);
      return;
    }
    await delay(5);
  }
  assert.fail(JSON.stringify(client.getStats()));
}
const decoded = (result) => Buffer.from(result.body, 'base64');
test('T01/T04/T05: lazy parallel init, URL pairs, body snapshots, duplicate headers', async () =>
  withServer(async (s) => {
    const c = createClient({
      baseUrl: `${s.url}/v1/`,
      headers: { 'x-client': 'present', 'x-remove': 'remove' },
    });
    assert.equal(c.getInfo().nativeReady, false);
    try {
      const bytes = Uint8Array.from([9, 65, 66, 9]);
      const response = c.post('items?keep=a&x=old#fragment', {
        body: bytes.subarray(1, 3),
        headers: { 'x-remove': null, 'x-repeat': ['a', 'b'] },
        searchParams: [
          ['x', 'new'],
          ['x', 'again'],
        ],
      });
      bytes.fill(90);
      const responses = await Promise.all([
        response,
        ...Array.from({ length: 7 }, () => c.get('/echo')),
      ]);
      const first = await responses[0].json();
      assert.equal(first.url, '/v1/items?keep=a&x=new&x=again');
      assert.equal(decoded(first).toString(), 'AB');
      assert.equal(first.headers['x-remove'], undefined);
      assert.equal(first.headers['x-client'], 'present');
      assert.equal(first.rawHeaders.filter((n) => n.toLowerCase() === 'x-repeat').length, 2);
      await Promise.all(responses.slice(1).map((r) => r.bytes()));
      assert.equal(c.getInfo().nativeReady, true);
      await assert.rejects(c.get('/echo', { body: 'forbidden' }), { code: 'ERR_INVALID_ARGUMENT' });
      await assert.rejects(c.post('/echo', { json: undefined }), { code: 'ERR_INVALID_ARGUMENT' });
      await assert.rejects(c.post('/echo', { body: 'a', json: {} }), {
        code: 'ERR_INVALID_ARGUMENT',
      });
      await assert.rejects(c.get('/echo', { headers: { host: 'bad' } }), {
        code: 'ERR_INVALID_ARGUMENT',
      });
    } finally {
      await c.close();
    }
    await zero(c);
  }));
test('T02/T03/T14/T23: real HTTPS HTTP/2, certificate trust, headers, custom profile isolation', async () =>
  withServer(
    async (s) => {
      const profile = defineProfile({
        ...getProfile('omreq/custom-default'),
        id: 'local/h2',
        transport: {
          httpVersion: '2',
          tls: { alpn: ['h2'] },
          http2: { initialWindowSize: 1048576 },
        },
        headers: [['user-agent', 'OmreqLocalTest/1']],
      });
      const c = createClient({ ca: s.ca, profile });
      try {
        const r = await c.get(`${s.url}/repeat`);
        assert.equal(r.httpVersion, '2');
        assert.deepEqual(r.headers.getAll('set-cookie'), ['a=1; Path=/', 'b=2; Path=/']);
        assert.equal(r.headers.get('set-cookie'), 'a=1; Path=/');
        await r.dispose();
        const a = await c.get(`${s.url}/echo`);
        const result = await a.json();
        assert.equal(result.httpVersion, '2.0');
        assert.equal(result.headers['user-agent'], 'OmreqLocalTest/1');
        const conn = s.stats.connections;
        for (let i = 0; i < 3; i++) await (await c.get(`${s.url}/echo`)).bytes();
        assert.equal(s.stats.connections, conn);
        const untrusted = createClient();
        try {
          await assert.rejects(untrusted.get(`${s.url}/echo`), { code: 'ERR_TLS' });
        } finally {
          await untrusted.close();
        }
      } finally {
        await c.close();
      }
      await zero(c);
    },
    { tls: true, http2Only: true },
  ));
test('T06: demand driven upload and slow download retain bounded bridge buffers', async () =>
  withServer(async (s) => {
    const c = createClient();
    let produced = 0;
    try {
      async function* source() {
        for (let i = 0; i < 64; i++) {
          produced++;
          yield new Uint8Array(32768).fill(0x61);
        }
      }
      const r = await c.post(`${s.url}/count`, { body: source() });
      assert.equal((await r.json()).length, 2097152);
      assert.equal(produced, 64);
      const response = await c.get(`${s.url}/stream`);
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.length;
        const stats = c.getStats();
        assert(stats.downloadBridgeBytes <= 262144);
        assert(stats.uploadBridgeBytes <= 65536);
        assert(stats.nativeTasks <= 3);
        await delay(1);
      }
      assert.equal(bytes, 4194304);
    } finally {
      await c.close();
    }
    await zero(c);
  }));
test('T07: early response detaches a never-resolving upload producer and cleanup', async () =>
  withServer(async (s) => {
    const c = createClient();
    let calls = 0;
    const source = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            calls++;
            return new Promise(() => {});
          },
          return() {
            return new Promise(() => {});
          },
        };
      },
    };
    try {
      const r = await c.post(`${s.url}/early`, { body: source });
      assert.equal(r.status, 413);
      assert.equal(await r.text(), 'early');
      assert(calls <= 1);
    } finally {
      await c.close();
    }
    await zero(c);
  }));
test('T08/T16: queued abort, queue overflow, no eager upload and slot ownership', async () =>
  withServer(async (s) => {
    const c = createClient({ maxActiveOperations: 1, maxQueuedOperations: 1 });
    let reads = 0;
    const ctrl = new AbortController();
    try {
      const first = await c.get(`${s.url}/slow`);
      const queued = c.post(`${s.url}/count`, {
        signal: ctrl.signal,
        body: {
          async *[Symbol.asyncIterator]() {
            reads++;
            yield Buffer.from('x');
          },
        },
      });
      await delay(20);
      assert.equal(c.getStats().queuedOperations, 1);
      assert.equal(reads, 0);
      await assert.rejects(c.get(`${s.url}/echo`), { code: 'ERR_QUEUE_FULL' });
      ctrl.abort('queue reason');
      await assert.rejects(queued, { code: 'ERR_ABORTED' });
      assert.equal(reads, 0);
      await first.dispose();
      await (await c.get(`${s.url}/echo`)).bytes();
    } finally {
      await c.close();
    }
    await zero(c);
  }));
test('T08/T10: abort pending body, exclusive owner, WebStream cancel, iterator break', async () =>
  withServer(async (s) => {
    const c = createClient();
    try {
      const ctrl = new AbortController();
      const r = await c.get(`${s.url}/slow`, { signal: ctrl.signal });
      const reading = r.bytes();
      ctrl.abort('body reason');
      await assert.rejects(reading, (e) => e.code === 'ERR_ABORTED' && e.cause === 'body reason');
      const response = await c.get(`${s.url}/stream`);
      const iter = response.body[Symbol.asyncIterator]();
      await assert.rejects(response.bytes(), { code: 'ERR_BODY_USED' });
      const saved = await iter.next();
      await iter.return();
      assert.equal(saved.value[0], 0x61);
      await response.dispose();
      const web = await c.get(`${s.url}/infinite`);
      const reader = web.body.toWebStream().getReader();
      await reader.read();
      await reader.cancel();
      const br = await c.get(`${s.url}/infinite`);
      for await (const chunk of br.body) {
        assert(chunk.length);
        break;
      }
      assert.equal(br.bodyState, 'disposed');
    } finally {
      await c.close();
    }
    await zero(c);
  }));
test('T09: cancelling one HTTP/2 stream preserves its neighbour', async () =>
  withServer(
    async (s) => {
      const profile = defineProfile({
        ...getProfile('omreq/custom-default'),
        transport: { httpVersion: '2' },
      });
      const c = createClient({ ca: s.ca, profile });
      try {
        const a = await c.get(`${s.url}/slow`);
        const b = await c.get(`${s.url}/stream`);
        await a.dispose();
        assert.equal((await b.bytes()).length, 4194304);
        assert.equal(s.stats.connections, 1);
      } finally {
        await c.close();
      }
      await zero(c);
    },
    { tls: true, http2Only: true },
  ));
test('T15/T18: BOM, charset, empty and bad JSON, schema transform, status without retry', async () =>
  withServer(async (s) => {
    const c = createClient();
    try {
      assert.deepEqual(await (await c.get(`${s.url}/bom`)).json(), { value: 1 });
      assert.equal(await (await c.get(`${s.url}/charset`)).text(), 'Привет');
      await assert.rejects((await c.get(`${s.url}/empty`)).json(), { code: 'ERR_JSON_PARSE' });
      await assert.rejects((await c.get(`${s.url}/invalid-utf8`)).json(), { code: 'ERR_DECODE' });
      await assert.rejects((await c.get(`${s.url}/bad-json`)).json(), { code: 'ERR_JSON_PARSE' });
      const schema = {
        '~standard': {
          version: 1,
          vendor: 'test',
          async validate(v) {
            return { value: String(v.value) };
          },
        },
      };
      assert.equal(await (await c.get(`${s.url}/bom`)).json(schema), '1');
      const bad = {
        '~standard': {
          version: 1,
          vendor: 'test',
          validate() {
            return { issues: [{ message: 'no' }] };
          },
        },
      };
      await assert.rejects((await c.get(`${s.url}/bom`)).json(bad), {
        code: 'ERR_SCHEMA_VALIDATION',
      });
      const count = s.stats.requests;
      const response = await c.get(`${s.url}/status`);
      assert.equal(response.ok, false);
      assert.equal(await response.text(), 'unavailable');
      assert.equal(s.stats.requests - count, 1);
      const manual = await c.post(`${s.url}/redirect`, { json: { x: 1 }, redirect: 'manual' });
      assert.equal(manual.status, 307);
      await manual.dispose();
    } finally {
      await c.close();
    }
    await zero(c);
  }));
test('T17: body demand timeout, consumer timeout, total deadline and streaming size limit', async () =>
  withServer(async (s) => {
    const c = createClient();
    try {
      const a = await c.get(`${s.url}/slow`, { timeouts: { bodyIdleMs: 60 } });
      await assert.rejects(a.bytes(), { code: 'ERR_TIMEOUT' });
      const b = await c.get(`${s.url}/slow`, { timeouts: { consumerIdleMs: 60 } });
      await delay(120);
      await assert.rejects(b.bytes(), { code: 'ERR_TIMEOUT' });
      const d = c.get(`${s.url}/headers-wait`, { timeouts: { totalMs: 60 } });
      await assert.rejects(d, { code: 'ERR_TIMEOUT' });
      const e = await c.get(`${s.url}/stream`, { maxResponseBytes: 1024 });
      await assert.rejects(e.bytes(), { code: 'ERR_RESOURCE_LIMIT' });
      const f = await c.get(`${s.url}/stream`);
      await assert.rejects(f.bytes({ maxBytes: 1024 }), { code: 'ERR_RESOURCE_LIMIT' });
    } finally {
      await c.close();
    }
    await zero(c);
  }));
test('T01/T08: pre-aborted signal and close during init do not reach server', async () =>
  withServer(async (s) => {
    const c = createClient();
    const ctrl = new AbortController();
    ctrl.abort();
    await assert.rejects(c.get(s.url, { signal: ctrl.signal }), { code: 'ERR_ABORTED' });
    assert.equal(c.getInfo().nativeReady, false);
    assert.equal(s.stats.requests, 0);
    const request = c.get(s.url);
    const closing = c.close();
    assert.equal(c.close(), closing);
    await assert.rejects(request, { code: 'ERR_CLIENT_CLOSED' });
    await closing;
    assert.equal(s.stats.requests, 0);
    await assert.rejects(c.get(s.url), { code: 'ERR_CLIENT_CLOSED' });
    await zero(c);
  }));
test('T20: repeated request/cancel/close leaves own counters at zero', async () =>
  withServer(async (s) => {
    for (let i = 0; i < 25; i++) {
      const c = createClient();
      const r = await c.get(`${s.url}/echo`);
      await r.bytes();
      const b = await c.get(`${s.url}/slow`);
      await b.dispose();
      await c.close();
      await zero(c);
    }
  }));
test('T08: upload failure preserves the source cause and chunk budget errors', async () =>
  withServer(async (s) => {
    const c = createClient();
    const cause = new Error('private producer message');
    try {
      const source = {
        async *[Symbol.asyncIterator]() {
          yield Buffer.from('begin');
          throw cause;
        },
      };
      await assert.rejects(
        c.post(`${s.url}/count`, { body: source }),
        (e) =>
          e.code === 'ERR_UPLOAD_SOURCE' && e.cause === cause && !e.message.includes('private'),
      );
      const large = {
        async *[Symbol.asyncIterator]() {
          yield new Uint8Array(1048577);
        },
      };
      await assert.rejects(c.post(`${s.url}/count`, { body: large }), {
        code: 'ERR_RESOURCE_LIMIT',
      });
      const empty = {
        async *[Symbol.asyncIterator]() {
          while (true) yield new Uint8Array();
        },
      };
      await assert.rejects(c.post(`${s.url}/count`, { body: empty }), {
        code: 'ERR_UPLOAD_SOURCE',
      });
    } finally {
      await c.close();
    }
    await zero(c);
  }));
test('T23: profiles are immutable snapshots, independent clients and unchanged native bytes', async () =>
  withServer(async (s) => {
    const input = JSON.parse(JSON.stringify(getProfile('omreq/custom-default')));
    input.headers = [['user-agent', 'First/1']];
    const a = createClient({ profile: input });
    input.headers[0][1] = 'Second/2';
    const b = createClient({ profile: input });
    try {
      const ar = await (
        await a.get(`${s.url}/echo`, { timeouts: { bodyIdleMs: undefined } })
      ).json();
      const br = await (await b.get(`${s.url}/echo`)).json();
      assert.equal(ar.headers['user-agent'], 'First/1');
      assert.equal(br.headers['user-agent'], 'Second/2');
      assert.notEqual(a.getInfo().profileDigest, b.getInfo().profileDigest);
      assert.equal(s.stats.connections, 2);
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
    await zero(a);
    await zero(b);
  }));
test('T02: HTTP/1.0 responses with length or close framing are accepted', async () => {
  const { createServer } = await import('node:net');
  const bodies = ['HTTP/1.0 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\n\r\nOK'];
  bodies.push('HTTP/1.0 201 Created\r\nX-Framing: close\r\n\r\nuntil-close');
  let n = 0;
  const server = createServer((socket) => {
    socket.on('error', () => {});
    socket.once('data', () => socket.end(bodies[n++ % bodies.length]));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const client = createClient();
  try {
    const first = await client.get(url);
    assert.equal(first.httpVersion, '1.0');
    assert.equal(first.status, 200);
    assert.equal(await first.text(), 'OK');
    const second = await client.get(url);
    assert.equal(second.httpVersion, '1.0');
    assert.equal(second.status, 201);
    assert.equal(second.headers.get('x-framing'), 'close');
    assert.equal(await second.text(), 'until-close');
    await zero(client);
  } finally {
    await client.close();
    server.close();
  }
});
test('T02: searchParams keep the exact bytes of untouched query pairs', () =>
  withServer(async (s) => {
    const c = createClient();
    try {
      const signed = '/signed?sig=abc%2Fdef&f=a,b:c&q=a%20b&t=~x&a%62=1&x=old&x=old2';
      const echoed = async (path, searchParams) =>
        (await (await c.get(`${s.url}${path}`, { searchParams })).json()).url;
      assert.equal(
        await echoed(signed, [
          ['x', 'new'],
          ['ab', '2'],
          ['page', '2 3'],
        ]),
        '/signed?sig=abc%2Fdef&f=a,b:c&q=a%20b&t=~x&x=new&ab=2&page=2+3',
      );
      assert.equal(await echoed(signed, []), signed);
      assert.equal(await echoed('/plain', new URLSearchParams({ k: 'v' })), '/plain?k=v');
      await zero(c);
    } finally {
      await c.close();
    }
  }));
test('T02: Headers and Map header layers are sent; other objects are rejected', () =>
  withServer(async (s) => {
    const c = createClient({ headers: new Map([['x-client', ['a', 'b']]]) });
    try {
      const sent = new Headers({ authorization: 'Bearer t' });
      sent.append('x-multi', '1');
      sent.append('x-multi', '2');
      const echoed = await (await c.get(`${s.url}/echo`, { headers: sent })).json();
      assert.equal(echoed.headers.authorization, 'Bearer t');
      assert.equal(echoed.headers['x-multi'], '1, 2');
      assert.equal(echoed.headers['x-client'], 'a, b');
      const removed = await (
        await c.get(`${s.url}/echo`, { headers: new Map([['x-client', null]]) })
      ).json();
      assert.equal(removed.headers['x-client'], undefined);
      class Custom {
        authorization = 'lost';
      }
      await assert.rejects(c.get(`${s.url}/echo`, { headers: new Custom() }), {
        code: 'ERR_INVALID_ARGUMENT',
      });
      assert.throws(() => createClient({ headers: new Custom() }), {
        code: 'ERR_INVALID_ARGUMENT',
      });
      await zero(c);
    } finally {
      await c.close();
    }
  }));
