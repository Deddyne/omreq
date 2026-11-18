import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { fixture } from '../fixtures/server.mjs';
import { createClient } from '../packages/omreq/dist/index.mjs';

function block(milliseconds) {
  const until = performance.now() + milliseconds;
  while (performance.now() < until) {
    /* Model synchronous application work. */
  }
}

test('T01: close after native construction but before waiter resumption prevents late admission', async () => {
  const s = await fixture();
  try {
    for (let i = 0; i < 10; i++) {
      const c = createClient();
      const request = c.get(`${s.url}/echo`);
      let closing;
      queueMicrotask(function closeWhenConstructed() {
        if (c.getInfo().nativeReady) closing = c.close();
        else queueMicrotask(closeWhenConstructed);
      });
      await assert.rejects(request, { code: 'ERR_CLIENT_CLOSED' });
      await closing;
      assert.equal(c.getStats().activeOperations, 0);
      assert.equal(c.getStats().queuedOperations, 0);
      assert.equal(c.getStats().bufferedResponseBytes, 0);
    }
    assert.equal(s.stats.requests, 0);
  } finally {
    await s.close();
  }
});

test('T01/T16: lazy initialization admission is bounded before serialization', async () => {
  const s = await fixture();
  const c = createClient({ maxActiveOperations: 1, maxQueuedOperations: 1 });
  try {
    const a = c.post(`${s.url}/echo`, { body: 'first' });
    const b = c.post(`${s.url}/echo`, { body: 'second' });
    let serialized = 0;
    const overflow = c.post(`${s.url}/echo`, {
      json: {
        toJSON() {
          serialized++;
          return {};
        },
      },
    });
    assert.equal(c.getStats().initializingOperations, 2);
    assert.equal(c.getStats().queuedOperations, 2);
    assert.equal(c.getStats().retainedRequestBodyBytes, 11);
    await assert.rejects(overflow, { code: 'ERR_QUEUE_FULL' });
    assert.equal(serialized, 0);
    const first = await a;
    await first.bytes();
    await (await b).bytes();
    assert.equal(c.getStats().initializingOperations, 0);
    assert.equal(c.getStats().queuedOperations, 0);
    assert.equal(c.getStats().retainedRequestBodyBytes, 0);
    await assert.rejects(c.post(`${s.url}/echo`, { json: undefined }), {
      code: 'ERR_INVALID_ARGUMENT',
    });
    await (await c.get(`${s.url}/echo`)).bytes();
  } finally {
    await c.close();
    await s.close();
  }
});

test('T01/T16: admission preserves invocation order when native tasks race', async () => {
  const s = await fixture();
  const c = createClient({ maxActiveOperations: 1, maxQueuedOperations: 7 });
  try {
    for (let round = 0; round < 20; round++) {
      const requests = Array.from({ length: 8 }, (_, i) =>
        c.get(`${s.url}/echo?i=${i}`, { timeouts: { queueMs: 2000 } }),
      );
      // Deliberately retain each response until its turn. A later operation
      // admitted first would hold the only permit and deadlock this sequence.
      for (let i = 0; i < requests.length; i++) {
        const echo = await (await requests[i]).json();
        assert.equal(echo.url, `/echo?i=${i}`);
      }
    }
    assert.equal(c.getStats().activeOperations, 0);
    assert.equal(c.getStats().queuedOperations, 0);
  } finally {
    await c.close();
    await s.close();
  }
});

for (const timeoutKind of ['queueMs', 'totalMs'])
  test(`T01/T17: ${timeoutKind} includes lazy initialization without cancelling other waiters`, async () => {
    const s = await fixture();
    const c = createClient({ maxActiveOperations: 2, maxQueuedOperations: 0 });
    try {
      const expired = c.get(`${s.url}/expired`, { timeouts: { [timeoutKind]: 5 } });
      const accepted = c.get(`${s.url}/echo`);
      block(30);
      await assert.rejects(expired, { code: 'ERR_TIMEOUT', phase: 'queue' });
      const response = await accepted;
      assert.equal((await response.json()).url, '/echo');
      assert.equal(s.stats.requests, 1, 'Expired waiter must not open a transport operation');
      assert.equal(c.getInfo().nativeReady, true);
      assert.equal(c.getStats().initializingOperations, 0);
      assert.equal(c.getStats().activeOperations, 0);
    } finally {
      await c.close();
      await s.close();
    }
  });

test('T17: synchronous normalization consumes the invocation queue budget', async () => {
  const c = createClient();
  try {
    await assert.rejects(
      c.post('http://example.invalid', {
        json: {
          toJSON() {
            block(20);
            return { value: 1 };
          },
        },
        timeouts: { queueMs: 5 },
      }),
      { code: 'ERR_TIMEOUT', phase: 'queue' },
    );
    assert.equal(c.getInfo().nativeReady, false);
    assert.equal(c.getStats().retainedRequestBodyBytes, 0);
    assert.equal(c.getStats().queuedOperations, 0);
  } finally {
    await c.close();
  }
});

test('T17: total budget does not restart after serialization and native dispatch', async () => {
  const s = await fixture({
    route(req, res) {
      req.resume();
      const timer = setTimeout(() => res.end('late'), 80);
      res.on('close', () => clearTimeout(timer));
      return true;
    },
  });
  const c = createClient();
  try {
    await assert.rejects(
      c.post(s.url, {
        json: {
          toJSON() {
            block(80);
            return { value: 1 };
          },
        },
        timeouts: { totalMs: 130, headersMs: 1000 },
      }),
      { code: 'ERR_TIMEOUT' },
    );
    assert.equal(c.getStats().activeOperations, 0);
    assert.equal(c.getStats().retainedRequestBodyBytes, 0);
  } finally {
    await c.close();
    await s.close();
  }
});
