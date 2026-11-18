// Installed-package smoke test: ESM and CJS share one loader, a TLS HTTP/2
// request through the default Chrome profile succeeds, and the client closes.
import { createRequire } from 'node:module';
import { fixture } from '../fixtures/server.mjs';

const server = await fixture({ tls: true });
try {
  const esm = await import('../packages/omreq/dist/index.mjs');
  const cjs = createRequire(import.meta.url)('../packages/omreq/dist/index.js');
  if (esm.createClient !== cjs.createClient) throw Error('ESM and CJS loaded different copies');
  const client = esm.createClient({ ca: server.ca });
  const response = await client.get(`${server.url}/echo`);
  const body = await response.json();
  if (response.status !== 200 || body.method !== 'GET') throw Error('Request failed');
  if (!/Chrome\//.test(body.headers['user-agent'])) throw Error('Chrome profile not applied');
  await client.close();
  console.log(JSON.stringify({ ...esm.getRuntimeInfo(), httpVersion: response.httpVersion }));
} finally {
  await server.close();
}
