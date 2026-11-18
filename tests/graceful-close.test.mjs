import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture } from '../fixtures/server.mjs';
import { createClient } from '../packages/omreq/dist/index.mjs';

test('graceful close lets admitted requests and bodies finish and refuses new ones', async () => {
  const s = await fixture();
  const client = createClient();
  try {
    const response = await client.get(`${s.url}/stream`);
    const queued = client.get(`${s.url}/echo`);
    const closing = client.close({ graceful: true });
    await assert.rejects(client.get(`${s.url}/echo`), { code: 'ERR_CLIENT_CLOSED' });
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await delay(20);
    assert.equal(closed, false, 'close waits for the open body');
    assert.equal((await response.bytes()).byteLength, 128 * 32768);
    assert.equal((await (await queued).json()).method, 'GET');
    await closing;
    assert.equal(client.getInfo().state, 'closed');
    assert.equal(client.getStats().activeOperations, 0);
  } finally {
    await client.close();
    await s.close();
  }
});

test('graceful close cancels what is left after timeoutMs', async () => {
  const s = await fixture();
  const client = createClient();
  try {
    const response = await client.get(`${s.url}/slow`); // headers, then no body
    const started = performance.now();
    await client.close({ graceful: true, timeoutMs: 100 });
    assert(performance.now() - started >= 90, 'waited for the drain timeout');
    await assert.rejects(response.text(), { code: 'ERR_CLIENT_CLOSED' });
    assert.equal(client.getStats().activeOperations, 0);
  } finally {
    await s.close();
  }
});

test('close without options cancels immediately; options are validated', async () => {
  const s = await fixture();
  const client = createClient();
  const response = await client.get(`${s.url}/slow`);
  await assert.rejects(createClient().close({ graceful: 1 }), { code: 'ERR_INVALID_ARGUMENT' });
  await assert.rejects(createClient().close({ timeoutMs: -1 }), { code: 'ERR_INVALID_ARGUMENT' });
  await assert.rejects(createClient().close({ other: true }), { code: 'ERR_INVALID_ARGUMENT' });
  const started = performance.now();
  await client.close();
  assert(performance.now() - started < 1000);
  await assert.rejects(response.text());
  await s.close();
});
