import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from '../fixtures/server.mjs';
import { createClient } from '../packages/omreq/dist/index.mjs';

test('resolve pins host names to addresses; Host, SNI and port come from the URL', async () => {
  const plain = await fixture();
  const secure = await fixture({ tls: true });
  const client = createClient({
    ca: secure.ca,
    resolve: { 'api.omreq.invalid': '127.0.0.1', localhost: ['::1', '127.0.0.1'] },
  });
  try {
    const port = new URL(plain.url).port;
    const body = await (await client.get(`http://api.omreq.invalid:${port}/echo`)).json();
    assert.equal(body.headers.host, `api.omreq.invalid:${port}`);
    // ::1 is not listening; the client falls back to the next pinned address.
    const tls = await client.get(`https://localhost:${new URL(secure.url).port}/echo`);
    assert.equal(tls.status, 200);
    await tls.dispose();
    await assert.rejects(client.get(`http://other.omreq.invalid:${port}/`), { code: 'ERR_DNS' });
  } finally {
    await client.close();
    await plain.close();
    await secure.close();
  }
});

test('invalid resolve maps fail at construction', () => {
  for (const resolve of [
    [],
    { 'a b': '127.0.0.1' },
    { host: [] },
    { host: 'not-an-ip' },
    { host: ['127.0.0.1', 42] },
    { host: Array(33).fill('127.0.0.1') },
  ])
    assert.throws(() => createClient({ resolve }), { code: 'ERR_INVALID_ARGUMENT' });
  createClient({ resolve: { 'H.Example': ['10.0.0.1', '[2001:db8::1]'] } }); // names are case-insensitive
});
