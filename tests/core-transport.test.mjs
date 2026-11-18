import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createClient } from '../packages/omreq/dist/index.mjs';

async function serve(handler) {
  const server = createServer(handler);
  let connections = 0;
  const sockets = new Set();
  server.on('connection', (socket) => {
    connections++;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    connections: () => connections,
    async close() {
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, 'close');
    },
  };
}

test('B-04: headersMs starts after a large buffered body was handed to the transport', async () => {
  const s = await serve((req, res) => {
    // Hold the socket unread long past headersMs, then read and answer at once.
    req.pause();
    setTimeout(() => {
      let bytes = 0;
      req.on('data', (chunk) => {
        bytes += chunk.length;
      });
      req.on('end', () => res.end(String(bytes)));
      req.resume();
    }, 400);
  });
  const c = createClient();
  try {
    const body = Buffer.alloc(16 * 1048576, 0x61);
    const response = await c.post(s.url, { body, timeouts: { headersMs: 250 } });
    assert.equal(await response.text(), String(body.length));
  } finally {
    await c.close();
    await s.close();
  }
});

test('L-03: the total deadline reports the phase it interrupted', async () => {
  const s = await serve(() => {});
  const c = createClient();
  try {
    await assert.rejects(c.get(s.url, { timeouts: { totalMs: 150 } }), {
      code: 'ERR_TIMEOUT',
      phase: 'headers',
    });
  } finally {
    await c.close();
    await s.close();
  }
});

test('L-05: a small intermediate redirect body is drained and the connection reused', async () => {
  const s = await serve((req, res) => {
    if (req.url === '/final') return res.end('ok');
    res.writeHead(302, { location: '/final', 'content-length': 5 });
    res.flushHeaders();
    // The body trails the headers, so it is unread when the redirect is followed.
    setTimeout(() => res.end('moved'), 30);
  });
  const c = createClient();
  try {
    const response = await c.get(`${s.url}/start`);
    assert.equal(await response.text(), 'ok');
    assert.equal(response.redirects.length, 1);
    assert.equal(s.connections(), 1);
  } finally {
    await c.close();
    await s.close();
  }
});

test('B-10: an early response does not end an unfinished upload as a complete body', async () => {
  let ended = false;
  let onClose;
  const closed = new Promise((resolve) => {
    onClose = resolve;
  });
  const s = await serve((req, res) => {
    req.on('end', () => {
      ended = true;
    });
    req.socket.on('close', onClose);
    req.once('data', () => res.end('early'));
  });
  const c = createClient();
  try {
    const source = {
      async *[Symbol.asyncIterator]() {
        yield Buffer.from('first');
        await new Promise(() => {});
      },
    };
    const response = await c.post(s.url, { body: source });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'early');
    await Promise.race([closed, delay(5000).then(() => assert.fail('request stream stayed open'))]);
    assert.equal(ended, false, 'server must not see a complete request body');
  } finally {
    await c.close();
    await s.close();
  }
});
