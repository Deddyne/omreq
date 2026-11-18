import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { launchReferenceChrome } from '../fixtures/chrome.mjs';
import { normalizedClientHello } from '../fixtures/clienthello.mjs';
import { http2WireFixture } from '../fixtures/http2-wire.mjs';
import { runProfileClient } from '../fixtures/profile-client.mjs';
import { parseProfile } from '../packages/omreq/dist/index.mjs';

const profile = parseProfile(await readFile('profiles/chrome-157-macos.json', 'utf8'));
const out = 'artifacts/qualification/chrome157-resumption';
const writeReference = process.argv.includes('--write-reference');
assert(
  process.argv.slice(2).every((arg) => arg === '--write-reference'),
  'Unknown argument',
);
await mkdir(out, { recursive: true });
const nativeSha = async () =>
  createHash('sha256')
    .update(await readFile('native/omreq-darwin-arm64/omreq.node'))
    .digest('hex');
const nativeSha256 = await nativeSha();
const report = {
  recordedAt: new Date().toISOString(),
  profileId: profile.id,
  nativeSha256,
  publicVerified: false,
  scope:
    'Six sequential HTTPS HTTP/1.1 navigations per client, server closes each connection. TLS 1.2 ECDHE-RSA-AES128-GCM-SHA256 and TLS 1.3 TLS_AES_128_GCM_SHA256 are selected separately. Server isSessionReused proves accepted resumption. Browser speculative preconnections are retained in evidence but do not define a transport retry/connection scheduling requirement.',
  normalization:
    'Random TLS values, GREASE and extension permutation use fixtures/clienthello.mjs. PSK ticket bytes, obfuscated ages and binders are opaque; identity/binder counts, lengths and PSK-last position are compared. TLS1.2 session-ticket bytes are opaque; length is compared.',
  scenarios: [],
};
for (const tlsVersion of ['TLSv1.2', 'TLSv1.3']) {
  const fixture = await http2WireFixture({
    protocol: 'http/1.1',
    closeResponses: true,
    captureTls: true,
    tlsVersion,
  });
  let browser;
  const scenario = { tlsVersion, clients: {}, comparisons: {} };
  report.scenarios.push(scenario);
  try {
    const paths = Array.from({ length: 6 }, (_, i) => `/probe?connection=${i}`);
    fixture.label('chrome');
    browser = await launchReferenceChrome({ spki: fixture.spki, headless: false });
    scenario.chrome = browser.version;
    assert.equal(browser.version.product, `Chrome/${profile.target.version}`);
    for (const path of paths) await browser.navigate(fixture.url + path);
    await browser.close();
    browser = undefined;
    for (const runtime of ['node', 'bun']) {
      fixture.label(runtime);
      scenario.clients[runtime] = await runProfileClient(runtime, {
        profile,
        ca: fixture.ca,
        url: fixture.url,
        paths,
      });
    }
    scenario.requests = fixture.requests;
    scenario.connections = fixture.connections.map(({ raw, ...rest }) => rest);
    scenario.handshakes = fixture.handshakes.map(({ raw, ...rest }) => ({
      ...rest,
      rawHex: Buffer.from(raw).toString('hex'),
    }));
    const requestConnections = (label) =>
      fixture.connections.filter(
        (c) => c.label === label && fixture.requests.some((q) => q.connection === c.index),
      );
    const selectedHello = (label, reused) => {
      const connection = requestConnections(label).find((c) => c.sessionReused === reused);
      assert(connection, `${label}/${tlsVersion}: missing ${reused ? 'resumed' : 'fresh'} TLS`);
      assert.equal(connection.tlsVersion, tlsVersion);
      const hello = fixture.handshakes[connection.handshake]?.hello;
      assert(hello, `${label}/${tlsVersion}: missing ClientHello capture`);
      if (tlsVersion === 'TLSv1.3')
        assert.equal(
          hello.extensions.some((e) => e.id === 41),
          reused,
          'PSK/server disagreement',
        );
      return normalizedClientHello(hello);
    };
    for (const runtime of ['node', 'bun']) {
      assert.equal(requestConnections(runtime).length, paths.length);
      const freshReference = selectedHello('chrome', false),
        resumedReference = selectedHello('chrome', true),
        freshCandidate = selectedHello(runtime, false),
        resumedCandidate = selectedHello(runtime, true);
      scenario.comparisons[runtime] = {
        freshMatch: isDeepStrictEqual(freshCandidate, freshReference),
        resumedMatch: isDeepStrictEqual(resumedCandidate, resumedReference),
        freshReference,
        freshCandidate,
        resumedReference,
        resumedCandidate,
        allConnectionsMatch: requestConnections(runtime).every((connection) =>
          isDeepStrictEqual(
            normalizedClientHello(fixture.handshakes[connection.handshake].hello),
            connection.sessionReused ? resumedReference : freshReference,
          ),
        ),
      };
    }
    console.log(
      JSON.stringify({
        tlsVersion,
        resumption: Object.fromEntries(
          ['chrome', 'node', 'bun'].map((label) => [
            label,
            requestConnections(label).map((c) => c.sessionReused),
          ]),
        ),
        comparisons: Object.fromEntries(
          Object.entries(scenario.comparisons).map(([runtime, c]) => [
            runtime,
            {
              freshMatch: c.freshMatch,
              resumedMatch: c.resumedMatch,
              allConnectionsMatch: c.allConnectionsMatch,
            },
          ]),
        ),
      }),
    );
  } finally {
    await browser?.close();
    await fixture.close();
    await writeFile(`${out}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
  }
}
assert.equal(await nativeSha(), nativeSha256, 'Native binary changed during qualification');
for (const scenario of report.scenarios)
  for (const [runtime, comparison] of Object.entries(scenario.comparisons)) {
    assert(comparison.freshMatch, `${runtime}/${scenario.tlsVersion}: fresh TLS structure differs`);
    assert(
      comparison.resumedMatch,
      `${runtime}/${scenario.tlsVersion}: resumed TLS structure differs; inspect ${out}/report.json`,
    );
    assert(
      comparison.allConnectionsMatch,
      `${runtime}/${scenario.tlsVersion}: a later TLS differs`,
    );
  }
report.status = 'matched-in-scoped-TLS12-and-TLS13-resumption-tests';
await writeFile(`${out}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
if (writeReference) {
  const reference = {
    recordedAt: report.recordedAt,
    profileId: report.profileId,
    scope: report.scope,
    normalization: report.normalization,
    scenarios: report.scenarios.map((scenario) => ({
      tlsVersion: scenario.tlsVersion,
      chrome: scenario.chrome,
      connections: [false, true].map((sessionReused) => {
        const connection = scenario.connections.find(
          (c) =>
            c.label === 'chrome' &&
            c.sessionReused === sessionReused &&
            scenario.requests.some((q) => q.connection === c.index),
        );
        return {
          sessionReused,
          alpn: connection.alpn,
          cipher: connection.cipher,
          rawHex: scenario.handshakes[connection.handshake].rawHex,
        };
      }),
    })),
  };
  await writeFile(
    'fixtures/references/chrome157/resumption-capture.json',
    `${JSON.stringify(reference, null, 2)}\n`,
  );
}
