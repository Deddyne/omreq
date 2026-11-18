import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import zlib from 'node:zlib';
import { fixture } from '../fixtures/server.mjs';
import {
  createClient,
  defineProfile,
  getProfile,
  getRuntimeInfo,
  ResponseHeaders,
} from '../packages/omreq/dist/index.mjs';

const isBun = !!process.versions.bun;
async function withServer(fn, opts = {}) {
  const server = await fixture(opts);
  try {
    await fn(server);
  } finally {
    await server.close();
  }
}
const decodeEcho = (echo) => Buffer.from(echo.body, 'base64');
async function collect(iterable) {
  const chunks = [];
  for await (const chunk of iterable) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

// B-12: transparent decompression.
const plain = Buffer.from(`${'{"hello":"world","pad":"'}${'abc'.repeat(20000)}"}`);
// Incompressible payload: the encoded body exceeds the inline limit and streams.
const random = Buffer.from(Array.from({ length: 300000 }, (_, i) => (i * 2654435761) >>> 24));
const big = randomBytes(8 * 1048576);
const encoders = {
  gzip: zlib.gzipSync,
  'x-gzip': zlib.gzipSync,
  deflate: zlib.deflateSync,
  br: zlib.brotliCompressSync,
  ...(typeof zlib.zstdCompressSync === 'function' ? { zstd: zlib.zstdCompressSync } : {}),
};
function compressionRoute(req, res) {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/z') return false;
  const coding = url.searchParams.get('coding');
  const kind = url.searchParams.get('body');
  const source = kind === 'random' ? random : kind === 'big' ? big : plain;
  let body;
  if (coding === 'raw-deflate') body = zlib.deflateRawSync(source);
  else if (coding === 'gzip, br') body = zlib.brotliCompressSync(zlib.gzipSync(source));
  else if (coding === 'corrupt') body = Buffer.from('definitely not gzip');
  else if (coding === 'bomb') body = zlib.gzipSync(Buffer.alloc(8 * 1048576));
  else if (coding === 'empty' || coding === 'unknown') body = Buffer.alloc(0);
  else body = encoders[coding](source);
  if (coding === 'unknown') body = Buffer.from('opaque');
  const header =
    coding === 'raw-deflate'
      ? 'deflate'
      : coding === 'corrupt' || coding === 'bomb' || coding === 'empty'
        ? 'gzip'
        : coding === 'unknown'
          ? 'compress'
          : coding;
  res.writeHead(200, {
    'content-type': 'application/json',
    'content-encoding': header,
    'content-length': body.length,
    'x-accept-encoding': req.headers['accept-encoding'] ?? '',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}

for (const tls of [false, true]) {
  const protocol = tls ? 'H2' : 'H1';
  test(`B-12: gzip, deflate, br and zstd bodies are decoded for every reader over ${protocol}`, () =>
    withServer(
      async (s) => {
        const c = createClient({ ca: s.ca });
        try {
          for (const coding of [...Object.keys(encoders), 'raw-deflate', 'gzip, br']) {
            for (const body of ['plain', 'random']) {
              const expected = body === 'random' ? random : plain;
              const url = `${s.url}/z?coding=${encodeURIComponent(coding)}&body=${body}`;
              const r = await c.get(url);
              assert.equal(r.decoded, true, coding);
              assert.equal(r.headers.get('content-encoding'), null);
              assert.equal(r.headers.get('content-length'), null);
              assert.equal(r.headers.get('content-type'), 'application/json');
              assert.equal(
                r.originalHeaders.get('content-encoding'),
                coding === 'raw-deflate' ? 'deflate' : coding,
              );
              assert.notEqual(r.originalHeaders.get('content-length'), null);
              assert.deepEqual(Buffer.from(await r.bytes()), expected, `${coding} bytes()`);
              assert.equal(r.bodyState, 'consumed');
              assert.deepEqual(
                await collect((await c.get(url)).body),
                expected,
                `${coding} iterator`,
              );
              assert.deepEqual(
                await collect((await c.get(url)).body.toWebStream()),
                expected,
                `${coding} web stream`,
              );
            }
          }
          const json = await (await c.get(`${s.url}/z?coding=gzip`)).json();
          assert.equal(json.hello, 'world');
          assert.equal(c.getStats().activeOperations, 0);
        } finally {
          await c.close();
        }
      },
      { tls, route: compressionRoute },
    ));
}

test('B-12: explicit accept-encoding, decompress:false, HEAD and unknown codings keep bytes', () =>
  withServer(
    async (s) => {
      const gz = zlib.gzipSync(plain);
      const c = createClient();
      const raw = createClient({ decompress: false });
      const explicit = createClient({ headers: { 'accept-encoding': 'gzip' } });
      try {
        for (const r of [
          await c.get(`${s.url}/z?coding=gzip`, { headers: { 'accept-encoding': 'gzip' } }),
          await c.get(`${s.url}/z?coding=gzip`, { decompress: false }),
          await raw.get(`${s.url}/z?coding=gzip`),
          await explicit.get(`${s.url}/z?coding=gzip`),
        ]) {
          assert.equal(r.decoded, false);
          assert.equal(r.headers, r.originalHeaders);
          assert.equal(r.headers.get('content-encoding'), 'gzip');
          assert.deepEqual(Buffer.from(await r.bytes()), gz);
        }
        // A request may enable decoding that its client disabled.
        const enabled = await raw.get(`${s.url}/z?coding=gzip`, { decompress: true });
        assert.equal(enabled.decoded, true);
        assert.deepEqual(Buffer.from(await enabled.bytes()), plain);
        const head = await c.head(`${s.url}/z?coding=gzip`);
        assert.equal(head.decoded, false);
        assert.equal(head.headers.get('content-encoding'), 'gzip');
        assert.equal((await head.bytes()).byteLength, 0);
        const unknown = await c.get(`${s.url}/z?coding=unknown`);
        assert.equal(unknown.decoded, false);
        assert.equal(await unknown.text(), 'opaque');
        const empty = await c.get(`${s.url}/z?coding=empty`);
        assert.equal(empty.decoded, true);
        assert.equal((await empty.bytes()).byteLength, 0);
        assert.equal((await collect((await c.get(`${s.url}/z?coding=empty`)).body)).byteLength, 0);
        await assert.rejects(c.get(`${s.url}/z?coding=gzip`, { decompress: 'yes' }), {
          code: 'ERR_INVALID_ARGUMENT',
        });
        assert.throws(() => createClient({ decompress: 1 }), { code: 'ERR_INVALID_ARGUMENT' });
      } finally {
        await Promise.all([c.close(), raw.close(), explicit.close()]);
      }
    },
    { route: compressionRoute },
  ));

test('B-12: corrupt input fails with ERR_DECODE; decoded limits stop decompression bombs', () =>
  withServer(
    async (s) => {
      const c = createClient();
      try {
        const corrupt = await c.get(`${s.url}/z?coding=corrupt`);
        await assert.rejects(corrupt.text(), { code: 'ERR_DECODE', phase: 'decode' });
        assert.equal(corrupt.bodyState, 'errored');
        await assert.rejects(collect((await c.get(`${s.url}/z?coding=corrupt`)).body), {
          code: 'ERR_DECODE',
        });
        // 8 MiB of zeros compress to a few KiB.
        const bomb = await c.get(`${s.url}/z?coding=bomb`);
        await assert.rejects(bomb.bytes({ maxBytes: 1048576 }), { code: 'ERR_RESOURCE_LIMIT' });
        assert.equal(bomb.bodyState, 'errored');
        await assert.rejects(
          collect((await c.get(`${s.url}/z?coding=bomb`, { maxResponseBytes: 1048576 })).body),
          { code: 'ERR_RESOURCE_LIMIT' },
        );
        await assert.rejects(
          (await c.get(`${s.url}/z?coding=bomb`, { maxResponseBytes: 1048576 })).bytes(),
          { code: 'ERR_RESOURCE_LIMIT' },
        );
        assert.equal(
          (await (await c.get(`${s.url}/z?coding=bomb`)).bytes()).byteLength,
          8 * 1048576,
        );
        // Returning early from a decoded iterator disposes the response.
        const early = await c.get(`${s.url}/z?coding=gzip&body=big`);
        for await (const chunk of early.body) {
          assert(chunk.byteLength > 0);
          break;
        }
        assert.equal(early.bodyState, 'disposed');
        for (let i = 0; i < 100 && c.getStats().activeOperations; i++) await delay(5);
        assert.equal(c.getStats().activeOperations, 0);
      } finally {
        await c.close();
      }
    },
    { route: compressionRoute },
  ));

// L-19
test('L-19: get() joins repeated fields; Set-Cookie is only exposed as a list', async () => {
  const h = new ResponseHeaders([
    ['Vary', 'accept'],
    ['set-cookie', 'a=1; Expires=Wed, 21 Oct 2037 07:28:00 GMT'],
    ['vary', 'origin'],
    ['set-cookie', 'b=2'],
  ]);
  assert.equal(h.get('vary'), 'accept, origin');
  assert.equal(h.get('VARY'), 'accept, origin');
  assert.deepEqual(h.getAll('vary'), ['accept', 'origin']);
  assert.equal(h.get('set-cookie'), 'a=1; Expires=Wed, 21 Oct 2037 07:28:00 GMT');
  assert.deepEqual(h.getSetCookie(), ['a=1; Expires=Wed, 21 Oct 2037 07:28:00 GMT', 'b=2']);
  assert.equal(h.get('missing'), null);
  assert.equal(h.has('Set-Cookie'), true);
  assert.equal(new ResponseHeaders([['x', '']]).has('x'), true);
  await withServer(async (s) => {
    const c = createClient({ cookies: false });
    try {
      const r = await c.get(`${s.url}/repeat`);
      assert.equal(r.headers.get('x-repeat'), 'first, second');
      assert.deepEqual(r.headers.getSetCookie(), ['a=1; Path=/', 'b=2; Path=/']);
      await r.dispose();
    } finally {
      await c.close();
    }
  });
});

// B-13
test('B-13: Set-Cookie limits apply to name+value (4096) and attribute values (1024)', () =>
  withServer(async (s) => {
    const c = createClient();
    try {
      const value = 'v'.repeat(4000);
      await c.cookies.setCookie(`n=${value}; Path=/; Comment=${'c'.repeat(900)}`, s.url);
      // Over-long attribute values are ignored, not fatal.
      await c.cookies.setCookie(`p=1; Path=/${'x'.repeat(2000)}`, s.url);
      const names = (await c.cookies.getCookies(s.url)).map((cookie) => cookie.name).sort();
      assert.deepEqual(names, ['n', 'p']);
      await assert.rejects(c.cookies.setCookie(`n=${'v'.repeat(4096)}`, s.url), {
        code: 'ERR_INVALID_COOKIE',
      });
      await assert.rejects(
        c.cookies.setCookie(`  ${'k'.repeat(2048)} = ${'v'.repeat(2049)}`, s.url),
        {
          code: 'ERR_INVALID_COOKIE',
        },
      );
      await assert.rejects(c.cookies.setCookie(`n=1; ${'a'.repeat(70000)}`, s.url), {
        code: 'ERR_INVALID_COOKIE',
      });
    } finally {
      await c.close();
    }
  }));

// B-14
test('B-14: one forbidden header set and limit for profile, client and request', async () => {
  const base = getProfile('omreq/custom-default');
  const withHeaders = (headers) => ({ ...JSON.parse(JSON.stringify(base)), headers });
  for (const [name, value] of [
    ['upgrade', 'h2c'],
    ['keep-alive', 'timeout=5'],
    ['proxy-connection', 'keep-alive'],
    ['te', 'gzip'],
    ['Cookie', 'a=1'],
    ['host', 'x'],
  ])
    assert.throws(() => defineProfile(withHeaders([[name, value]])), {
      code: 'ERR_PROFILE_INVALID',
    });
  defineProfile(withHeaders([['te', 'trailers']]));
  const many = Array.from({ length: 201 }, (_, i) => [`x-h${i}`, 'v']);
  assert.throws(() => defineProfile(withHeaders(many)), { code: 'ERR_PROFILE_INVALID' });
  for (const headers of [
    { upgrade: 'h2c' },
    { 'keep-alive': 'timeout=5' },
    { 'proxy-connection': 'close' },
    { te: 'gzip' },
    { 'transfer-encoding': 'chunked' },
    { cookie: ['a=1', 'b=2'] },
    [
      ['cookie', 'a=1'],
      ['Cookie', 'b=2'],
    ],
  ]) {
    assert.throws(() => createClient({ headers }), { code: 'ERR_INVALID_ARGUMENT' });
    const c = createClient();
    await assert.rejects(c.get('http://127.0.0.1:9/', { headers }), {
      code: 'ERR_INVALID_ARGUMENT',
    });
    await c.close();
  }
  await withServer(async (s) => {
    const c = createClient({ headers: { cookie: 'client=1' } });
    try {
      const echo = await (
        await c.get(`${s.url}/echo`, { headers: { te: 'trailers', cookie: 'request=1' } })
      ).json();
      assert.equal(echo.headers.te, 'trailers');
      assert.equal(echo.headers.cookie, 'request=1');
    } finally {
      await c.close();
    }
  });
});

// L-20
test('L-20: FormData keeps its boundary; content-type null removes the automatic value', () =>
  withServer(async (s) => {
    const c = createClient();
    try {
      const form = () => {
        const data = new FormData();
        data.append('a', '1');
        return data;
      };
      for (const type of ['multipart/form-data', 'multipart/form-data; boundary=wrong; x=y']) {
        const echo = await (
          await c.post(`${s.url}/echo`, { body: form(), headers: { 'content-type': type } })
        ).json();
        const match = /boundary=(----omreq-[0-9a-f]+)$/.exec(echo.headers['content-type']);
        assert(match, echo.headers['content-type']);
        assert(!echo.headers['content-type'].includes('wrong'));
        assert(decodeEcho(echo).toString().startsWith(`--${match[1]}\r\n`));
      }
      await assert.rejects(
        c.post(`${s.url}/echo`, { body: form(), headers: { 'content-type': 'text/plain' } }),
        { code: 'ERR_INVALID_ARGUMENT' },
      );
      for (const options of [
        { json: { a: 1 }, headers: { 'content-type': null } },
        { body: new Blob(['x'], { type: 'text/x-test' }), headers: { 'content-type': null } },
        { body: form(), headers: new Map([['content-type', null]]) },
      ]) {
        const echo = await (await c.post(`${s.url}/echo`, options)).json();
        assert.equal(echo.headers['content-type'], undefined);
      }
      const removed = createClient({ headers: { 'content-type': null } });
      try {
        const echo = await (await removed.post(`${s.url}/echo`, { json: 1 })).json();
        assert.equal(echo.headers['content-type'], undefined);
      } finally {
        await removed.close();
      }
    } finally {
      await c.close();
    }
  }));

// L-28
test('L-28: multipart keeps backslashes in filenames and strips only POSIX directories', () =>
  withServer(async (s) => {
    const c = createClient();
    try {
      const data = new FormData();
      data.append('f', new Blob(['x']), 'a\\b.txt');
      data.append('g', new Blob(['y']), '/tmp/dir/c.txt');
      const body = decodeEcho(await (await c.post(`${s.url}/echo`, { body: data })).json());
      assert(body.includes('name="f"; filename="a\\b.txt"'), body.toString());
      assert(body.includes('name="g"; filename="c.txt"'), body.toString());
    } finally {
      await c.close();
    }
  }));

// Reads the whole request body, then sends headers and keeps the body open.
function drainThenHold(req, res) {
  if (req.url !== '/drain-hold') return false;
  req.on('data', () => {});
  req.on('end', () => {
    res.writeHead(200);
    res.flushHeaders();
  });
  return true;
}
// Answers 413 shortly after the request headers, while the upload is waiting
// on its producer.
function earlyDelayed(req, res) {
  if (req.url !== '/early-delayed') return false;
  setTimeout(() => {
    res.writeHead(413);
    res.end('early');
  }, 50);
  return true;
}
// P-05
test('P-05: retained request budget is released at final headers, not at body end', () =>
  withServer(
    async (s) => {
      const c = createClient({ maxRetainedRequestBodyBytes: 3 * 1048576 });
      try {
        const body = Buffer.alloc(2 * 1048576, 1);
        const first = await c.post(`${s.url}/drain-hold`, { body });
        assert.equal(first.status, 200);
        assert.equal(c.getStats().retainedRequestBodyBytes, 0);
        // The first response body is still unread; a second large body fits.
        const second = await c.post(`${s.url}/drain-hold`, { body });
        assert.equal(c.getStats().retainedRequestBodyBytes, 0);
        await Promise.all([first.dispose(), second.dispose()]);
      } finally {
        await c.close();
      }
    },
    { route: drainThenHold },
  ));

// L-26
test('L-26: a hung async generator is closed once its pending step settles', () =>
  withServer(
    async (s) => {
      const c = createClient();
      let release;
      let closed = false;
      let lateYield = false;
      async function* source() {
        try {
          await new Promise((resolve) => {
            release = resolve;
          });
          lateYield = true;
          yield Buffer.from('late');
        } finally {
          closed = true;
        }
      }
      try {
        const r = await c.post(`${s.url}/early-delayed`, { body: source() });
        assert.equal(r.status, 413);
        assert.equal(await r.text(), 'early');
        const started = performance.now();
        await c.close();
        assert(performance.now() - started < 100, 'close does not wait for a hung producer');
        assert.equal(closed, false);
        release?.();
        for (let i = 0; i < 50 && !closed; i++) await delay(2);
        assert.equal(closed, true, 'the queued return() ran');
        assert.equal(lateYield, true);
      } finally {
        await c.close();
      }
    },
    { route: earlyDelayed },
  ));

// B-03 / L-29
test('B-03/L-29: large generated upload streams without retaining chunks', () =>
  withServer(async (s) => {
    const c = createClient();
    const total = 256 * 1048576;
    const gc = () => globalThis.Bun?.gc(true) ?? globalThis.gc?.();
    try {
      // Views with offsets are sent as-is without a JS copy.
      const backing = new Uint8Array(16);
      backing.set([1, 2, 3, 4], 6);
      const echo = await (
        await c.post(`${s.url}/echo`, {
          body: (async function* () {
            yield backing.subarray(6, 10);
            yield new Uint8Array(backing.buffer, 7, 2);
          })(),
        })
      ).json();
      assert.deepEqual([...decodeEcho(echo)], [1, 2, 3, 4, 2, 3]);
      gc();
      const before = process.memoryUsage().rss;
      const r = await c.post(`${s.url}/count`, {
        body: (async function* () {
          for (let sent = 0; sent < total; sent += 65536)
            yield new Uint8Array(65536).fill(sent & 255);
        })(),
      });
      assert.equal((await r.json()).length, total);
      gc();
      const grown = process.memoryUsage().rss - before;
      // The former per-read Promise.race retained every chunk under Bun.
      if (isBun) assert(grown < 128 * 1048576, `RSS grew by ${grown} bytes`);
    } finally {
      await c.close();
    }
  }));

// D-05
test('D-05: the package version comes from package.json', () => {
  const pkg = JSON.parse(
    readFileSync(new URL('../packages/omreq/package.json', import.meta.url), 'utf8'),
  );
  assert.equal(getRuntimeInfo().packageVersion, pkg.version);
});
