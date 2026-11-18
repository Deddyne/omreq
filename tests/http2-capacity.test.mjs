import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http2 from 'node:http2';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createClient } from '../packages/omreq/dist/index.mjs';

function tracked(promise) {
  void promise.catch(() => {});
  return promise;
}
async function within(promise, message, ms = 800) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function until(check) {
  for (let i = 0; i < 150; i++) {
    if (check()) return;
    await delay(5);
  }
  assert.fail('HTTP2 request did not enter the capacity wait');
}
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'omreq-h2-capacity-'));
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
  const ca = readFileSync(join(dir, 'cert.pem'), 'utf8');
  const server = http2.createSecureServer({
    key: readFileSync(join(dir, 'key.pem')),
    cert: ca,
    settings: { maxConcurrentStreams: 1 },
  });
  const sockets = new Set(),
    sessions = new Set(),
    paths = [];
  let settingsAck, held;
  const ack = new Promise((resolve) => {
    settingsAck = resolve;
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  });
  server.on('session', (session) => {
    sessions.add(session);
    session.on('close', () => sessions.delete(session));
    session.on('error', () => {});
    session.on('localSettings', (settings) => {
      if (settings.maxConcurrentStreams === 1) settingsAck();
    });
  });
  server.on('stream', (stream, headers) => {
    stream.on('error', () => {});
    paths.push(headers[':path']);
    if (headers[':path'] === '/hold') {
      held = stream;
      // Consume the (empty) request side so Node can drop the stream as soon
      // as it closes instead of waiting for a later 'end'.
      stream.resume();
      stream.respond({ ':status': 200 });
      stream.write('neighbour');
      return;
    }
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => {
      if (stream.destroyed || stream.closed) return;
      stream.respond({ ':status': 200 });
      stream.end(Buffer.concat(chunks));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    ca,
    ack,
    paths,
    url: `https://127.0.0.1:${server.address().port}`,
    // Node removes a finished stream from its session asynchronously; with
    // maxConcurrentStreams 1 a new stream opened in that window is refused
    // with ENHANCE_YOUR_CALM although the peer already ended the old one.
    finishNeighbour() {
      const closed = once(held, 'close');
      held.end(' survives');
      return closed;
    },
    async close() {
      for (const session of sessions) session.destroy();
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, 'close');
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
/**
 * Node's HTTP/2 server drops a closed stream from its table in a later
 * immediate. With maxConcurrentStreams 1, a new stream that arrives in the same
 * read is reset with ENHANCE_YOUR_CALM ("excessive load"), although the peer
 * already ended the old one. That is a fixture artifact, not client behavior:
 * rerun the whole scenario on a fresh server only for that exact error.
 */
async function withFixtureRetry(scenario) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await scenario();
    } catch (error) {
      if (attempt >= 4 || !/excessive load/.test(String(error?.message))) throw error;
    }
  }
}
function assertZero(client) {
  const stats = client.getStats();
  for (const key of [
    'activeOperations',
    'queuedOperations',
    'nativeTasks',
    'uploadBridgeBytes',
    'retainedRequestBodyBytes',
    'connections',
    'waitingConnections',
  ])
    assert.equal(stats[key], 0, key);
  assert.deepEqual(stats.connectionOrigins, []);
}
async function neighbourSurvives(server, client, held) {
  assert.deepEqual(server.paths, ['/hold'], 'Capacity-blocked requests never reached the peer');
  const neighbourClosed = server.finishNeighbour();
  assert.equal(await held.text(), 'neighbour survives');
  await neighbourClosed;
  // The session drops a closed stream from its table in a later immediate.
  await new Promise((resolve) => setImmediate(resolve));
  const response = await client.post(`${server.url}/after`, {
    body: new Blob(['after cancellation']),
  });
  assert.equal(await response.text(), 'after cancellation');
  assert.equal(client.getStats().connections, 1, 'The active neighbour kept its HTTP2 connection');
}

for (const mode of ['abort', 'total deadline'])
  test(`T08/T09/T17: HTTP2 capacity-blocked Blob ${mode} releases ownership without closing its neighbour`, () =>
    withFixtureRetry(async () => {
      const server = await fixture();
      const client = createClient({ ca: server.ca, maxConnections: 1, maxConnectionsPerOrigin: 1 });
      const controller = new AbortController();
      try {
        const held = await client.get(`${server.url}/hold`);
        await within(server.ack, 'Peer settings were not acknowledged');
        const pending = tracked(
          client.post(`${server.url}/blocked`, {
            body: new Blob([Buffer.alloc(131072, 0x61)]),
            signal: controller.signal,
            ...(mode === 'total deadline' ? { timeouts: { totalMs: 100 } } : {}),
          }),
        );
        await until(() => client.getStats().activeOperations === 2);
        if (mode === 'abort') controller.abort('cancel only the capacity waiter');
        await assert.rejects(within(pending, 'Cancelled HTTP2 capacity waiter retained its body'), {
          code: mode === 'abort' ? 'ERR_ABORTED' : 'ERR_TIMEOUT',
        });
        assert.equal(client.getStats().activeOperations, 1);
        assert.equal(client.getStats().uploadBridgeBytes, 0);
        await neighbourSurvives(server, client, held);
      } finally {
        await client.close();
        assertZero(client);
        await server.close();
      }
    }));

test('T08/T09/T16: cancelling HTTP2 waiters behind a live FIFO head releases each body and keeps metadata bounded', () =>
  withFixtureRetry(async () => {
    const server = await fixture();
    const client = createClient({
      ca: server.ca,
      maxConnections: 1,
      maxConnectionsPerOrigin: 1,
      maxActiveOperations: 4,
    });
    const firstController = new AbortController();
    try {
      const held = await client.get(`${server.url}/hold`);
      await within(server.ack, 'Peer settings were not acknowledged');
      const front = tracked(
        client.post(`${server.url}/front`, {
          body: new Blob(['front']),
          signal: firstController.signal,
        }),
      );
      await until(() => client.getStats().activeOperations === 2);
      for (let i = 0; i < 16; i++) {
        const controller = new AbortController();
        const later = tracked(
          client.post(`${server.url}/later-${i}`, {
            body: new Blob([Buffer.alloc(65536)]),
            signal: controller.signal,
          }),
        );
        await until(() => client.getStats().activeOperations === 3);
        controller.abort();
        await assert.rejects(within(later, 'Cancelled FIFO tail waited for the live head'), {
          code: 'ERR_ABORTED',
        });
        assert.equal(client.getStats().activeOperations, 2);
        assert.equal(client.getStats().connections, 1);
        assert.equal(client.getStats().uploadBridgeBytes, 0);
      }
      firstController.abort();
      await assert.rejects(within(front, 'Pending-open HTTP2 request retained its body'), {
        code: 'ERR_ABORTED',
      });
      await neighbourSurvives(server, client, held);
    } finally {
      await client.close();
      assertZero(client);
      await server.close();
    }
  }));

test('T09/T16: surviving HTTP2 capacity waiters keep FIFO after removing a cancelled middle request', () =>
  withFixtureRetry(async () => {
    const server = await fixture();
    const client = createClient({ ca: server.ca, maxConnections: 1, maxConnectionsPerOrigin: 1 });
    const controller = new AbortController();
    try {
      const held = await client.get(`${server.url}/hold`);
      await within(server.ack, 'Peer settings were not acknowledged');
      const first = tracked(client.post(`${server.url}/first`, { body: new Blob(['first']) }));
      const cancelled = tracked(
        client.post(`${server.url}/cancelled`, {
          body: new Blob(['cancelled']),
          signal: controller.signal,
        }),
      );
      const last = tracked(client.post(`${server.url}/last`, { body: new Blob(['last']) }));
      await until(() => client.getStats().activeOperations === 4);
      controller.abort();
      await assert.rejects(within(cancelled, 'Cancelled middle request kept its upload body'), {
        code: 'ERR_ABORTED',
      });
      assert.deepEqual(server.paths, ['/hold']);
      server.finishNeighbour();
      assert.equal(await held.text(), 'neighbour survives');
      assert.equal(await (await first).text(), 'first');
      assert.equal(await (await last).text(), 'last');
      assert.deepEqual(server.paths, ['/hold', '/first', '/last']);
      assert.equal(client.getStats().connections, 1);
    } finally {
      await client.close();
      assertZero(client);
      await server.close();
    }
  }));
