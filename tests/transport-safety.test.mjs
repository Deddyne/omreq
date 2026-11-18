import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http2 from 'node:http2';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fixture } from '../fixtures/server.mjs';
import { createClient } from '../packages/omreq/dist/index.mjs';

function certificate() {
  const dir = mkdtempSync(join(tmpdir(), 'omreq-safety-'));
  writeFileSync(
    join(dir, 'cert.cnf'),
    '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid:always\nkeyUsage=critical,digitalSignature,keyCertSign\nextendedKeyUsage=serverAuth\n',
  );
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-config',
      join(dir, 'cert.cnf'),
      '-keyout',
      join(dir, 'key.pem'),
      '-out',
      join(dir, 'cert.pem'),
    ],
    { stdio: 'ignore' },
  );
  const result = {
    key: readFileSync(join(dir, 'key.pem')),
    cert: readFileSync(join(dir, 'cert.pem'), 'utf8'),
  };
  rmSync(dir, { recursive: true, force: true });
  return result;
}

test('S-01: a hung first address does not hold the only connection slot from the fallback', async () => {
  const s = await fixture();
  const port = Number(new URL(s.url).port);
  // IPv6 loopback relay to the IPv4 fixture on the same port.
  const relay = net.createServer((socket) => {
    const upstream = net.connect(port, '127.0.0.1');
    socket.pipe(upstream).pipe(socket);
    socket.on('error', () => upstream.destroy());
    upstream.on('error', () => socket.destroy());
  });
  const listening = await new Promise((resolve) => {
    relay.once('error', () => resolve(false));
    relay.listen(port, '::1', () => resolve(true));
  });
  // 192.0.2.0/24 (TEST-NET-1) is never routed: the preferred attempt hangs,
  // and Happy Eyeballs starts the ::1 fallback after its delay.
  const client = createClient({
    maxConnections: 1,
    maxConnectionsPerOrigin: 1,
    connectMs: 8000,
    resolve: { 'pinned.omreq.invalid': ['192.0.2.1', '::1'] },
  });
  try {
    if (!listening) return; // ::1 unavailable on this host
    const started = performance.now();
    const response = await client.get(`http://pinned.omreq.invalid:${port}/echo`);
    assert.equal(response.status, 200);
    await response.dispose();
    assert(performance.now() - started < 4000, 'fallback did not queue behind the hung attempt');
    assert.equal(client.getStats().connections, 1);
  } finally {
    await client.close();
    relay.close();
    await s.close();
  }
});

test('S-02: an oversized HTTP/2 response header block is rejected', async () => {
  const { key, cert } = certificate();
  const server = http2.createSecureServer({ key, cert, maxSendHeaderBlockLength: 4 << 20 });
  server.on('stream', (stream, headers) => {
    stream.on('error', () => {});
    const size = headers[':path'] === '/huge' ? 300 * 1024 : 1024;
    stream.respond({ ':status': 200, 'x-big': 'a'.repeat(size) });
    stream.end('ok');
  });
  server.on('sessionError', () => {});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const client = createClient({ ca: cert, profile: 'neutral' });
  try {
    const url = `https://127.0.0.1:${server.address().port}`;
    const small = await client.get(`${url}/small`);
    assert.equal(small.httpVersion, '2');
    assert.equal(await small.text(), 'ok');
    await assert.rejects(client.get(`${url}/huge`), (e) =>
      ['ERR_HTTP_PROTOCOL', 'ERR_RESOURCE_LIMIT'].includes(e.code),
    );
    assert.equal(client.getStats().activeOperations, 0);
  } finally {
    await client.close();
    server.close();
  }
});

test('S-03: dropping an unclosed client with live work is collected without crashing', async () => {
  const s = await fixture();
  const script = `
    const { createClient } = await import(${JSON.stringify(new URL('../packages/omreq/dist/index.mjs', import.meta.url).href)});
    for (let i = 0; i < 20; i++) {
      const client = createClient();
      const response = await client.get(${JSON.stringify(`${s.url}/stream`)});
      void response; // neither read nor closed
    }
    for (let i = 0; i < 5; i++) { globalThis.gc(); await new Promise((r) => setTimeout(r, 20)); }
    console.log('survived');
    process.exit(0);
  `;
  // The fixture runs in this process, so the child must not block its event loop.
  const result = await promisify(execFile)(
    process.execPath,
    ['--expose-gc', '--input-type=module', '-e', script],
    { encoding: 'utf8', timeout: 30000 },
  ).finally(() => s.close());
  assert.match(result.stdout, /survived/);
});
