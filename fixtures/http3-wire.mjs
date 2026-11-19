import { execFileSync, spawn } from 'node:child_process';
import { createHash, createPublicKey } from 'node:crypto';
import dgram from 'node:dgram';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

/** Builds the h3 recorder server once and returns its path. */
export function h3FixtureBinary() {
  const binary = join(
    root,
    'target',
    'debug',
    process.platform === 'win32' ? 'omreq-h3-fixture.exe' : 'omreq-h3-fixture',
  );
  if (!process.env.OMREQ_H3_FIXTURE_SKIP_BUILD || !existsSync(binary))
    execFileSync('cargo', ['build', '--quiet', '-p', 'omreq-h3-fixture'], {
      cwd: root,
      stdio: 'inherit',
    });
  return binary;
}

/**
 * An HTTP/3 server on 127.0.0.1 that records the raw client streams, behind a UDP tap that
 * records every client datagram. Connections are labelled by their client UDP port.
 */
export async function http3WireFixture({
  settings = '',
  delayMs = 0,
  qpackDynamic = false,
  reject = '',
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'omreq-h3-wire-'));
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
  const ca = readFileSync(join(dir, 'cert.pem'), 'utf8');
  // The same certificate and key can serve a TCP origin that advertises this fixture.
  const key = readFileSync(join(dir, 'key.pem'), 'utf8');
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

  const server = spawn(
    h3FixtureBinary(),
    [
      '--cert',
      join(dir, 'cert.pem'),
      '--key',
      join(dir, 'key.pem'),
      '--settings',
      settings,
      '--delay-ms',
      String(delayMs),
      ...(qpackDynamic ? ['--qpack-dynamic'] : []),
      ...(reject ? ['--reject', reject] : []),
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const kill = () => server.kill('SIGKILL');
  process.once('exit', kill);
  const events = [];
  server.on('exit', (code) => {
    for (const waiter of waiters.splice(0)) waiter.reject(Error(`h3 fixture exited: ${code}`));
  });
  const waiters = [];
  const lines = createInterface({ input: server.stdout });
  lines.on('line', (line) => {
    const event = JSON.parse(line);
    events.push(event);
    for (const waiter of [...waiters])
      if (waiter.test(event)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(event);
      }
  });
  const waitFor = (test, ms = 15000) => {
    const found = events.find(test);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const waiter = { test, resolve, reject };
      waiters.push(waiter);
      setTimeout(() => {
        const i = waiters.indexOf(waiter);
        if (i >= 0) {
          waiters.splice(i, 1);
          reject(Error('h3 fixture event deadline'));
        }
      }, ms).unref();
    });
  };
  const { port: backendPort } = await waitFor((e) => e.event === 'listening');

  // UDP tap: one upstream socket per client address, so the server sees distinct connections.
  const datagrams = [];
  const tap = dgram.createSocket('udp4');
  const upstreams = new Map();
  tap.on('message', (message, from) => {
    const key = `${from.address}:${from.port}`;
    datagrams.push({ client: key, at: Date.now(), data: Buffer.from(message) });
    let upstream = upstreams.get(key);
    if (!upstream) {
      upstream = dgram.createSocket('udp4');
      upstream.on('message', (reply) => tap.send(reply, from.port, from.address));
      upstream.bind(0, '127.0.0.1');
      upstreams.set(key, upstream);
    }
    upstream.send(message, backendPort, '127.0.0.1');
  });
  tap.bind(0, '127.0.0.1');
  await once(tap, 'listening');
  const port = tap.address().port;

  return {
    port,
    url: `https://localhost:${port}`,
    ca,
    key,
    spki,
    events,
    datagrams,
    waitFor,
    async close() {
      for (const upstream of upstreams.values()) upstream.close();
      tap.close();
      process.off('exit', kill);
      server.kill('SIGTERM');
      if (server.exitCode === null)
        await Promise.race([once(server, 'exit'), new Promise((r) => setTimeout(r, 1000))]);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
