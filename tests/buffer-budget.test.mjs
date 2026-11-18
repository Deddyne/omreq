import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture } from '../fixtures/server.mjs';
import { createClient, getProfile, serializeProfile } from '../packages/omreq/dist/index.mjs';

const chunkBytes = 65536;
async function until(check) {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await delay(5);
  }
  assert.fail('Buffer credit state did not arrive before the fixture deadline');
}
function peer() {
  return fixture({
    route(req, res) {
      if (req.url === '/hold') {
        res.writeHead(200);
        res.write(Buffer.alloc(chunkBytes, 0x61));
        return true;
      }
      if (req.url === '/payload') {
        res.end(Buffer.alloc(chunkBytes + 1, 0x62));
        return true;
      }
      return false;
    },
  });
}
function tracked(promise) {
  void promise.catch(() => {});
  return promise;
}

test('T06: concurrent full reads share a hard aggregate budget and release only their own credits', async () => {
  const s = await peer();
  const c = createClient({ maxAggregateBufferedResponseBytes: 96 * 1024 });
  const controller = new AbortController();
  try {
    const first = await c.get(`${s.url}/hold`, { signal: controller.signal });
    const a = tracked(first.bytes());
    await until(() => c.getStats().bufferedResponseBytes === chunkBytes);
    const second = await c.get(`${s.url}/hold`);
    await assert.rejects(second.bytes(), { code: 'ERR_RESOURCE_LIMIT', phase: 'body' });
    assert.equal(second.bodyState, 'errored');
    assert.equal(c.getStats().bufferedResponseBytes, chunkBytes);
    assert.equal(c.getStats().bufferedResponseLimitBytes, 96 * 1024);
    assert.equal(c.getStats().activeOperations, 1);
    controller.abort('release buffered response');
    await assert.rejects(a, { code: 'ERR_ABORTED' });
    assert.equal(c.getStats().bufferedResponseBytes, 0);
    assert.equal(c.getStats().activeOperations, 0);
    await (await c.get(`${s.url}/empty`)).bytes();
  } finally {
    await c.close();
    await s.close();
  }
});

test('T06: bytes() collects a multi-chunk body in one budgeted allocation', async () => {
  const s = await peer();
  // The body is collected natively into one buffer, so it needs exactly its own
  // size from the aggregate budget (no second concatenation copy).
  const insufficient = createClient({ maxAggregateBufferedResponseBytes: chunkBytes });
  const sufficient = createClient({ maxAggregateBufferedResponseBytes: chunkBytes + 1 });
  try {
    const rejected = await insufficient.get(`${s.url}/payload`);
    await assert.rejects(rejected.bytes(), { code: 'ERR_RESOURCE_LIMIT' });
    assert.equal(rejected.bodyState, 'errored');
    assert.equal(insufficient.getStats().bufferedResponseBytes, 0);
    const bytes = await (await sufficient.get(`${s.url}/payload`)).bytes();
    assert.equal(bytes.length, chunkBytes + 1);
    assert(bytes.every((b) => b === 0x62));
    assert.equal(sufficient.getStats().bufferedResponseBytes, 0);
    await sufficient.close();
    assert.equal(bytes[0], 0x62, 'Delivered user bytes survive release/close');
    const empty = await (await insufficient.get(`${s.url}/empty`)).bytes();
    assert.equal(empty.length, 0);
  } finally {
    await Promise.all([insufficient.close(), sufficient.close(), s.close()]);
  }
});

test('T06: individual buffering limit still applies independently of aggregate capacity', async () => {
  const s = await peer();
  const c = createClient({
    maxBufferedResponseBytes: 1024,
    maxAggregateBufferedResponseBytes: 1048576,
  });
  try {
    for (const read of [(r) => r.bytes(), (r) => r.text(), (r) => r.json()]) {
      const r = await c.get(`${s.url}/payload`);
      await assert.rejects(read(r), { code: 'ERR_RESOURCE_LIMIT' });
      assert.equal(c.getStats().bufferedResponseBytes, 0);
      assert.equal(c.getStats().activeOperations, 0);
    }
    const stream = await c.get(`${s.url}/payload`);
    let size = 0;
    for await (const chunk of stream.body) size += chunk.length;
    assert.equal(size, chunkBytes + 1, 'Streaming does not accumulate a full-response buffer');
    assert.equal(c.getStats().bufferedResponseBytes, 0);
  } finally {
    await c.close();
    await s.close();
  }
});

for (const terminal of ['dispose', 'total-timeout', 'body-timeout', 'close'])
  test(`T06/T17: buffered credits are released on ${terminal}`, async () => {
    const s = await peer();
    const c = createClient({ maxAggregateBufferedResponseBytes: 2 * chunkBytes });
    try {
      const r = await c.get(`${s.url}/hold`, {
        timeouts: {
          totalMs: terminal === 'total-timeout' ? 100 : 2000,
          bodyIdleMs: terminal === 'body-timeout' ? 100 : 2000,
        },
      });
      const reading = tracked(r.bytes());
      await until(() => c.getStats().bufferedResponseBytes === chunkBytes);
      const expected =
        terminal === 'close'
          ? 'ERR_CLIENT_CLOSED'
          : terminal === 'dispose'
            ? 'ERR_BODY_DISPOSED'
            : 'ERR_TIMEOUT';
      const rejected = assert.rejects(reading, { code: expected });
      if (terminal === 'dispose') await r.dispose();
      if (terminal === 'close') await c.close();
      await rejected;
      assert.equal(c.getStats().bufferedResponseBytes, 0);
      assert.equal(c.getStats().activeOperations, 0);
    } finally {
      await c.close();
      await s.close();
    }
  });

test('T06/T23: separate clients have isolated budgets and close waits for collector cleanup', async () => {
  const s = await peer();
  const a = createClient({ maxAggregateBufferedResponseBytes: chunkBytes });
  const b = createClient({ maxAggregateBufferedResponseBytes: chunkBytes });
  try {
    const ra = await a.get(`${s.url}/hold`),
      rb = await b.get(`${s.url}/hold`);
    const pa = tracked(ra.bytes()),
      pb = tracked(rb.bytes());
    await until(
      () =>
        a.getStats().bufferedResponseBytes === chunkBytes &&
        b.getStats().bufferedResponseBytes === chunkBytes,
    );
    const rejectedA = assert.rejects(pa, { code: 'ERR_CLIENT_CLOSED' }),
      rejectedB = assert.rejects(pb, { code: 'ERR_CLIENT_CLOSED' });
    await a.close();
    assert.equal(a.getStats().bufferedResponseBytes, 0);
    assert.equal(b.getStats().bufferedResponseBytes, chunkBytes);
    await b.close();
    await Promise.all([rejectedA, rejectedB]);
    assert.equal(b.getStats().bufferedResponseBytes, 0);
  } finally {
    await Promise.all([a.close(), b.close(), s.close()]);
  }
});

test('T06/T21: native reservations validate inputs, fail without mutation and release idempotently', async () => {
  for (const value of [0, -1, 1.5, 2147483648, null, '100'])
    assert.throws(() => createClient({ maxAggregateBufferedResponseBytes: value }), {
      code: 'ERR_INVALID_ARGUMENT',
    });
  const require = createRequire(new URL('../packages/omreq/dist/index.js', import.meta.url));
  const { NativeClient } = require('omreq-darwin-arm64');
  const c = new NativeClient(
    serializeProfile(getProfile('omreq/custom-default')),
    JSON.stringify({
      maxActiveOperations: 1,
      maxQueuedOperations: 1,
      maxActivePerOrigin: 1,
      maxConnections: 64,
      maxConnectionsPerOrigin: 8,
      maxAggregateBufferedResponseBytes: 100,
      connectMs: 1000,
      ca: null,
      trustStore: 'bundled',
    }),
  );
  const lease = c.bufferBudget();
  try {
    for (const amount of [-1, 1.5, NaN, Infinity, 2147483648])
      assert.throws(() => lease.reserve(amount), /ERR_INVALID_ARGUMENT/);
    lease.reserve(60);
    assert.throws(() => lease.reserve(41), /ERR_RESOURCE_LIMIT/);
    assert.equal(JSON.parse(c.stats()).bufferedResponseBytes, 60);
    let closed = false;
    const closing = c.close().then(() => {
      closed = true;
    });
    await delay(10);
    assert.equal(
      closed,
      false,
      'Shutdown retains credits until the owning collector releases them',
    );
    lease.release();
    lease.release();
    await closing;
    assert.equal(JSON.parse(c.stats()).bufferedResponseBytes, 0);
    assert.throws(() => lease.reserve(1), /ERR_BODY_DISPOSED/);
    assert.throws(() => c.bufferBudget(), /ERR_CLIENT_CLOSED/);
  } finally {
    lease.release();
    await c.close();
  }
});
