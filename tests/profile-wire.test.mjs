import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import test from 'node:test';
import { normalizedClientHello, parseClientHello } from '../fixtures/clienthello.mjs';
import { http2WireFixture } from '../fixtures/http2-wire.mjs';
import {
  checkProfile,
  createClient,
  defineProfile,
  parseProfile,
} from '../packages/omreq/dist/index.mjs';
import {
  chromeProfiles,
  hasReferences,
  latestChrome,
  readProfileText,
  referenceUrl,
} from '../scripts/profile-catalog.mjs';
import { nativePackage } from './native-package.mjs';

const text = readProfileText(latestChrome());
const profile = parseProfile(text);
// Every bundled Chrome is checked against its own recorded browser capture.
for (const entry of chromeProfiles().filter(hasReferences)) {
  const profile = parseProfile(readProfileText(entry));
  const reference = parseClientHello(readFileSync(referenceUrl(entry, 'clienthello.bin')));
  test(`G1 ${entry.name}: candidate TLS first flight matches independent Chrome structure`, async () => {
    const sockets = new Set();
    let resolve;
    const captured = new Promise((r) => (resolve = r));
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
      let bytes = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        bytes = Buffer.concat([bytes, chunk]);
        if (bytes.length > 65536) {
          socket.destroy();
          return;
        }
        const hello = parseClientHello(bytes);
        if (hello) {
          resolve(hello);
          socket.destroy();
        }
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const c = createClient({ profile, trustStore: 'chromium' });
    let timer;
    try {
      const request = c.get(`https://localhost:${server.address().port}/probe`).catch((e) => e);
      const actual = await Promise.race([
        captured,
        new Promise(
          (_, reject) => (timer = setTimeout(() => reject(Error('ClientHello deadline')), 5000)),
        ),
      ]);
      assert.deepEqual(normalizedClientHello(actual), normalizedClientHello(reference));
      await request;
      const report = await checkProfile(profile);
      assert.equal(report.compatible, true);
      assert.equal(report.verification, 'bundled-verified');
    } finally {
      clearTimeout(timer);
      await c.close();
      for (const socket of sockets) socket.destroy();
      await new Promise((r) => server.close(r));
    }
  });
  test(`G1 ${entry.name}: HTTP2 settings, pseudo headers and literal headers match Chrome on reuse`, async () => {
    const fixture = await http2WireFixture();
    const c = createClient({ profile, ca: fixture.ca, trustStore: 'chromium' });
    try {
      await (await c.get(`${fixture.url}/probe`)).bytes();
      await (await c.get(`${fixture.url}/probe?reuse=1`)).bytes();
      const active = fixture.connections.filter((c) => c.frames.some((f) => f.type === 1));
      assert.equal(active.length, 1);
      const capture = JSON.parse(readFileSync(referenceUrl(entry, 'http2-capture.json'), 'utf8'));
      const chrome = capture.connections.find(
        (c) => c.label === 'chrome' && c.frames.some((f) => f.type === 1),
      );
      const relevant = (frames) =>
        frames
          .filter((f) => f.type === 4 || f.type === 8 || f.type === 1)
          .map((f) => ({ ...f, ...(f.type === 1 ? { length: undefined } : {}) }));
      assert.deepEqual(relevant(active[0].frames), relevant(chrome.frames));
      const normalize = (headers) => {
        const result = [];
        for (let i = 0; i < headers.length; i += 2)
          result.push([
            headers[i],
            headers[i] === ':authority' ? 'controlled-origin' : headers[i + 1],
          ]);
        return result;
      };
      const requests = capture.requests.filter((q) => q.connection === chrome.index);
      for (let i = 0; i < 2; i++)
        assert.deepEqual(normalize(fixture.requests[i].headers), normalize(requests[i].headers));
    } finally {
      await c.close();
      await fixture.close();
    }
  });
}
test('G1: native and JS reject conflicting or duplicate HTTP2 settings before I/O', async () => {
  for (const change of [
    (p) => p.transport.http2.settings.push({ name: 'initialWindowSize', value: 1 }),
    (p) => (p.transport.http2.maxFrameSize = 16384),
    (p) => (p.transport.http2.settings[0].value = 1048577),
    (p) => (p.transport.http2.hpackHuffman = 'unknown'),
    (p) => (p.transport.tls.signatureAlgorithms = ['unknown']),
    (p) => (p.transport.tls.trustAnchorIds = ['zz']),
  ]) {
    const p = JSON.parse(text);
    change(p);
    assert.throws(() => defineProfile(p), { code: 'ERR_PROFILE_INVALID' });
    const { createRequire } = await import('node:module');
    const require = createRequire(new URL('../packages/omreq/package.json', import.meta.url));
    assert.throws(() => require(nativePackage).checkProfile(JSON.stringify(p)));
  }
});
test('G1: HTTP1 casing/order/reuse matches Chrome and explicit overrides survive', async () => {
  const fixture = await http2WireFixture({ protocol: 'http/1.1' });
  const c = createClient({
    profile,
    ca: fixture.ca,
    trustStore: 'chromium',
    headers: { 'sec-fetch-user': null },
  });
  try {
    const response = await c.get(`${fixture.url}/probe`, { headers: { priority: 'u=2' } });
    assert.equal(response.httpVersion, '1.1');
    await response.bytes();
    const pairs = fixture.requests[0].headers;
    assert.equal(pairs[0], 'Host');
    assert.equal(pairs[2], 'Connection');
    assert.equal(pairs[3], 'keep-alive');
    const names = pairs.filter((_, i) => i % 2 === 0).map((n) => n.toLowerCase());
    assert(!names.includes('sec-fetch-user'));
    assert(names.includes('priority'));
    assert.equal(pairs[names.indexOf('priority') * 2 + 1], 'u=2');
    const original = createClient({ profile, ca: fixture.ca, trustStore: 'chromium' });
    try {
      await (await original.get(`${fixture.url}/probe`)).bytes();
      const raw = fixture.requests.at(-1).headers;
      assert(!raw.some((n, i) => i % 2 === 0 && n.toLowerCase() === 'priority'));
    } finally {
      await original.close();
    }
    await assert.rejects(c.get(`${fixture.url}/probe`, { headers: { Host: null } }), {
      code: 'ERR_INVALID_ARGUMENT',
    });
  } finally {
    await c.close();
    await fixture.close();
  }
});
