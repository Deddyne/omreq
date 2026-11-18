import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import {
  checkProfile,
  createClient,
  defineProfile,
  getProfile,
  getRuntimeInfo,
  isOmreqError,
  OmreqError,
  parseProfile,
  serializeProfile,
} from '../packages/omreq/dist/index.mjs';

const profileText = readFileSync(
  new URL('../profiles/custom-default.json', import.meta.url),
  'utf8',
);
const canonical = (v) =>
  Array.isArray(v)
    ? `[${v.map(canonical).join(',')}]`
    : v && typeof v === 'object'
      ? `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
          .join(',')}}`
      : JSON.stringify(v);
test('T22: TS/JSON, canonical effective digest and immutable snapshots', async () => {
  const input = JSON.parse(profileText);
  const object = defineProfile(input);
  const json = parseProfile(profileText);
  input.headers[0][1] = 'mutated';
  assert.equal(object.headers[0][1], 'Omreq/0.0.0-internal.1');
  assert(Object.isFrozen(object.headers[0]));
  const a = await checkProfile(object);
  const b = await checkProfile(json);
  assert.equal(a.profileDigest, b.profileDigest);
  assert.equal(a.compatible, true);
  assert.equal(a.verification, 'custom-unverified');
  assert.equal(
    a.profileDigest,
    createHash('sha256').update(canonical(a.normalizedConfig)).digest('hex'),
  );
  assert.equal(serializeProfile(parseProfile(serializeProfile(object))), serializeProfile(object));
  const p = JSON.parse(profileText);
  p.target.family = 'chrome';
  p.id = 'chrome-999';
  assert.equal((await checkProfile(p)).verification, 'custom-unverified');
  assert.equal((await checkProfile(p)).profileDigest, a.profileDigest);
});
test('T22: parser rejects duplicates, invalid JSON, accessors, cycles, unknown fields and ranges', () => {
  for (const text of [
    profileText.replace('"schemaVersion": 1', '"schemaVersion": 1,"schemaVersion": 1'),
    profileText.replace('"transport": {}', '"transport": {"tls":{"alpn":["h2"],"alpn":["h2"]}}'),
    `${profileText}// comment`,
    profileText.replace('"requires": []', '"requires": [NaN]'),
  ])
    assert.throws(() => parseProfile(text), { code: 'ERR_PROFILE_INVALID' });
  for (const mutate of [
    (p) => {
      p.extra = true;
    },
    (p) => {
      p.transport.tls = { minVersion: '1.3', maxVersion: '1.2' };
    },
    (p) => {
      p.transport.http2 = { maxFrameSize: 16383 };
    },
    (p) => {
      p.headers = [['authorization', 'secret']];
    },
    (p) => {
      p.transport.httpVersion = '2';
      p.transport.tls = { alpn: ['http/1.1'] };
    },
    (p) => {
      p.transport.http2 = { initialWindowSize: 1.5 };
    },
    (p) => {
      p.transport.tls = { verify: false };
    },
    (p) => {
      p.provenance = { source: new Date() };
    },
    (p) => {
      p.headers[0][1] = 'bad\r\nvalue';
    },
  ]) {
    const p = JSON.parse(profileText);
    mutate(p);
    assert.throws(() => defineProfile(p), { code: 'ERR_PROFILE_INVALID' });
  }
  const accessor = JSON.parse(profileText);
  Object.defineProperty(accessor, 'id', {
    get() {
      throw Error('must not execute');
    },
    enumerable: true,
  });
  assert.throws(() => defineProfile(accessor), { code: 'ERR_PROFILE_INVALID' });
  const cyclic = JSON.parse(profileText);
  cyclic.transport = cyclic;
  assert.throws(() => defineProfile(cyclic), { code: 'ERR_PROFILE_INVALID' });
  assert.throws(() => getProfile('chrome'), { code: 'ERR_PROFILE_UNKNOWN' });
});
test('T22: unsupported capability is rejected before native request', async () => {
  const p = JSON.parse(profileText);
  p.requires = ['tls.missing.v1'];
  const report = await checkProfile(p);
  assert.equal(report.compatible, false);
  assert(report.issues[0].message.includes('tls.missing.v1'));
  const c = createClient({ profile: p });
  try {
    await assert.rejects(c.get('http://127.0.0.1:1'), { code: 'ERR_PROFILE_UNSUPPORTED' });
  } finally {
    await c.close();
  }
});
test('T24: CJS/ESM share classes and error brand', () => {
  const require = createRequire(import.meta.url);
  const cjs = require('../packages/omreq/dist/index.js');
  assert.equal(cjs.OmreqError, OmreqError);
  assert.equal(cjs.createClient, createClient);
  assert(isOmreqError(new cjs.OmreqError('TEST', 'body', 'test')));
  assert.equal(getRuntimeInfo().runtime, process.versions.bun ? 'bun' : 'node');
});
test('T22: native boundary validates schema, duplicate keys and integral decimal numbers', async () => {
  const require = createRequire(new URL('../packages/omreq/package.json', import.meta.url));
  const addon = require('omreq-darwin-arm64');
  assert.throws(() =>
    addon.checkProfile(
      profileText.replace('"schemaVersion": 1', '"schemaVersion": 1,"schemaVersion": 1'),
    ),
  );
  const p = JSON.parse(profileText);
  p.transport.http2 = { initialWindowSize: 123456 };
  const normal = JSON.stringify(p);
  const decimal = normal.replace('123456', '123456.0');
  const a = JSON.parse(addon.checkProfile(normal)),
    b = JSON.parse(addon.checkProfile(decimal));
  assert.equal(a.profileDigest, b.profileDigest);
  assert.equal(b.normalizedConfig.transport.http2.initialWindowSize, 123456);
});
