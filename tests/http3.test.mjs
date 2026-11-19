import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import https from 'node:https';
import test from 'node:test';
import { clientDatagrams, summarizeHttp3 } from '../fixtures/http3-compare.mjs';
import { http3WireFixture } from '../fixtures/http3-wire.mjs';
import { createClient, defineProfile } from '../packages/omreq/dist/index.mjs';
import {
  chromeProfiles,
  latestChrome,
  readProfileText,
  referenceUrl,
} from '../scripts/profile-catalog.mjs';

const input = (entry = latestChrome(), version) => {
  const profile = JSON.parse(readProfileText(entry));
  if (version) profile.transport.httpVersion = version;
  return profile;
};
const only = (entry) => defineProfile(input(entry, '3'));
const local = { resolve: { localhost: '127.0.0.1' } };
const connections = (fixture) => fixture.events.filter((e) => e.event === 'connection').length;

/** A TCP HTTPS origin on the fixture's certificate that advertises `altSvc`. */
async function tcpOrigin(fixture, altSvc) {
  const server = https.createServer({ cert: fixture.ca, key: fixture.key }, (req, res) => {
    res.setHeader('alt-svc', altSvc);
    res.end(`tcp ${req.url}`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `https://localhost:${server.address().port}`,
    close: () =>
      new Promise((resolve) => server.close(resolve)).finally(() => server.closeAllConnections()),
  };
}

for (const entry of chromeProfiles().filter((e) =>
  existsSync(referenceUrl(e, 'http3-capture.json')),
)) {
  test(`G1 ${entry.name}: QUIC Initial, control stream and QPACK headers match Chrome`, async () => {
    const reference = JSON.parse(readFileSync(referenceUrl(entry, 'http3-capture.json'), 'utf8'));
    const fixture = await http3WireFixture();
    const c = createClient({
      profile: only(entry),
      ca: fixture.ca,
      trustStore: 'chromium',
      ...local,
    });
    const paths = ['/probe', '/probe?reuse=1'];
    try {
      for (const path of paths) {
        const res = await c.get(`${fixture.url}${path}`);
        assert.equal(res.httpVersion, '3');
        await res.bytes();
      }
      assert.equal(c.getStats().http3Connections, 1);
      await fixture.waitFor((e) => e.event === 'request' && e.stream === 1);
      const actual = summarizeHttp3(
        { events: fixture.events, datagrams: clientDatagrams(fixture.datagrams) },
        0,
        paths,
      );
      assert.deepEqual(actual.initial, reference.initial);
      assert.deepEqual(actual.uniStreams, reference.uniStreams);
      assert.deepEqual(actual.control, reference.control);
      // The fixture port changes per run, so the exact bytes differ only inside :authority;
      // the decoded fields keep every representation and Huffman choice.
      const fields = (requests) => requests.map(({ headersHex: _, ...r }) => r);
      assert.deepEqual(fields(actual.requests), fields(reference.requests));
    } finally {
      await c.close();
      await fixture.close();
    }
  });
}

test('HTTP/3: GET and POST over one QUIC connection', async () => {
  const fixture = await http3WireFixture();
  const c = createClient({ profile: only(), ca: fixture.ca, ...local });
  try {
    const get = await c.get(`${fixture.url}/probe`);
    assert.equal(get.status, 200);
    assert.equal(get.httpVersion, '3');
    assert.equal(get.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.match(await get.text(), /omreq h3 fixture/);

    const body = 'x'.repeat(100_000);
    const post = await c.post(`${fixture.url}/upload`, {
      body,
      headers: { cookie: 'a=1; b=2', 'content-type': 'text/plain' },
    });
    assert.equal(post.status, 200);
    assert.equal(post.httpVersion, '3');
    await post.bytes();
    assert.equal(connections(fixture), 1);
    assert.equal(c.getStats().http3Connections, 1);

    await fixture.waitFor((e) => e.event === 'fin' && e.kind === 'request' && e.stream === 1);
    const [, upload] = summarizeHttp3(
      { events: fixture.events, datagrams: clientDatagrams(fixture.datagrams) },
      0,
      ['/probe', '/upload'],
    ).requests;
    assert.equal(upload.body, body.length);
    const field = (name) => upload.fields.filter((f) => f.name === name).map((f) => f.value);
    assert.deepEqual(field(':method'), ['POST']);
    assert.deepEqual(field('content-length'), [String(body.length)]);
    // Chrome splits the cookie into crumbs for QPACK.
    assert.deepEqual(field('cookie'), ['a=1', 'b=2']);
  } finally {
    await c.close();
    await fixture.close();
  }
});

test('HTTP/3: QPACK dynamic table entries from the encoder stream decode', async () => {
  // The encoder stream's instructions arrive with its stream type; every new connection
  // races them against the response HEADERS that reference them.
  const fixture = await http3WireFixture({ qpackDynamic: true });
  try {
    for (let i = 0; i < 10; i++) {
      const c = createClient({
        profile: only(),
        ca: fixture.ca,
        timeouts: { totalMs: 5000 },
        ...local,
      });
      try {
        const res = await c.get(`${fixture.url}/dynamic`);
        assert.equal(res.headers.get('x-dynamic'), 'yes');
        await res.bytes();
      } finally {
        await c.close();
      }
    }
  } finally {
    await fixture.close();
  }
});

test('HTTP/3: Alt-Svc moves later requests to QUIC', async () => {
  const fixture = await http3WireFixture();
  const origin = await tcpOrigin(fixture, `h3=":${fixture.port}"; ma=60`);
  const c = createClient({ ca: fixture.ca, ...local });
  try {
    const first = await c.get(`${origin.url}/first`);
    assert.notEqual(first.httpVersion, '3');
    assert.equal(await first.text(), 'tcp /first');
    const second = await c.get(`${origin.url}/second`);
    assert.equal(second.httpVersion, '3');
    assert.match(await second.text(), /omreq h3 fixture/);
    assert.equal(c.getStats().http3Connections, 1);
  } finally {
    await c.close();
    await origin.close();
    await fixture.close();
  }
});

test('HTTP/3: a failed QUIC handshake falls back to TCP and is not retried', async () => {
  const fixture = await http3WireFixture();
  // A UDP port that swallows datagrams: the handshake can only time out.
  const sink = dgram.createSocket('udp4');
  sink.bind(0, '127.0.0.1');
  await once(sink, 'listening');
  const origin = await tcpOrigin(fixture, `h3=":${sink.address().port}"; ma=60`);
  const c = createClient({ ca: fixture.ca, connectMs: 500, ...local });
  try {
    assert.notEqual((await c.get(`${origin.url}/a`)).httpVersion, '3');
    const started = Date.now();
    const fallback = await c.get(`${origin.url}/b`);
    assert.notEqual(fallback.httpVersion, '3');
    assert.equal(await fallback.text(), 'tcp /b');
    assert(Date.now() - started < 5000);
    // The origin is marked broken: the next request goes straight to TCP.
    const quick = Date.now();
    assert.notEqual((await c.get(`${origin.url}/c`)).httpVersion, '3');
    assert(Date.now() - quick < 400, 'broken HTTP/3 was retried');
    assert.equal(c.getStats().http3Connections, 0);
  } finally {
    await c.close();
    sink.close();
    await origin.close();
    await fixture.close();
  }
});

test('HTTP/3: requests waiting on a failing handshake do not repeat it', async () => {
  const fixture = await http3WireFixture();
  const sink = dgram.createSocket('udp4');
  sink.bind(0, '127.0.0.1');
  await once(sink, 'listening');
  const origin = await tcpOrigin(fixture, `h3=":${sink.address().port}"; ma=60`);
  const c = createClient({ ca: fixture.ca, connectMs: 500, ...local });
  try {
    await (await c.get(`${origin.url}/a`)).bytes();
    const started = Date.now();
    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, i) => c.get(`${origin.url}/p${i}`)),
    );
    for (const res of responses) {
      assert.notEqual(res.httpVersion, '3');
      await res.bytes();
    }
    // One 500 ms handshake for all of them, not one each.
    assert(Date.now() - started < 1500, `took ${Date.now() - started} ms`);
  } finally {
    await c.close();
    sink.close();
    await origin.close();
    await fixture.close();
  }
});

test('HTTP/3: a handshake outlives an abandoned request and still marks the origin', async () => {
  const fixture = await http3WireFixture();
  const sink = dgram.createSocket('udp4');
  sink.bind(0, '127.0.0.1');
  await once(sink, 'listening');
  const origin = await tcpOrigin(fixture, `h3=":${sink.address().port}"; ma=60`);
  // The headers deadline ends each request before the 1 s handshake budget does.
  const c = createClient({ ca: fixture.ca, connectMs: 1000, ...local });
  try {
    await (await c.get(`${origin.url}/a`)).bytes();
    await assert.rejects(c.get(`${origin.url}/b`, { timeouts: { headersMs: 200 } }), {
      code: 'ERR_TIMEOUT',
    });
    await new Promise((r) => setTimeout(r, 1200));
    const quick = Date.now();
    const res = await c.get(`${origin.url}/c`, { timeouts: { headersMs: 200 } });
    assert.notEqual(res.httpVersion, '3');
    assert.equal(await res.text(), 'tcp /c');
    assert(Date.now() - quick < 200);
  } finally {
    await c.close();
    sink.close();
    await origin.close();
    await fixture.close();
  }
});

for (const reject of ['stream', 'connection']) {
  test(`HTTP/3: a request the server refuses (${reject}) is resent over TCP`, async () => {
    const fixture = await http3WireFixture({ reject });
    const origin = await tcpOrigin(fixture, `h3=":${fixture.port}"; ma=60`);
    const c = createClient({ ca: fixture.ca, ...local });
    try {
      await (await c.get(`${origin.url}/a`)).bytes();
      const res = await c.post(`${origin.url}/b`, { body: 'payload' });
      assert.notEqual(res.httpVersion, '3');
      assert.equal(await res.text(), 'tcp /b');
      await fixture.waitFor((e) => e.event === 'fin' && e.kind === 'request');
      // HTTP/3 to the origin is now broken: the next request does not try it.
      const next = await c.get(`${origin.url}/c`);
      assert.notEqual(next.httpVersion, '3');
      await next.bytes();
      assert.equal(
        fixture.events.filter((e) => e.event === 'fin' && e.kind === 'request').length,
        1,
      );
    } finally {
      await c.close();
      await origin.close();
      await fixture.close();
    }
  });
}

test('HTTP/3: strict mode reports a refused request', async () => {
  const fixture = await http3WireFixture({ reject: 'stream' });
  const c = createClient({ profile: only(), ca: fixture.ca, ...local });
  try {
    await assert.rejects(c.get(`${fixture.url}/x`), (error) => /rejected/.test(error.message));
  } finally {
    await c.close();
    await fixture.close();
  }
});

test('HTTP/3: http3: false keeps Alt-Svc origins on TCP', async () => {
  const fixture = await http3WireFixture();
  const origin = await tcpOrigin(fixture, `h3=":${fixture.port}"; ma=60`);
  const c = createClient({ ca: fixture.ca, http3: false, ...local });
  try {
    await (await c.get(`${origin.url}/a`)).bytes();
    assert.notEqual((await c.get(`${origin.url}/b`)).httpVersion, '3');
    assert.equal(connections(fixture), 0);
  } finally {
    await c.close();
    await origin.close();
    await fixture.close();
  }
});

test('HTTP/3: strict mode rejects what it cannot carry', async () => {
  assert.throws(() => createClient({ http3: 'yes' }), { code: 'ERR_INVALID_ARGUMENT' });
  const withoutBlock = input(latestChrome(), '3');
  delete withoutBlock.transport.http3;
  assert.throws(() => defineProfile(withoutBlock), { code: 'ERR_PROFILE_INVALID' });

  const strict = only();
  for (const [options, url] of [
    [{ proxy: 'http://127.0.0.1:9' }, 'https://localhost/'],
    [{ http3: false }, 'https://localhost/'],
    [{}, 'http://localhost/'],
  ]) {
    const c = createClient({ profile: strict, ...options });
    try {
      await assert.rejects(c.get(url), (error) => typeof error.code === 'string');
    } finally {
      await c.close();
    }
  }
});

test('HTTP/3: an abandoned request sends QPACK Stream Cancellation like Chrome', async () => {
  const fixture = await http3WireFixture({ delayMs: 5000 });
  const c = createClient({ profile: only(), ca: fixture.ca, ...local });
  try {
    const controller = new AbortController();
    const request = c.get(`${fixture.url}/abandon`, { signal: controller.signal });
    await fixture.waitFor((e) => e.event === 'fin' && e.kind === 'request');
    controller.abort();
    await assert.rejects(request);
    // Decoder stream (type 0x03), then Stream Cancellation (0x40 | stream ID 0).
    const event = await fixture.waitFor((e) => e.event === 'uni' && e.data.startsWith('03'));
    assert.equal(event.data, '0340');
  } finally {
    await c.close();
    await fixture.close();
  }
});
