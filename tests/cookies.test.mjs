import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from '../fixtures/server.mjs';
import { createClient } from '../packages/omreq/dist/index.mjs';

function cookiePairs(value) {
  return value === undefined ? [] : value.split('; ').sort();
}
function jarPairs(cookies) {
  return cookies.map(({ name, value }) => `${name}=${value}`).sort();
}
function redirect(res, location, cookies) {
  res.writeHead(307, { location, 'set-cookie': cookies });
  res.end('intermediate body');
}

test('T06/T12: automatic cookies share the complete request header count and byte limits', async () => {
  const s = await fixture();
  const c = createClient();
  try {
    await c.cookies.setCookie(`a=${'a'.repeat(3500)}; Path=/`, s.url);
    await c.cookies.setCookie(`b=${'b'.repeat(3500)}; Path=/`, s.url);
    await assert.rejects(c.get(`${s.url}/echo`, { headers: { 'x-large': 'x'.repeat(60000) } }), {
      code: 'ERR_RESOURCE_LIMIT',
      phase: 'configuration',
    });
    const headers = Object.fromEntries(Array.from({ length: 198 }, (_, i) => [`x-h${i}`, 'v']));
    await assert.rejects(c.get(`${s.url}/echo`, { headers }), {
      code: 'ERR_RESOURCE_LIMIT',
      phase: 'configuration',
    });
    assert.equal(s.stats.connections, 0);
    assert.equal(c.getStats().activeOperations, 0);
    assert.equal(c.getStats().nativeTasks, 0);
  } finally {
    await c.close();
    await s.close();
  }
});

for (const tls of [false, true]) {
  const protocol = tls ? 'H2' : 'H1';
  test(`T11/T12: ${protocol} redirect cookies are stored before the next hop and isolated per client`, async () => {
    const server = await fixture({
      tls,
      route(req, res) {
        if (req.url === '/set-and-redirect') {
          req.resume();
          redirect(res, '/echo', ['sid=redirect; Path=/; HttpOnly', 'pref=dark; Path=/echo']);
          return true;
        }
        if (req.url === '/manual-cookie') {
          req.resume();
          redirect(res, '/echo', ['manual=saved; Path=/']);
          return true;
        }
        return false;
      },
    });
    const client = createClient({ ca: server.ca, timeouts: { totalMs: 5000 } });
    const other = createClient({ ca: server.ca, timeouts: { totalMs: 5000 } });
    try {
      const response = await client.post(`${server.url}/set-and-redirect`, { body: 'snapshot' });
      assert.equal(response.httpVersion, tls ? '2' : '1.1');
      assert.equal(response.redirects.length, 1);
      const echo = await response.json();
      assert.equal(Buffer.from(echo.body, 'base64').toString(), 'snapshot');
      assert.equal(echo.headers.cookie, 'pref=dark; sid=redirect', 'Longer paths sort first');
      const records = await client.cookies.getCookies(`${server.url}/echo`);
      assert.deepEqual(jarPairs(records), ['pref=dark', 'sid=redirect']);
      const sid = records.find(({ name }) => name === 'sid');
      assert.equal(sid.hostOnly, true);
      assert.equal(sid.httpOnly, true);
      assert.equal(sid.path, '/');
      assert.equal(sid.domain, '127.0.0.1');
      assert.deepEqual(jarPairs(await client.cookies.getCookies(`${server.url}/elsewhere`)), [
        'sid=redirect',
      ]);
      const isolated = await (await other.get(`${server.url}/echo`)).json();
      assert.equal(isolated.headers.cookie, undefined);
      assert.equal(other.getStats().cookieCount, 0);
      const manual = await client.get(`${server.url}/manual-cookie`, { redirect: 'manual' });
      assert.equal(manual.status, 307);
      assert.deepEqual(manual.headers.getAll('set-cookie'), ['manual=saved; Path=/']);
      assert.deepEqual(manual.redirects, []);
      assert(
        (await client.cookies.getCookies(`${server.url}/echo`)).some(
          ({ name, value }) => name === 'manual' && value === 'saved',
        ),
        'Storage happens on headers even when the application does not consume a redirect body',
      );
      await manual.dispose();
      assert.equal(client.getStats().cookieCount, 3);
      assert(client.getStats().cookieBytes > 0);
      assert.equal(client.getStats().activeOperations, 0);
    } finally {
      await Promise.all([client.close(), other.close()]);
      await server.close();
    }
    assert.equal(client.getStats().cookieCount, 0);
    assert.equal(client.getStats().cookieBytes, 0);
  });

  test(`T11/T12: ${protocol} explicit Cookie overrides the jar until a cross-origin hop recalculates scope`, async () => {
    const seen = [];
    let destination;
    const first = await fixture({
      tls,
      route(req, res) {
        if (req.url === '/same' || req.url === '/cross') {
          seen.push({ path: req.url, cookie: req.headers.cookie });
          req.resume();
          redirect(res, req.url === '/same' ? '/echo' : `${destination}/return`, [
            'fromFirst=a; Path=/',
          ]);
          return true;
        }
        return false;
      },
    });
    const second = await fixture({
      tls,
      route(req, res) {
        if (req.url !== '/return') return false;
        seen.push({ path: '/return', cookie: req.headers.cookie });
        req.resume();
        redirect(res, `${first.url}/echo`, ['fromSecond=b; Path=/']);
        return true;
      },
    });
    destination = second.url;
    const client = createClient({
      ca: tls ? first.ca + second.ca : undefined,
      headers: { cookie: 'explicit=private' },
      timeouts: { totalMs: 5000 },
    });
    try {
      await client.cookies.setCookie('jar=stored; Path=/', first.url);
      const same = await (await client.get(`${first.url}/same`)).json();
      assert.equal(same.headers.cookie, 'explicit=private');
      const cross = await client.get(`${first.url}/cross`);
      assert.equal(cross.redirects.length, 2);
      const echo = await cross.json();
      assert.equal(seen.find(({ path }) => path === '/cross').cookie, 'explicit=private');
      assert.deepEqual(
        cookiePairs(seen.find(({ path }) => path === '/return').cookie),
        ['fromFirst=a', 'jar=stored'],
        'Cookies are scoped by host/path, so a different port can receive eligible jar cookies',
      );
      assert.deepEqual(cookiePairs(echo.headers.cookie), [
        'fromFirst=a',
        'fromSecond=b',
        'jar=stored',
      ]);
      assert(
        !echo.headers.cookie.includes('explicit'),
        'Explicit credentials stay removed on return',
      );
      const hostAlias = new URL(first.url);
      hostAlias.hostname = 'localhost';
      assert.deepEqual(await client.cookies.getCookies(hostAlias.href), []);
    } finally {
      await client.close();
      await Promise.all([first.close(), second.close()]);
    }
  });
}

test('T12: cookie API enforces domain/PSL/path/Secure/expiry rules without network requests', async () => {
  const client = createClient();
  try {
    await client.cookies.setCookie('host=one; Path=/', 'https://a.example.com/');
    await client.cookies.setCookie(
      'domain=two; Domain=.example.com; Path=/',
      'https://a.example.com/',
    );
    await client.cookies.setCookie('default=three', 'https://a.example.com/account/create');
    await client.cookies.setCookie(
      'secure=four; Secure; SameSite=None; Path=/',
      'https://a.example.com/',
    );
    assert.deepEqual(jarPairs(await client.cookies.getCookies('https://b.example.com/')), [
      'domain=two',
    ]);
    assert.deepEqual(
      jarPairs(await client.cookies.getCookies('http://a.example.com/account/view')),
      ['default=three', 'domain=two', 'host=one'],
    );
    assert.deepEqual(
      jarPairs(await client.cookies.getCookies('https://a.example.com/accounting')),
      ['domain=two', 'host=one', 'secure=four'],
    );
    assert.deepEqual(await client.cookies.getCookies('https://example.net/'), []);
    await client.cookies.setCookie('gone=value; Path=/', 'https://a.example.com/');
    await client.cookies.setCookie('gone=value; Path=/; Max-Age=0', 'https://a.example.com/');
    assert(
      !(await client.cookies.getCookies('https://a.example.com/')).some(
        ({ name }) => name === 'gone',
      ),
    );
    await client.cookies.setCookie(
      'age=priority; Max-Age=60; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/',
      'https://a.example.com/',
    );
    assert(
      (await client.cookies.getCookies('https://a.example.com/')).some(
        ({ name }) => name === 'age',
      ),
    );
    for (const [cookie, url] of [
      ['bad=secret; Domain=com', 'https://example.com/'],
      ['bad=secret; Domain=co.uk', 'https://example.co.uk/'],
      ['bad=secret; Domain=github.io', 'https://project.github.io/'],
      ['bad=secret; Domain=other.com', 'https://example.com/'],
      ['bad=secret; Secure', 'http://example.com/'],
      ['bad=secret; SameSite=None', 'https://example.com/'],
      ['__Host-bad=secret; Secure; Path=/wrong', 'https://example.com/'],
      ['__Secure-bad=secret', 'https://example.com/'],
    ]) {
      await assert.rejects(client.cookies.setCookie(cookie, url), (error) => {
        assert.equal(error.code, 'ERR_INVALID_COOKIE');
        assert.equal(error.phase, 'configuration');
        assert(!error.message.includes('secret'));
        return true;
      });
    }
    for (const url of ['file:///tmp/private', 'https://user:password@example.com/'])
      await assert.rejects(client.cookies.getCookies(url), { code: 'ERR_INVALID_ARGUMENT' });
    assert.equal(client.getStats().activeOperations, 0);
    await client.cookies.clear();
    assert.equal(client.getStats().cookieCount, 0);
    assert.equal(client.getStats().cookieBytes, 0);
  } finally {
    await client.close();
  }
});

test('T12: cookies:false disables jar API/storage/send and permits an explicit Cookie header', async () => {
  const server = await fixture();
  const client = createClient({ cookies: false });
  try {
    await assert.rejects(client.cookies.setCookie('a=1', server.url), {
      code: 'ERR_INVALID_ARGUMENT',
    });
    await assert.rejects(client.cookies.getCookies(server.url), { code: 'ERR_INVALID_ARGUMENT' });
    await assert.rejects(client.cookies.clear(), { code: 'ERR_INVALID_ARGUMENT' });
    const repeated = await client.get(`${server.url}/repeat`);
    assert.equal(repeated.headers.getAll('set-cookie').length, 2);
    await repeated.text();
    assert.equal((await (await client.get(`${server.url}/echo`)).json()).headers.cookie, undefined);
    const explicit = await (
      await client.get(`${server.url}/echo`, { headers: { cookie: 'manual=yes' } })
    ).json();
    assert.equal(explicit.headers.cookie, 'manual=yes');
    assert.equal(client.getStats().cookieCount, 0);
    assert.equal(client.getStats().cookieBytes, 0);
  } finally {
    await client.close();
    await server.close();
  }
  for (const cookies of [0, 'true', null, {}])
    assert.throws(() => createClient({ cookies }), { code: 'ERR_INVALID_ARGUMENT' });
});

test('T12: concurrent API/response updates are isolated and keep all accepted cookie records', async () => {
  const server = await fixture({
    route(req, res) {
      const match = /^\/set\/(\d+)$/.exec(req.url);
      if (!match) return false;
      req.resume();
      res.setHeader('set-cookie', `response${match[1]}=${match[1]}; Path=/`);
      res.end('stored');
      return true;
    },
  });
  const client = createClient({ timeouts: { totalMs: 5000 } });
  const other = createClient();
  try {
    assert.equal(client.getInfo().nativeReady, false);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        client.cookies.setCookie(`api${i}=${i}; Path=/`, server.url),
      ),
    );
    await Promise.all(
      Array.from({ length: 20 }, async (_, i) =>
        (await client.get(`${server.url}/set/${i}`)).text(),
      ),
    );
    const cookies = await client.cookies.getCookies(server.url);
    assert.equal(cookies.length, 40);
    for (let i = 0; i < 20; i++) {
      assert(cookies.some(({ name, value }) => name === `api${i}` && value === String(i)));
      assert(cookies.some(({ name, value }) => name === `response${i}` && value === String(i)));
    }
    assert.deepEqual(await other.cookies.getCookies(server.url), []);
    assert.equal(client.getStats().cookieCount, 40);
    assert.equal(client.getStats().activeOperations, 0);
    const copy = await client.cookies.getCookies(server.url);
    assert.deepEqual(jarPairs(copy), jarPairs(cookies));
    await client.cookies.clear();
    assert.equal(cookies.length, 40, 'Earlier API snapshots survive store mutations');
    assert.deepEqual(await client.cookies.getCookies(server.url), []);
  } finally {
    await Promise.all([client.close(), other.close()]);
    await server.close();
  }
  assert.equal(client.getStats().cookieCount, 0);
  assert.equal(client.getStats().cookieBytes, 0);
  await assert.rejects(client.cookies.getCookies(server.url), { code: 'ERR_CLIENT_CLOSED' });
});

test('T12: per-domain capacity is exposed through bounded count/bytes and eviction diagnostics', async () => {
  const client = createClient();
  try {
    for (let i = 0; i < 181; i++)
      await client.cookies.setCookie(`c${i}=value; Path=/`, 'https://example.com/');
    const cookies = await client.cookies.getCookies('https://example.com/');
    assert.equal(cookies.length, 180);
    assert(!cookies.some(({ name }) => name === 'c0'));
    assert(cookies.some(({ name }) => name === 'c180'));
    const stats = client.getStats();
    assert.equal(stats.cookieCount, 180);
    assert(stats.cookieBytes > 0 && stats.cookieBytes <= 12 * 1024 * 1024);
    assert.equal(stats.evictedCookies, 1);
    await client.cookies.clear();
    assert.equal(client.getStats().cookieCount, 0);
    assert.equal(client.getStats().cookieBytes, 0);
    assert.equal(client.getStats().evictedCookies, 1, 'Diagnostics are cumulative after clear');
  } finally {
    await client.close();
  }
});

test('T12: discarded and Partitioned Set-Cookie fields do not fail the response or become ordinary cookies', async () => {
  const server = await fixture({
    tls: true,
    route(req, res) {
      if (req.url !== '/cookies') return false;
      req.resume();
      res.setHeader('set-cookie', [
        'valid=ok; Path=/',
        'partitioned=private; Secure; Partitioned; Path=/',
        'invalid=private; Domain=com; Path=/',
      ]);
      res.end('successful response');
      return true;
    },
  });
  const client = createClient({ ca: server.ca });
  try {
    const response = await client.get(`${server.url}/cookies`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.getAll('set-cookie').length, 3);
    assert.equal(await response.text(), 'successful response');
    assert.deepEqual(jarPairs(await client.cookies.getCookies(server.url)), ['valid=ok']);
    const echo = await (await client.get(`${server.url}/echo`)).json();
    assert.equal(echo.headers.cookie, 'valid=ok');
    const stats = client.getStats();
    assert.equal(stats.cookieCount, 1);
    assert.equal(stats.partitionedCookies, 1);
    assert.equal(stats.discardedCookies, 2);
    await client.cookies.clear();
    assert.equal(client.getStats().cookieCount, 0);
    assert.equal(client.getStats().cookieBytes, 0);
    assert.equal(client.getStats().partitionedCookies, 1);
    assert.equal(client.getStats().discardedCookies, 2);
  } finally {
    await client.close();
    await server.close();
  }
});
