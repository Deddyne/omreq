// Audit fixes owned by the native core: redirect Location decoding (L-01),
// request-body headers on dropped bodies (L-02), profile validation of HTTP/2
// windows (L-15/P-03), TLS cipher/version consistency (L-17) and the shared
// transport-managed header rules (B-14).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fixture } from '../fixtures/server.mjs';
import { checkProfile, createClient } from '../packages/omreq/dist/index.mjs';

const profileText = readFileSync(new URL('../profiles/neutral.json', import.meta.url), 'utf8');
const custom = (mutate) => {
  const p = JSON.parse(profileText);
  mutate(p);
  return p;
};

test('L-01: a raw UTF-8 Location is decoded as UTF-8, other octets as Latin-1', async () => {
  const seen = [];
  const s = await fixture({
    route(req, res) {
      seen.push(req.url);
      const raw = {
        '/utf8': Buffer.from('/café?q=é', 'utf8').toString('latin1'),
        '/latin1': '/café',
      }[req.url];
      if (raw !== undefined) {
        res.writeHead(302, { location: raw });
        res.end();
        return true;
      }
      if (req.url.startsWith('/caf')) {
        res.end('ok');
        return true;
      }
      return false;
    },
  });
  const c = createClient();
  try {
    const utf8 = await c.request(`${s.url}/utf8`);
    assert.equal(utf8.url, `${s.url}/caf%C3%A9?q=%C3%A9`);
    assert.equal(await utf8.text(), 'ok');
    const latin1 = await c.request(`${s.url}/latin1`);
    assert.equal(latin1.url, `${s.url}/caf%C3%A9`);
    await latin1.text();
    assert.deepEqual(seen, ['/utf8', '/caf%C3%A9?q=%C3%A9', '/latin1', '/caf%C3%A9']);
  } finally {
    await c.close();
    await s.close();
  }
});

test('L-02: a redirect that drops the body removes every request-body header', async () => {
  let final;
  const s = await fixture({
    route(req, res) {
      req.resume();
      if (req.url === '/see-other') {
        res.writeHead(303, { location: '/done' });
        res.end();
        return true;
      }
      if (req.url === '/done') {
        final = req.headers;
        res.end('ok');
        return true;
      }
      return false;
    },
  });
  const c = createClient();
  try {
    const response = await c.request(`${s.url}/see-other`, {
      method: 'POST',
      body: 'payload',
      headers: {
        'content-type': 'text/plain',
        'content-language': 'en',
        'content-location': '/doc',
        'content-encoding': 'identity',
        'x-kept': '1',
      },
    });
    await response.text();
    for (const name of [
      'content-type',
      'content-language',
      'content-location',
      'content-encoding',
      'content-length',
    ])
      assert.equal(final[name], undefined, name);
    assert.equal(final['x-kept'], '1');
  } finally {
    await c.close();
    await s.close();
  }
});

test('L-15/P-03: zero stream windows are rejected; custom profiles get an adaptive window', async () => {
  for (const http2 of [
    { initialWindowSize: 0 },
    { settings: [{ name: 'initialWindowSize', value: 0 }] },
  ])
    await assert.rejects(
      checkProfile(
        custom((p) => {
          p.transport.http2 = http2;
        }),
      ),
      /ERR_PROFILE_INVALID/,
    );
  const c = createClient({
    profile: custom((p) => {
      p.transport.http2 = { initialWindowSize: 0 };
    }),
  });
  try {
    await assert.rejects(c.get('http://127.0.0.1:1/'), { code: 'ERR_PROFILE_INVALID' });
  } finally {
    await c.close();
  }
  const adaptive = await checkProfile(JSON.parse(profileText));
  assert.equal(adaptive.normalizedConfig.transport.http2.adaptiveWindow, true);
  const fixed = await checkProfile(
    custom((p) => {
      p.transport.http2 = { initialWindowSize: 1048576 };
    }),
  );
  assert.equal(fixed.normalizedConfig.transport.http2.adaptiveWindow, false);
  assert.equal(fixed.normalizedConfig.transport.http2.initialWindowSize, 1048576);
});

test('L-17: cipher suites must be negotiable within the TLS version range', async () => {
  const tls13 = ['TLS_AES_128_GCM_SHA256'];
  const tls12 = ['TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256'];
  // BoringSSL needs a TLS 1.2 suite in any cipher list (TLS 1.3 suites only
  // order the fixed TLS 1.3 set), and a TLS 1.3-only range needs a 1.3 suite.
  for (const tls of [
    { cipherSuites: tls13 },
    { cipherSuites: tls13, maxVersion: '1.2' },
    { cipherSuites: tls13, minVersion: '1.3' },
    { cipherSuites: tls12, minVersion: '1.3' },
  ])
    await assert.rejects(
      checkProfile(
        custom((p) => {
          p.transport.tls = tls;
        }),
      ),
      /ERR_PROFILE_INVALID/,
    );
  for (const tls of [
    { cipherSuites: tls12 },
    { cipherSuites: tls12, maxVersion: '1.2' },
    { cipherSuites: [...tls13, ...tls12] },
    { cipherSuites: [...tls13, ...tls12], minVersion: '1.3' },
  ]) {
    const report = await checkProfile(
      custom((p) => {
        p.transport.tls = tls;
      }),
    );
    assert.equal(report.compatible, true);
  }
});

test('B-14: native profile and request header rules match the TypeScript layer', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(new URL('../packages/omreq/package.json', import.meta.url));
  const addon = require('omreq-darwin-arm64');
  const native = (mutate) => () => addon.checkProfile(JSON.stringify(custom(mutate)));
  for (const [name, value] of [
    ['keep-alive', 'timeout=5'],
    ['proxy-connection', 'keep-alive'],
    ['upgrade', 'h2c'],
    ['te', 'gzip'],
    ['cookie', 'a=1'],
  ])
    assert.throws(
      native((p) => {
        p.headers.push([name, value]);
      }),
      /forbidden header/,
      name,
    );
  assert.doesNotThrow(
    native((p) => {
      p.headers.push(['te', 'trailers']);
    }),
  );
  assert.throws(
    native((p) => {
      p.headers = Array.from({ length: 201 }, (_, i) => [`x-${i}`, 'v']);
    }),
  );
  assert.throws(
    native((p) => {
      p.headers = Array.from({ length: 9 }, (_, i) => [`x-${i}`, 'v'.repeat(8000)]);
    }),
    /65536 bytes/,
  );
});
