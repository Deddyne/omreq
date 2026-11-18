import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from '../fixtures/server.mjs';
import { createClient, defineProfile, getProfile } from '../packages/omreq/dist/index.mjs';

function routes() {
  const entries = new Map(),
    seen = [];
  return {
    entries,
    seen,
    route(req, res) {
      seen.push({ path: req.url, method: req.method, headers: req.headers });
      const rule = entries.get(req.url);
      if (!rule) return false;
      req.resume();
      const send = () => {
        if (res.destroyed) return;
        res.writeHead(
          rule.status ?? 302,
          rule.location === undefined ? {} : { location: rule.location },
        );
        if (rule.hold) res.write('unbounded intermediate body');
        else res.end('redirect body');
      };
      if (rule.delay) {
        const timer = setTimeout(send, rule.delay);
        res.on('close', () => clearTimeout(timer));
      } else send();
      return true;
    },
  };
}
for (const tls of [false, true])
  test(`T11: redirect method/body policy and immutable history over ${tls ? 'H2' : 'H1'}`, async () => {
    const table = routes();
    const s = await fixture({ tls, route: table.route });
    const c = createClient({ ca: s.ca });
    try {
      for (const status of [301, 302, 303, 307, 308])
        for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH']) {
          const path = `/r/${status}/${method}`;
          table.entries.set(path, { status, location: '/echo?hop=1#removed' });
          const hasBody = !['GET', 'HEAD'].includes(method);
          const drops =
            (status === 303 && hasBody) || ([301, 302].includes(status) && method === 'POST');
          const response = await c.request(s.url + path, {
            method,
            ...(hasBody
              ? {
                  body: 'immutable bytes',
                  headers: { 'content-type': 'application/test', 'content-encoding': 'identity' },
                }
              : {}),
          });
          assert.equal(response.httpVersion, tls ? '2' : '1.1');
          assert.equal(response.url, `${s.url}/echo?hop=1`);
          assert.deepEqual(response.redirects, [
            {
              status,
              fromUrl: s.url + path,
              toUrl: `${s.url}/echo?hop=1`,
              methodBefore: method,
              methodAfter: drops ? 'GET' : method,
            },
          ]);
          assert(Object.isFrozen(response.redirects));
          assert(Object.isFrozen(response.redirects[0]));
          let echo;
          if (method === 'HEAD') {
            await response.bytes();
            echo = table.seen.at(-1);
          } else echo = await response.json();
          assert.equal(echo.method, drops ? 'GET' : method);
          if (method !== 'HEAD') {
            assert.equal(
              Buffer.from(echo.body, 'base64').toString(),
              hasBody && !drops ? 'immutable bytes' : '',
            );
            if (hasBody && drops)
              for (const name of ['content-type', 'content-encoding', 'content-length'])
                assert.equal(echo.headers[name], undefined);
          }
        }
      const before = c.getStats().completed;
      table.entries.set('/json', { status: 307, location: '/again' });
      table.entries.set('/again', { status: 308, location: '/echo' });
      const payload = { value: 1 };
      const pending = c.post(`${s.url}/json`, { json: payload });
      payload.value = 2;
      const response = await pending;
      // Over H1 the small final body has a Content-Length and arrives with the
      // headers, so the chain has already released its slot. The H2 fixture
      // sends no length, so that body stays streamed and holds the slot.
      assert.equal(c.getStats().activeOperations, tls ? 1 : 0);
      assert.equal(response.redirects.length, 2);
      assert.equal(Buffer.from((await response.json()).body, 'base64').toString(), '{"value":1}');
      assert.equal(c.getStats().completed, before + 1, 'One operation owns the complete chain');
    } finally {
      await c.close();
      await s.close();
    }
  });

test('T11: modes, invalid locations, relative URLs, redirect limits and intermediate disposal', async () => {
  const table = routes();
  const s = await fixture({ route: table.route });
  const c = createClient();
  try {
    table.entries.set('/manual', { status: 307, location: '/echo' });
    const manual = await c.post(`${s.url}/manual`, { body: 'data', redirect: 'manual' });
    assert.equal(manual.status, 307);
    assert.equal(await manual.text(), 'redirect body');
    assert.deepEqual(manual.redirects, []);
    await assert.rejects(c.get(`${s.url}/manual`, { redirect: 'error' }), {
      code: 'ERR_REDIRECT_DISALLOWED',
      phase: 'headers',
    });
    for (const [path, status, location] of [
      ['/no-location', 302, undefined],
      ['/empty-location', 302, ''],
      ['/not-redirect', 300, '/echo'],
    ]) {
      table.entries.set(path, { status, location });
      const r = await c.get(s.url + path);
      assert.equal(r.status, status);
      assert.deepEqual(r.redirects, []);
      await r.dispose();
    }
    for (const location of [
      'https://[',
      'file:///secret',
      'https://user:password@example.test',
      ['/a', '/b'],
    ]) {
      table.entries.set('/invalid', { location });
      await assert.rejects(c.get(`${s.url}/invalid`), {
        code: 'ERR_REDIRECT_URL',
        phase: 'headers',
      });
    }
    table.entries.set('/nested/start', { location: '../echo?q=1#fragment' });
    assert.equal((await (await c.get(`${s.url}/nested/start`)).json()).url, '/echo?q=1');
    table.entries.set('/loop', { location: '/loop' });
    const before = table.seen.length;
    await assert.rejects(c.get(`${s.url}/loop`), { code: 'ERR_REDIRECT_LIMIT' });
    assert.equal(table.seen.length - before, 11);
    await assert.rejects(c.get(`${s.url}/manual`, { maxRedirects: 0 }), {
      code: 'ERR_REDIRECT_LIMIT',
    });
    table.entries.set('/hold', { location: '/echo', hold: true });
    const bounded = await c.get(`${s.url}/hold`, { timeouts: { totalMs: 1500 } });
    assert.equal((await bounded.json()).url, '/echo');
    assert.equal(c.getStats().activeOperations, 0);
    assert.equal(c.getStats().openBodies, 0);
  } finally {
    await c.close();
    await s.close();
  }
});

test('T11: cross-origin secret removal is sticky across defaults and the return hop', async () => {
  const aTable = routes(),
    bTable = routes();
  const a = await fixture({ route: aTable.route }),
    b = await fixture({ route: bTable.route });
  const profile = JSON.parse(JSON.stringify(getProfile('omreq/custom-default')));
  profile.headers.push(['x-profile-secret', 'profile-secret']);
  const sensitive = ['X-Client-Secret', 'X-Profile-Secret'];
  const c = createClient({
    profile: defineProfile(profile),
    headers: {
      authorization: 'client-secret',
      cookie: 'explicit=secret',
      referer: 'https://private.test/path',
      'x-client-secret': 'c',
      'x-public': 'public',
    },
    sensitiveHeaders: sensitive,
  });
  sensitive.length = 0;
  try {
    aTable.entries.set('/same', { location: '/echo' });
    const same = await (await c.get(`${a.url}/same`)).json();
    assert.equal(same.headers.authorization, 'client-secret');
    assert.equal(same.headers.cookie, 'explicit=secret');
    aTable.entries.set('/start', { location: `${b.url}/middle` });
    bTable.entries.set('/middle', { location: `${a.url}/echo` });
    const names = ['X-Request-Secret'];
    const options = {
      headers: { authorization: 'request-secret', 'x-request-secret': 'r' },
      sensitiveHeaders: names,
    };
    const pending = c.get(`${a.url}/start`, options);
    names.length = 0;
    const response = await pending;
    assert.equal(response.redirects.length, 2);
    const echo = await response.json();
    const first = aTable.seen.find((q) => q.path === '/start');
    assert.equal(first.headers.authorization, 'request-secret');
    for (const headers of [bTable.seen[0].headers, echo.headers]) {
      for (const name of [
        'authorization',
        'cookie',
        'referer',
        'x-client-secret',
        'x-profile-secret',
        'x-request-secret',
      ])
        assert.equal(headers[name], undefined, `${name} must stay removed`);
      assert.equal(headers['x-public'], 'public');
    }
  } finally {
    await c.close();
    await Promise.all([a.close(), b.close()]);
  }
});

test('T11/T07: one-shot replay fails; POST to GET stops an early hung upload before final headers', async () => {
  const table = routes();
  const s = await fixture({ route: table.route });
  const c = createClient();
  try {
    for (const status of [301, 302, 303, 307, 308])
      table.entries.set(`/r/${status}`, { status, location: '/echo' });
    for (const status of [307, 308]) {
      const source = {
        async *[Symbol.asyncIterator]() {
          yield Buffer.from('one-shot');
        },
      };
      await assert.rejects(c.post(`${s.url}/r/${status}`, { body: source }), {
        code: 'ERR_BODY_NOT_REPLAYABLE',
        phase: 'headers',
      });
    }
    let returns = 0,
      nexts = 0;
    const source = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            nexts++;
            return new Promise(() => {});
          },
          return() {
            returns++;
            return new Promise(() => {});
          },
        };
      },
    };
    // The destination waits while native upload-stop must wake a pending JS next().
    table.entries.set('/early', { status: 303, location: '/delayed-final' });
    table.entries.set('/delayed-final', { status: 302, location: '/echo', delay: 150 });
    const response = await c.post(`${s.url}/early`, { body: source, timeouts: { totalMs: 1500 } });
    assert(nexts <= 1);
    assert.equal(returns, nexts, 'Acquired iterator is cleaned before later hop headers');
    assert.equal((await response.json()).method, 'GET');
    let lateReject;
    const late = {
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            new Promise((_, reject) => {
              lateReject = reject;
            }),
          return: async () => ({ done: true }),
        };
      },
    };
    const waiting = c.post(`${s.url}/early`, { body: late });
    await new Promise((resolve) => setTimeout(resolve, 50));
    lateReject?.(Error('late source error after upload-stop'));
    assert.equal((await (await waiting).json()).method, 'GET');
    assert.equal(c.getStats().activeOperations, 0);
  } finally {
    await c.close();
    await s.close();
  }
});

test('T11/T17: chain total deadline, abort and operation slot survive hop changes', async () => {
  const table = routes();
  const s = await fixture({ route: table.route });
  const c = createClient({ maxActiveOperations: 1 });
  try {
    for (let i = 0; i < 5; i++)
      table.entries.set(`/delay/${i}`, { location: `/delay/${i + 1}`, delay: 40 });
    await assert.rejects(c.get(`${s.url}/delay/0`, { timeouts: { totalMs: 100, headersMs: 75 } }), {
      code: 'ERR_TIMEOUT',
    });
    table.entries.set('/waiting', { location: '/headers-wait' });
    const reached = s.wait('/headers-wait');
    const controller = new AbortController();
    const waiting = c.get(`${s.url}/waiting`, { signal: controller.signal });
    await reached;
    controller.abort('user reason');
    await assert.rejects(waiting, { code: 'ERR_ABORTED' });
    // A streamed body keeps the operation slot until it is consumed or disposed.
    table.entries.set('/start', { location: '/stream' });
    const first = await c.get(`${s.url}/start`);
    const second = c.get(`${s.url}/echo`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(c.getStats().activeOperations, 1);
    assert.equal(c.getStats().queuedOperations, 1);
    await first.dispose();
    await (await second).bytes();
    assert.equal(c.getStats().activeOperations, 0);
  } finally {
    await c.close();
    await s.close();
  }
});

test('T11/T14: HTTPS downgrade requires explicit policy and strips credentials', async () => {
  const table = routes();
  const plain = await fixture();
  const secure = await fixture({ tls: true, route: table.route });
  const c = createClient({
    ca: secure.ca,
    headers: { authorization: 'secret', referer: secure.url },
  });
  try {
    table.entries.set('/downgrade', { location: `${plain.url}/echo` });
    await assert.rejects(c.get(`${secure.url}/downgrade`), { code: 'ERR_REDIRECT_DISALLOWED' });
    const echo = await (
      await c.get(`${secure.url}/downgrade`, { allowInsecureRedirects: true })
    ).json();
    assert.equal(echo.headers.authorization, undefined);
    assert.equal(echo.headers.referer, undefined);
    assert.equal(echo.url, '/echo');
  } finally {
    await c.close();
    await Promise.all([plain.close(), secure.close()]);
  }
});

test('T11: invalid redirect policies fail before native initialization', async () => {
  for (const option of [
    { redirect: 'other' },
    { maxRedirects: 11 },
    { maxRedirects: -1 },
    { maxRedirects: 1.5 },
    { allowInsecureRedirects: 1 },
    { sensitiveHeaders: ['bad name'] },
    { sensitiveHeaders: 'x-secret' },
  ]) {
    assert.throws(() => createClient(option), { code: 'ERR_INVALID_ARGUMENT' });
    const c = createClient();
    try {
      await assert.rejects(c.get('http://example.invalid', option), {
        code: 'ERR_INVALID_ARGUMENT',
      });
      assert.equal(c.getInfo().nativeReady, false);
    } finally {
      await c.close();
    }
  }
});
