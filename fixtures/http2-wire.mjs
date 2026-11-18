import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import http2 from 'node:http2';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import { parseClientHello } from './clienthello.mjs';
export async function http2WireFixture({
  protocol = 'h2',
  closeResponses = false,
  captureTls = false,
  tlsVersion,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'omreq-wire-'));
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
  const ca = readFileSync(join(dir, 'cert.pem'), 'utf8'),
    key = readFileSync(join(dir, 'key.pem'));
  const publicPem = execFileSync('openssl', [
    'x509',
    '-in',
    join(dir, 'cert.pem'),
    '-pubkey',
    '-noout',
  ]);
  const spki = createHash('sha256')
    .update(createPublicKey(publicPem).export({ format: 'der', type: 'spki' }))
    .digest('base64');
  const connections = [],
    handshakes = [],
    requests = [],
    sockets = new Set(),
    sessions = new Set();
  let label = 'unknown';
  const plain = protocol === 'h2' ? http2.createServer() : http.createServer();
  plain.on('session', (session) => {
    sessions.add(session);
    session.on('error', () => {});
    session.on('close', () => sessions.delete(session));
  });
  plain.on('request', (req, res) => {
    const record = {
      path: req.url,
      headers: req.rawHeaders,
      connection:
        connections.findLast((c) => c.backendPort === req.socket.remotePort)?.index ?? null,
    };
    requests.push(record);
    res.setHeader('content-type', 'text/html');
    res.setHeader('cache-control', 'no-store');
    if (closeResponses) {
      if (protocol === 'h2') throw Error('closeResponses requires HTTP/1.1');
      res.setHeader('connection', 'close');
    }
    res.end(
      '<!doctype html><html><head><link rel="icon" href="data:,"></head><body>Omreq protocol fixture</body></html>',
    );
  });
  plain.listen(0, '127.0.0.1');
  await once(plain, 'listening');
  const secure = tls.createServer(
    {
      key,
      cert: ca,
      ALPNProtocols: [protocol === 'h2' ? 'h2' : 'http/1.1'],
      ...(tlsVersion
        ? {
            minVersion: tlsVersion,
            maxVersion: tlsVersion,
            // Node/OpenSSL and Bun/BoringSSL have different server defaults.
            // Resumption evidence must select the same cipher and binder hash.
            ciphers:
              tlsVersion === 'TLSv1.3' ? 'TLS_AES_128_GCM_SHA256' : 'ECDHE-RSA-AES128-GCM-SHA256',
          }
        : {}),
    },
    (socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
      const backend = net.connect(plain.address().port, '127.0.0.1');
      sockets.add(backend);
      backend.on('error', () => socket.destroy());
      backend.on('close', () => {
        sockets.delete(backend);
        socket.destroy();
      });
      socket.on('close', () => backend.destroy());
      const record = {
        index: connections.length,
        label,
        alpn: socket.alpnProtocol,
        tlsVersion: socket.getProtocol(),
        cipher: socket.getCipher().standardName,
        sessionReused: socket.isSessionReused(),
        handshake: captureTls
          ? handshakes.find((h) => h.backendPort === socket.remotePort)?.index
          : undefined,
        frames: [],
        raw: [],
        backendPort: null,
      };
      connections.push(record);
      backend.on('connect', () => (record.backendPort = backend.localPort));
      let buffered = Buffer.alloc(0),
        preface = false,
        total = 0;
      socket.on('data', (data) => {
        if (total < 65536) {
          record.raw.push(data.subarray(0, 65536 - total));
          total += data.length;
        }
        if (protocol !== 'h2') return;
        buffered = Buffer.concat([buffered, data]);
        if (!preface) {
          if (buffered.length < 24) return;
          if (buffered.subarray(0, 24).toString() !== 'PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n')
            throw Error('Invalid HTTP/2 preface');
          buffered = buffered.subarray(24);
          preface = true;
        }
        while (buffered.length >= 9) {
          const length = buffered.readUIntBE(0, 3);
          if (buffered.length < 9 + length) break;
          const type = buffered[3],
            flags = buffered[4],
            stream = buffered.readUInt32BE(5) & 0x7fffffff,
            payload = buffered.subarray(9, 9 + length);
          buffered = buffered.subarray(9 + length);
          const frame = { type, flags, stream, length };
          if (type === 4) {
            frame.settings = [];
            for (let i = 0; i < payload.length; i += 6)
              frame.settings.push({
                id: payload.readUInt16BE(i),
                value: payload.readUInt32BE(i + 2),
              });
          }
          if (type === 8) frame.increment = payload.readUInt32BE(0) & 0x7fffffff;
          if (type === 2 || (type === 1 && flags & 0x20)) {
            const i = type === 1 && flags & 8 ? 1 : 0;
            frame.priority = {
              exclusive: !!(payload[i] & 0x80),
              dependency: payload.readUInt32BE(i) & 0x7fffffff,
              weight: payload[i + 4] + 1,
            };
          }
          record.frames.push(frame);
        }
      });
      socket.pipe(backend);
      backend.pipe(socket);
    },
  );
  secure.on('tlsClientError', () => {});
  secure.listen(0, '127.0.0.1');
  await once(secure, 'listening');
  // Capture encrypted first flights before Node's TLS server consumes them.
  // Each record belongs to one TCP connection; bytes after ClientHello are not
  // retained, so response size and connection lifetime cannot grow the capture.
  const tap = captureTls
    ? net.createServer((socket) => {
        const backend = net.connect(secure.address().port, '127.0.0.1');
        for (const s of [socket, backend]) {
          sockets.add(s);
          s.on('error', () => {
            socket.destroy();
            backend.destroy();
          });
          s.on('close', () => sockets.delete(s));
        }
        socket.on('close', () => backend.destroy());
        backend.on('close', () => socket.destroy());
        const record = { index: handshakes.length, label, raw: [], backendPort: null };
        handshakes.push(record);
        backend.on('connect', () => (record.backendPort = backend.localPort));
        let bytes = Buffer.alloc(0);
        socket.on('data', (chunk) => {
          if (record.hello || record.error) return;
          bytes = Buffer.concat([bytes, chunk]);
          if (bytes.length > 65536) {
            record.error = 'ClientHello exceeds fixture capture limit';
            socket.destroy();
            return;
          }
          try {
            record.hello = parseClientHello(bytes);
            if (record.hello) {
              record.raw = bytes;
              bytes = Buffer.alloc(0);
            }
          } catch (error) {
            record.error = String(error);
            socket.destroy();
          }
        });
        socket.pipe(backend);
        backend.pipe(socket);
      })
    : undefined;
  if (tap) {
    tap.listen(0, '127.0.0.1');
    await once(tap, 'listening');
  }
  return {
    url: `https://localhost:${(tap ?? secure).address().port}`,
    ca,
    spki,
    connections,
    handshakes,
    requests,
    label(value) {
      label = value;
    },
    async close() {
      for (const session of sessions) session.destroy();
      for (const socket of sockets) socket.destroy();
      await Promise.all(
        [tap, secure, plain].filter(Boolean).map((server) => new Promise((r) => server.close(r))),
      );
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
