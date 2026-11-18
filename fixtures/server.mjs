import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import http2 from 'node:http2';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export async function fixture({ tls = false, http2Only = false, route } = {}) {
  let dir;
  let ca;
  if (tls) {
    dir = mkdtempSync(join(tmpdir(), 'omreq-fixture-'));
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
    ca = readFileSync(join(dir, 'cert.pem'), 'utf8');
  }
  const sockets = new Set();
  const sessions = new Set();
  const events = new Map();
  const stats = {
    requests: 0,
    connections: 0,
    closed: 0,
    uploadBytes: 0,
    downloadBytes: 0,
    protocols: [],
  };
  const emit = (path) => {
    for (const resolve of events.get(path) ?? []) resolve();
    events.delete(path);
  };
  const handler = (req, res) => {
    stats.requests++;
    stats.protocols.push(req.httpVersion);
    emit(req.url);
    req.on('error', () => {});
    res.on('error', () => {});
    if (route?.(req, res)) return;
    if (req.url === '/early') {
      res.writeHead(413, { 'content-type': 'text/plain' });
      res.end('early');
      return;
    }
    if (req.url === '/headers-wait') return;
    if (req.url === '/slow') {
      res.writeHead(200);
      res.flushHeaders();
      return;
    }
    if (req.url === '/stream' || req.url === '/large') {
      res.writeHead(200);
      let n = 0;
      const bytes = Buffer.alloc(32768, 0x61);
      const write = () => {
        while (!res.destroyed && n < (req.url === '/large' ? 32768 : 128)) {
          n++;
          stats.downloadBytes += bytes.length;
          if (!res.write(bytes)) {
            res.once('drain', write);
            return;
          }
        }
        if (!res.destroyed) res.end();
      };
      write();
      return;
    }
    if (req.url === '/infinite') {
      res.writeHead(200);
      const chunk = Buffer.alloc(32768, 0x62);
      const write = () => {
        while (!res.destroyed) {
          stats.downloadBytes += chunk.length;
          if (!res.write(chunk)) {
            res.once('drain', write);
            return;
          }
        }
      };
      write();
      return;
    }
    if (req.url === '/bom') {
      res.end(Buffer.from('\ufeff{"value":1}'));
      return;
    }
    if (req.url === '/empty') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.url === '/bad-json') {
      res.end('{');
      return;
    }
    if (req.url === '/invalid-utf8') {
      res.end(Buffer.from([0xff]));
      return;
    }
    if (req.url === '/charset') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=windows-1251' });
      res.end(Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]));
      return;
    }
    if (req.url === '/status') {
      res.writeHead(503);
      res.end('unavailable');
      return;
    }
    if (req.url === '/redirect') {
      res.writeHead(307, { location: '/echo' });
      res.end('manual');
      return;
    }
    if (req.url === '/repeat') {
      res.writeHead(200, {
        'set-cookie': ['a=1; Path=/', 'b=2; Path=/'],
        'x-repeat': ['first', 'second'],
      });
      res.end('repeat');
      return;
    }
    if (req.url === '/count') {
      let length = 0;
      req.on('data', (b) => {
        length += b.length;
        stats.uploadBytes += b.length;
      });
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ length }));
      });
      return;
    }
    const chunks = [];
    req.on('data', (c) => {
      chunks.push(c);
      stats.uploadBytes += c.length;
    });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          url: req.url,
          method: req.method,
          headers: req.headers,
          rawHeaders: req.rawHeaders,
          body: Buffer.concat(chunks).toString('base64'),
          httpVersion: req.httpVersion,
        }),
      );
    });
  };
  const server = tls
    ? http2.createSecureServer(
        { key: readFileSync(join(dir, 'key.pem')), cert: ca, allowHTTP1: !http2Only },
        handler,
      )
    : http.createServer(handler);
  server.on('connection', (socket) => {
    stats.connections++;
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
      stats.closed++;
    });
    socket.on('error', () => {});
  });
  server.on('session', (session) => {
    sessions.add(session);
    session.on('close', () => sessions.delete(session));
    session.on('error', () => {});
  });
  server.on('clientError', (_, socket) => socket.destroy());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `${tls ? 'https' : 'http'}://127.0.0.1:${server.address().port}`;
  return {
    url,
    ca,
    stats,
    wait(path) {
      return new Promise((resolve) => {
        const set = events.get(path) ?? [];
        set.push(resolve);
        events.set(path, set);
      });
    },
    async close() {
      for (const session of sessions) session.destroy();
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, 'close');
      if (dir) rmSync(dir, { recursive: true, force: true });
    },
  };
}
