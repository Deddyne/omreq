// Bench server mirroring wreq-js routes (/small, /binary?len=, /echo-len?len=), plain HTTP1 + TLS (h2+h1 ALPN).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import http2 from 'node:http2';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'cmp-bench-'));
writeFileSync(
  join(dir, 'cert.cnf'),
  '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyCertSign\nextendedKeyUsage=serverAuth\n',
);
execFileSync(
  'openssl',
  [
    'req',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:prime256v1',
    '-pkeyopt',
    'ec_param_enc:named_curve',
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
const cert = readFileSync(join(dir, 'cert.pem'), 'utf8');
const key = readFileSync(join(dir, 'key.pem'), 'utf8');
const SMALL = Buffer.from('OK');
const BIN = Buffer.alloc(1048576, 0x62);
let connections = 0;

function handler(req, res) {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'GET' && u.pathname === '/small') {
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'content-length': SMALL.length,
    });
    return res.end(SMALL);
  }
  if (req.method === 'GET' && u.pathname === '/binary') {
    const len = Number(u.searchParams.get('len') ?? 4096);
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': len });
    return res.end(BIN.subarray(0, len));
  }
  if (req.method === 'POST' && u.pathname === '/echo-len') {
    const want = Number(u.searchParams.get('len'));
    let got = 0;
    req.on('data', (c) => (got += c.length));
    req.on('end', () => {
      res.writeHead(got === want ? 204 : 400);
      res.end();
    });
    return;
  }
  if (u.pathname === '/stats') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ connections }));
  }
  res.writeHead(404);
  res.end();
}
const plain = http.createServer({ keepAlive: true, keepAliveTimeout: 60000 }, handler);
plain.keepAliveTimeout = 60000;
plain.on('connection', () => connections++);
const secure = http2.createSecureServer(
  { cert, key, allowHTTP1: true, settings: { maxConcurrentStreams: 1000 } },
  handler,
);
secure.on('secureConnection', () => connections++);
await new Promise((r) => plain.listen(0, '127.0.0.1', r));
await new Promise((r) => secure.listen(0, '127.0.0.1', r));
process.stdout.write(
  `${JSON.stringify({ plain: `http://127.0.0.1:${plain.address().port}`, tls: `https://127.0.0.1:${secure.address().port}`, ca: cert })}\n`,
);
