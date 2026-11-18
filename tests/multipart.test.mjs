import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from '../fixtures/server.mjs';
import { createClient } from '../packages/omreq/dist/index.mjs';

const decode = (echo) => Buffer.from(echo.body, 'base64');
function tracked(promise) {
  void promise.catch(() => {});
  return promise;
}
async function settledWithin(event, message = 'Upload did not reach the fixture within 2 seconds') {
  let timer;
  try {
    return await Promise.race([
      event,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error(message)), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function assertReleased(client) {
  const stats = client.getStats();
  assert.equal(stats.activeOperations, 0);
  assert.equal(stats.queuedOperations, 0);
  assert.equal(stats.uploadBridgeBytes, 0);
  assert.equal(stats.retainedRequestBodyBytes, 0);
}
function boundary(contentType) {
  const match = /^multipart\/form-data; boundary=([A-Za-z0-9'-]{1,70})$/.exec(contentType);
  assert(match, `Expected a bounded token multipart boundary: ${contentType}`);
  return match[1];
}
function encodedMultipart(token, parts) {
  const chunks = [];
  for (const { disposition, type, bytes } of parts)
    chunks.push(
      Buffer.from(
        `--${token}\r\nContent-Disposition: form-data; ${disposition}\r\n${type ? `Content-Type: ${type}\r\n` : ''}\r\n`,
      ),
      Buffer.from(bytes),
      Buffer.from('\r\n'),
    );
  chunks.push(Buffer.from(`--${token}--\r\n`));
  return Buffer.concat(chunks);
}

for (const tls of [false, true]) {
  const protocol = tls ? 'H2' : 'H1';
  test(`T05/T06/T11: Blob is streamed in bounded chunks and replayed from the beginning over ${protocol}`, async () => {
    const seen = [];
    const s = await fixture({
      tls,
      route(req, res) {
        if (!['/blob307', '/blob308'].includes(req.url)) return false;
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
          seen.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
          res.writeHead(req.url === '/blob307' ? 307 : 308, {
            location: req.url === '/blob307' ? '/blob308' : '/echo',
          });
          res.end();
        });
        return true;
      },
    });
    const c = createClient({ ca: s.ca, maxInputChunkBytes: 1024 });
    class StreamingBlob extends Blob {
      arrayBuffer() {
        throw Error('The complete Blob must not be materialized');
      }
      text() {
        throw Error('The complete Blob must not be decoded');
      }
    }
    const original = Buffer.alloc(1048576 + 17);
    for (let i = 0; i < original.length; i++) original[i] = i % 251;
    const expected = Buffer.from(original);
    const body = new StreamingBlob([original], { type: 'application/blob-test' });
    original.fill(0);
    try {
      const response = await c.post(`${s.url}/blob307`, { body });
      assert.equal(response.httpVersion, tls ? '2' : '1.1');
      assert.equal(response.redirects.length, 2);
      const echo = await response.json();
      for (const hop of [...seen, { headers: echo.headers, body: decode(echo) }]) {
        assert.deepEqual(hop.body, expected);
        assert.equal(hop.headers['content-type'], 'application/blob-test');
        assert.equal(hop.headers['content-length'], String(expected.length));
      }
      assertReleased(c);
      const overridden = await (
        await c.post(`${s.url}/echo`, {
          body: new Blob(['custom'], { type: 'text/blob' }),
          headers: { 'content-type': 'application/explicit' },
        })
      ).json();
      assert.equal(overridden.headers['content-type'], 'application/explicit');
      assert.equal(decode(overridden).toString(), 'custom');
      const empty = await (await c.post(`${s.url}/echo`, { body: new Blob([]) })).json();
      assert.equal(decode(empty).length, 0);
      // HTTP1 may omit framing for an empty body; HTTP2 may advertise length 0.
      if (empty.headers['content-length'] !== undefined)
        assert.equal(empty.headers['content-length'], '0');
      assert.equal(empty.headers['transfer-encoding'], undefined);
      assert.equal(empty.headers['content-type'], undefined);
    } finally {
      await c.close();
      await s.close();
    }
  });

  test(`T05/T11: FormData snapshots ordered parts and replays identical multipart bytes over ${protocol}`, async () => {
    const seen = [];
    const s = await fixture({
      tls,
      route(req, res) {
        if (!['/multipart307', '/multipart308'].includes(req.url)) return false;
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
          seen.push({ headers: req.headers, body: Buffer.concat(chunks) });
          res.writeHead(req.url === '/multipart307' ? 307 : 308, {
            location: req.url === '/multipart307' ? '/multipart308' : '/echo',
          });
          res.end();
        });
        return true;
      },
    });
    const c = createClient({ ca: s.ca, maxInputChunkBytes: 7 });
    const bytes = Uint8Array.from([0, 255, 13, 10, 34, 65]);
    const data = new FormData();
    data.append('repeat', 'first');
    data.append('repeat', 'second');
    data.append('lines', 'a\nb\rc\r\nd');
    data.append('field"\r\nname', 'safe value');
    data.append(
      'file',
      new Blob([bytes], { type: 'application/octet-stream' }),
      '/private/uploads/wire"file\r\n.bin',
    );
    data.append('default', new Blob([Uint8Array.from([1, 2, 3])]));
    try {
      const request = c.post(`${s.url}/multipart307`, { body: data });
      data.set('repeat', 'changed after request');
      data.delete('file');
      data.append('late', 'must not appear');
      bytes.fill(9);
      const response = await request;
      assert.equal(response.redirects.length, 2);
      const echo = await response.json();
      const token = boundary(echo.headers['content-type']);
      const expected = encodedMultipart(token, [
        { disposition: 'name="repeat"', bytes: 'first' },
        { disposition: 'name="repeat"', bytes: 'second' },
        { disposition: 'name="lines"', bytes: 'a\r\nb\r\nc\r\nd' },
        { disposition: 'name="field%22%0D%0Aname"', bytes: 'safe value' },
        {
          disposition: 'name="file"; filename="wire%22file%0D%0A.bin"',
          type: 'application/octet-stream',
          bytes: Uint8Array.from([0, 255, 13, 10, 34, 65]),
        },
        {
          disposition: 'name="default"; filename="blob"',
          type: 'application/octet-stream',
          bytes: Uint8Array.from([1, 2, 3]),
        },
      ]);
      for (const hop of [...seen, { headers: echo.headers, body: decode(echo) }]) {
        assert.equal(hop.headers['content-type'], echo.headers['content-type']);
        assert.equal(hop.headers['content-length'], String(expected.length));
        assert.deepEqual(hop.body, expected);
      }
      assertReleased(c);
      const empty = await (await c.post(`${s.url}/echo`, { body: new FormData() })).json();
      const emptyToken = boundary(empty.headers['content-type']);
      assert.deepEqual(decode(empty), Buffer.from(`--${emptyToken}--\r\n`));
      assert.notEqual(emptyToken, token, 'Separate operations receive separate boundaries');
    } finally {
      await c.close();
      await s.close();
    }
  });

  test(`T07/T11: an early redirect restarts Blob/multipart upload and 303 removes its body over ${protocol}`, async () => {
    let firstBytes = 0;
    const s = await fixture({
      tls,
      route(req, res) {
        if (!['/early307', '/early308', '/drop303'].includes(req.url)) return false;
        req.once('data', (chunk) => {
          firstBytes += chunk.length;
          req.pause();
          res.writeHead(req.url === '/drop303' ? 303 : req.url === '/early307' ? 307 : 308, {
            location: '/echo',
          });
          res.end();
        });
        return true;
      },
    });
    const c = createClient({ ca: s.ca, maxInputChunkBytes: 1024 });
    const payload = Buffer.alloc(2 * 1048576 + 13, 0x61);
    try {
      for (const multipart of [false, true]) {
        const body = multipart ? new FormData() : new Blob([payload]);
        if (multipart) body.append('large', new Blob([payload]), 'large.bin');
        for (const path of ['/early307', '/early308', '/drop303']) {
          const response = await c.post(s.url + path, { body, timeouts: { totalMs: 10000 } });
          const echo = await response.json();
          assert.equal(response.redirects.length, 1);
          if (path === '/drop303') {
            assert.equal(echo.method, 'GET');
            assert.equal(decode(echo).length, 0);
            assert.equal(echo.headers['content-type'], undefined);
            assert.equal(echo.headers['content-length'], undefined);
          } else {
            assert.equal(echo.method, 'POST');
            const actual = decode(echo);
            const expected = multipart
              ? encodedMultipart(boundary(echo.headers['content-type']), [
                  {
                    disposition: 'name="large"; filename="large.bin"',
                    type: 'application/octet-stream',
                    bytes: payload,
                  },
                ])
              : payload;
            assert.deepEqual(actual, expected);
          }
          assertReleased(c);
        }
      }
      assert(firstBytes > 0, 'Redirects were sent only after receiving upload bytes');
      assert(
        firstBytes < payload.length * 6,
        'Redirect fixtures stopped reading incomplete uploads',
      );
      assert.equal((await (await c.get(`${s.url}/echo`)).json()).method, 'GET');
    } finally {
      await c.close();
      await s.close();
    }
  });
}

test('T06/T08: queued multipart retains bounded text/metadata, avoids eager payload reads and releases credits on abort', async () => {
  const s = await fixture();
  const c = createClient({
    maxActiveOperations: 1,
    maxQueuedOperations: 2,
    maxRetainedRequestBodyBytes: 1024,
  });
  const controller = new AbortController();
  try {
    const held = await c.get(`${s.url}/slow`);
    const form = new FormData();
    form.append('text', 'x'.repeat(800));
    const pending = tracked(c.post(`${s.url}/count`, { body: form, signal: controller.signal }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const stats = c.getStats();
    assert.equal(stats.queuedOperations, 1);
    assert(stats.retainedRequestBodyBytes >= 800);
    assert(stats.retainedRequestBodyBytes <= 1024);
    assert.equal(s.stats.requests, 1, 'Queued payloads do not reach the network');
    await assert.rejects(c.post(`${s.url}/count`, { body: form }), { code: 'ERR_RESOURCE_LIMIT' });
    controller.abort('release multipart snapshot');
    await assert.rejects(pending, { code: 'ERR_ABORTED' });
    assert.equal(c.getStats().retainedRequestBodyBytes, 0);
    await held.dispose();
    const large = new FormData();
    large.append('file', new Blob([Buffer.alloc(2 * 1048576, 0x41)]), 'large.bin');
    const response = await c.post(`${s.url}/count`, { body: large });
    assert((await response.json()).length > 2 * 1048576);
    assertReleased(c);
  } finally {
    await c.close();
    await s.close();
  }
});

test('T08: aborting or closing an active replayable upload releases its native work and permits later requests', {
  timeout: 15000,
}, async () => {
  let received;
  let arrived = new Promise((resolve) => {
    received = resolve;
  });
  const s = await fixture({
    route(req) {
      if (req.url !== '/held-upload') return false;
      req.once('data', () => {
        req.pause();
        received();
      });
      return true;
    },
  });
  const c = createClient({ maxInputChunkBytes: 1024 });
  const closing = createClient({ maxInputChunkBytes: 1024 });
  try {
    const controller = new AbortController();
    const form = new FormData();
    form.append('large', new Blob([Buffer.alloc(16 * 1048576, 0x61)]), 'large.bin');
    const pending = tracked(
      c.post(`${s.url}/held-upload`, { body: form, signal: controller.signal }),
    );
    await settledWithin(arrived);
    controller.abort('active multipart cancellation');
    await assert.rejects(settledWithin(pending, 'Cancelled upload did not complete its cleanup'), {
      code: 'ERR_ABORTED',
    });
    assertReleased(c);
    assert.equal((await (await c.get(`${s.url}/echo`)).json()).method, 'GET');
    arrived = new Promise((resolve) => {
      received = resolve;
    });
    const duringClose = tracked(
      closing.post(`${s.url}/held-upload`, { body: new Blob([Buffer.alloc(16 * 1048576, 0x62)]) }),
    );
    await settledWithin(arrived);
    await closing.close();
    await assert.rejects(duringClose, { code: 'ERR_CLIENT_CLOSED' });
    assertReleased(closing);
    assert.equal(closing.getStats().connections, 0);
  } finally {
    await Promise.all([c.close(), closing.close()]);
    await s.close();
  }
});

test('T05: replayable body validation and pre-abort fail before network or native initialization', async () => {
  const c = createClient();
  const controller = new AbortController();
  controller.abort('already aborted');
  try {
    for (const body of [new Blob(['unused']), new FormData()]) {
      await assert.rejects(c.get('http://example.invalid', { body }), {
        code: 'ERR_INVALID_ARGUMENT',
      });
      await assert.rejects(c.post('http://example.invalid', { body, signal: controller.signal }), {
        code: 'ERR_ABORTED',
      });
    }
    assert.equal(c.getInfo().nativeReady, false);
    assertReleased(c);
  } finally {
    await c.close();
  }
});

test('T06: multipart part, header and retained-text limits reject before native initialization', async () => {
  const c = createClient();
  const small = createClient({ maxRetainedRequestBodyBytes: 1024 });
  const tooMany = new FormData();
  for (let i = 0; i < 1001; i++) tooMany.append('x', '');
  const oversizedHeader = new FormData();
  oversizedHeader.append('x'.repeat(65537), '');
  const oversizedText = new FormData();
  oversizedText.append('text', 'x'.repeat(1025));
  try {
    for (const [client, body] of [
      [c, tooMany],
      [c, oversizedHeader],
      [small, oversizedText],
    ]) {
      await assert.rejects(client.post('http://example.invalid', { body }), {
        code: 'ERR_RESOURCE_LIMIT',
      });
      assert.equal(client.getInfo().nativeReady, false);
      assertReleased(client);
    }
  } finally {
    await Promise.all([c.close(), small.close()]);
  }
});

for (const tls of [false, true])
  test(`T17: known-length Blob/multipart headers deadline works without total timeout over ${tls ? 'H2' : 'H1'}`, async () => {
    let completedUploads = 0;
    const s = await fixture({
      tls,
      route(req) {
        if (req.url !== '/body-sent-no-headers') return false;
        req.on('end', () => {
          completedUploads++;
        });
        req.resume();
        return true;
      },
    });
    const c = createClient({ ca: s.ca, maxInputChunkBytes: 7 });
    try {
      const form = new FormData();
      form.append('text', 'sent body');
      for (const body of [new Blob([]), new Blob(['sent body']), form]) {
        let timer;
        const pending = c.post(`${s.url}/body-sent-no-headers`, {
          body,
          timeouts: { headersMs: 80 },
        });
        try {
          await assert.rejects(
            Promise.race([
              pending,
              new Promise((_, reject) => {
                timer = setTimeout(
                  () => reject(Error('Headers deadline did not settle a known-length upload')),
                  2000,
                );
              }),
            ]),
            { code: 'ERR_TIMEOUT', phase: 'headers' },
          );
        } finally {
          clearTimeout(timer);
        }
        assertReleased(c);
      }
      assert.equal(completedUploads, 3, 'All bodies reached EOF before their headers deadlines');
      assert.equal((await (await c.get(`${s.url}/echo`)).json()).method, 'GET');
    } finally {
      await c.close();
      await s.close();
    }
  });
