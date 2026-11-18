import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture } from '../fixtures/server.mjs';
import { createClient, getProfile, serializeProfile } from '../packages/omreq/dist/index.mjs';

async function until(check) {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await delay(5);
  }
  assert.fail('Admission state did not arrive before the fixture deadline');
}
function tracked(promise) {
  // Queue assertions intentionally retain earlier bodies; a failed assertion
  // must still allow close() to reject the other requests without unhandled rejections.
  void promise.catch(() => {});
  return promise;
}
async function zero(c) {
  await until(() => c.getStats().nativeTasks === 0);
  const stats = c.getStats();
  assert.equal(stats.activeOperations, 0);
  assert.equal(stats.queuedOperations, 0);
  assert.equal(stats.originWaitOperations, 0);
  assert.deepEqual(stats.origins, []);
}

for (const tls of [false, true])
  test(`T16: a full origin leaves free global slots and queued uploads unread over ${tls ? 'H2' : 'H1'}`, async () => {
    const a = await fixture({ tls }),
      b = await fixture({ tls });
    const c = createClient({
      ca: tls ? a.ca + b.ca : undefined,
      maxActiveOperations: 2,
      maxActivePerOrigin: 1,
      maxQueuedOperations: 4,
      timeouts: { totalMs: 2500 },
    });
    try {
      const first = await c.get(`${a.url}/slow`);
      let pulls = 0;
      const source = {
        async *[Symbol.asyncIterator]() {
          pulls++;
          yield Buffer.from('source');
        },
      };
      const second = tracked(c.post(`${a.url}/echo`, { body: source }));
      await until(() => c.getStats().queuedOperations === 1);
      const other = await c.get(`${b.url}/echo`);
      assert.equal(other.httpVersion, tls ? '2' : '1.1');
      assert.equal((await other.json()).url, '/echo');
      assert.equal(pulls, 0);
      assert.equal(c.getStats().activeOperations, 1);
      assert.equal(c.getStats().queuedOperations, 1);
      assert.deepEqual(c.getStats().origins, [
        { origin: a.url, activeOperations: 1, waitingOperations: 1 },
      ]);
      await first.dispose();
      const echo = await (await second).json();
      assert.equal(Buffer.from(echo.body, 'base64').toString(), 'source');
      assert.equal(pulls, 1);
      await zero(c);
    } finally {
      await c.close();
      await Promise.all([a.close(), b.close()]);
    }
  });

test('T16: ready origins alternate while each origin preserves request FIFO', async () => {
  const blocker = await fixture(),
    a = await fixture(),
    b = await fixture();
  const c = createClient({
    maxActiveOperations: 1,
    maxActivePerOrigin: 1,
    maxQueuedOperations: 8,
    timeouts: { totalMs: 2500 },
  });
  try {
    const held = await c.get(`${blocker.url}/slow`);
    const requests = new Map(),
      received = [];
    for (const [origin, ids] of [
      [a, ['a1', 'a2', 'a3']],
      [b, ['b1', 'b2']],
    ])
      for (const id of ids)
        requests.set(
          id,
          tracked(
            c.get(`${origin.url}/echo?id=${id}`).then((r) => {
              received.push(id);
              return r;
            }),
          ),
        );
    await until(() => c.getStats().queuedOperations === 5);
    await held.dispose();
    const order = ['a1', 'b1', 'a2', 'b2', 'a3'];
    for (let i = 0; i < order.length; i++) {
      const response = await requests.get(order[i]);
      assert.deepEqual(received, order.slice(0, i + 1));
      assert.equal((await response.json()).url, `/echo?id=${order[i]}`);
    }
    await zero(c);
  } finally {
    await c.close();
    await Promise.all([blocker.close(), a.close(), b.close()]);
  }
});

for (const maxQueuedOperations of [0, 1])
  test(`T16: queue cap ${maxQueuedOperations} applies when origin cap blocks otherwise free slots`, async () => {
    const a = await fixture(),
      b = await fixture();
    const c = createClient({
      maxActiveOperations: 4,
      maxActivePerOrigin: 1,
      maxQueuedOperations,
      timeouts: { totalMs: 1500 },
    });
    try {
      const held = await c.get(`${a.url}/slow`);
      const controller = new AbortController();
      const queued = maxQueuedOperations
        ? tracked(c.get(`${a.url}/echo`, { signal: controller.signal }))
        : undefined;
      await until(() => c.getStats().queuedOperations === maxQueuedOperations);
      await assert.rejects(c.get(`${a.url}/overflow`), { code: 'ERR_QUEUE_FULL', phase: 'queue' });
      assert.equal((await (await c.get(`${b.url}/echo`)).json()).url, '/echo');
      if (queued) {
        controller.abort();
        await assert.rejects(queued, { code: 'ERR_ABORTED' });
      }
      assert.equal(a.stats.requests, 1, 'No origin-blocked request reaches the server');
      await held.dispose();
      await zero(c);
    } finally {
      await c.close();
      await Promise.all([a.close(), b.close()]);
    }
  });

test('T16: default origin cap is thirty-two and another origin can use remaining global capacity', async () => {
  const a = await fixture({ tls: true }),
    b = await fixture({ tls: true });
  // HTTP2 isolates the application cap from the separate default cap of
  // thirty-two physical TCP sockets per origin.
  const c = createClient({ ca: a.ca + b.ca, timeouts: { totalMs: 2500 } });
  try {
    assert.equal(c.getStats().admissionLimits.maxActivePerOrigin, 32);
    const requests = Array.from({ length: 33 }, (_, i) => tracked(c.get(`${a.url}/echo?i=${i}`)));
    const first = await Promise.all(requests.slice(0, 32));
    await until(() => c.getStats().queuedOperations === 1);
    assert.equal(c.getStats().activeOperations, 32);
    await (await c.get(`${b.url}/echo`)).bytes();
    assert.equal(c.getStats().activeOperations, 32);
    await first[0].dispose();
    const last = await requests[32];
    await Promise.all([...first.slice(1), last].map((r) => r.bytes()));
    await zero(c);
  } finally {
    await c.close();
    await Promise.all([a.close(), b.close()]);
  }
});

test('T11/T16: crossing redirects release origin permits before acquiring destinations', async () => {
  const held = [];
  const route = (req, res) => {
    if (req.url !== '/cross') return false;
    req.resume();
    held.push(res);
    return true;
  };
  const a = await fixture({ route }),
    b = await fixture({ route });
  const c = createClient({
    maxActiveOperations: 2,
    maxActivePerOrigin: 1,
    maxQueuedOperations: 2,
    timeouts: { totalMs: 2000 },
  });
  try {
    const reachedA = a.wait('/cross'),
      reachedB = b.wait('/cross');
    const first = tracked(c.get(`${a.url}/cross`)),
      second = tracked(c.get(`${b.url}/cross`));
    await Promise.all([reachedA, reachedB]);
    const fresh = tracked(c.get(`${a.url}/fresh`));
    await until(() => c.getStats().queuedOperations === 1);
    // Arrival order need not be A,B; each server's response socket records its origin port.
    for (const res of held) {
      const destination = res.socket.localPort === Number(new URL(a.url).port) ? b : a;
      res.writeHead(302, { location: `${destination.url}/stream` });
      res.end();
    }
    const responses = await Promise.all([first, second]);
    assert.equal(responses[0].url, `${b.url}/stream`);
    assert.equal(responses[1].url, `${a.url}/stream`);
    assert.equal(c.getStats().activeOperations, 2);
    assert.equal(c.getStats().queuedOperations, 1);
    assert.equal(c.getStats().originWaitOperations, 0);
    for (const r of responses) assert.equal(r.redirects.length, 1);
    await Promise.all(responses.map((r) => r.bytes()));
    assert.equal((await (await fresh).json()).url, '/fresh');
    await zero(c);
  } finally {
    await c.close();
    await Promise.all([a.close(), b.close()]);
  }
});

test('T11/T16: one-slot redirect cannot deadlock behind a fresh destination request', async () => {
  let release;
  const b = await fixture();
  const a = await fixture({
    route(req, res) {
      if (req.url !== '/redirect') return false;
      req.resume();
      release = () => {
        res.writeHead(302, { location: `${b.url}/stream` });
        res.end();
      };
      return true;
    },
  });
  const c = createClient({
    maxActiveOperations: 1,
    maxActivePerOrigin: 1,
    maxQueuedOperations: 1,
    timeouts: { totalMs: 1500 },
  });
  try {
    const reached = a.wait('/redirect');
    const chain = tracked(c.get(`${a.url}/redirect`));
    await reached;
    const fresh = tracked(c.get(`${b.url}/fresh`));
    await until(() => c.getStats().queuedOperations === 1);
    release();
    const response = await chain;
    assert.equal(response.url, `${b.url}/stream`);
    assert.equal(b.stats.requests, 1);
    assert.equal(c.getStats().activeOperations, 1);
    assert.equal(c.getStats().queuedOperations, 1);
    await response.bytes();
    assert.equal((await (await fresh).json()).url, '/fresh');
    await zero(c);
  } finally {
    await c.close();
    await Promise.all([a.close(), b.close()]);
  }
});

for (const terminal of ['abort', 'queue-timeout', 'total-timeout', 'close'])
  test(`T08/T16/T17: redirect origin wait releases its old permit and cleans up on ${terminal}`, async () => {
    const b = await fixture();
    const a = await fixture({
      route(req, res) {
        if (req.url !== '/redirect') return false;
        req.resume();
        res.writeHead(302, { location: `${b.url}/echo` });
        res.end();
        return true;
      },
    });
    const c = createClient({
      maxActiveOperations: 3,
      maxActivePerOrigin: 1,
      timeouts: { totalMs: 2000 },
    });
    try {
      const held = await c.get(`${b.url}/slow`);
      const controller = new AbortController();
      const chain = tracked(
        c.get(`${a.url}/redirect`, {
          signal: controller.signal,
          timeouts: {
            queueMs: terminal === 'queue-timeout' ? 100 : 1000,
            totalMs: terminal === 'total-timeout' ? 100 : 2000,
          },
        }),
      );
      await until(() => c.getStats().originWaitOperations === 1);
      // This would block if the old origin were retained while waiting for B.
      assert.equal((await (await c.get(`${a.url}/echo`)).json()).url, '/echo');
      assert.equal(c.getStats().activeOperations, 2);
      assert.equal(c.getStats().queuedOperations, 0);
      const expected =
        terminal === 'abort'
          ? 'ERR_ABORTED'
          : terminal === 'close'
            ? 'ERR_CLIENT_CLOSED'
            : 'ERR_TIMEOUT';
      const rejected = assert.rejects(chain, {
        code: expected,
        ...(terminal === 'queue-timeout' ? { phase: 'queue' } : {}),
      });
      if (terminal === 'abort') controller.abort('origin wait');
      if (terminal === 'close') await c.close();
      await rejected;
      assert.equal(c.getStats().originWaitOperations, 0);
      if (terminal !== 'close') {
        assert.equal(c.getStats().activeOperations, 1);
        assert.deepEqual(c.getStats().origins, [
          { origin: b.url, activeOperations: 1, waitingOperations: 0 },
        ]);
        await held.dispose();
      }
      await zero(c);
    } finally {
      await c.close();
      await Promise.all([a.close(), b.close()]);
    }
  });

test('T16: invalid limits and native origin substitution fail before transport work', async () => {
  for (const value of [0, -1, 1.5, 1025, '1', null])
    assert.throws(() => createClient({ maxActivePerOrigin: value }), {
      code: 'ERR_INVALID_ARGUMENT',
    });
  const require = createRequire(new URL('../packages/omreq/dist/index.js', import.meta.url));
  const { NativeClient } = require('omreq-darwin-arm64');
  const profile = serializeProfile(getProfile('omreq/custom-default'));
  const config = {
    maxActiveOperations: 1,
    maxActivePerOrigin: 1,
    maxQueuedOperations: 1,
    connectMs: 1000,
    maxConnections: 64,
    maxConnectionsPerOrigin: 8,
    maxAggregateBufferedResponseBytes: 134217728,
    ca: null,
    trustStore: 'bundled',
  };
  const c = new NativeClient(profile, JSON.stringify(config));
  try {
    assert.throws(() => c.request(1, 'https://user:password@example.invalid', '{}'));
    assert.equal(JSON.parse(c.stats()).activeOperations, 0);
    await assert.rejects(
      c.request(
        2,
        'http://127.0.0.1:1',
        JSON.stringify({
          url: 'http://127.0.0.1:2',
          method: 'GET',
          headers: [],
          streaming: false,
          queueMs: 1000,
          hopQueueMs: 1000,
          headersMs: 1000,
          uploadIdleMs: 1000,
          bodyIdleMs: 1000,
          consumerIdleMs: null,
          totalMs: null,
          maxResponseBytes: null,
        }),
      ),
      /ERR_INVALID_ARGUMENT/,
    );
    assert.deepEqual(JSON.parse(c.stats()).origins, []);
  } finally {
    await c.close();
  }
});
