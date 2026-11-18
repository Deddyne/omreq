import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { launchReferenceChrome } from '../fixtures/chrome.mjs';
import { http2WireFixture } from '../fixtures/http2-wire.mjs';
import { runProfileClient } from '../fixtures/profile-client.mjs';
import { parseProfile } from '../packages/omreq/dist/index.mjs';

const runtime = process.argv[2] ?? 'node';
if (!['node', 'bun'].includes(runtime)) throw Error('Expected node or bun');
const fixture = await http2WireFixture();
let browser;
try {
  fixture.label('chrome');
  browser = await launchReferenceChrome({ spki: fixture.spki, headless: false });
  await browser.navigate(`${fixture.url}/probe`);
  await browser.navigate(`${fixture.url}/probe?reuse=1`);
  await browser.close();
  browser = undefined;
  fixture.label('omreq');
  const profile = parseProfile(
    await readFile('profiles/chrome-157-macos-arm64.candidate.json', 'utf8'),
  );
  const clientResult = await runProfileClient(runtime, {
    profile,
    ca: fixture.ca,
    url: fixture.url,
  });
  const active = fixture.connections.filter((c) => c.frames.some((f) => f.type === 1));
  const chrome = active.find((c) => c.label === 'chrome'),
    omreq = active.find((c) => c.label === 'omreq');
  assert(chrome && omreq, 'Missing Chrome or Omreq request connection');
  const prefix = (raw) => {
    const bytes = Buffer.concat(raw);
    let offset = 24,
      count = 0;
    while (offset + 9 <= bytes.length) {
      const length = bytes.readUIntBE(offset, 3),
        type = bytes[offset + 3];
      offset += 9 + length;
      if (type === 1 && ++count === 2) return bytes.subarray(0, offset);
    }
    throw Error('Missing two HEADERS frames');
  };
  const chromePrefix = prefix(chrome.raw),
    omreqPrefix = prefix(omreq.raw);
  const exactPrefixMatch = chromePrefix.equals(omreqPrefix);
  const report = {
    recordedAt: new Date().toISOString(),
    runtime,
    clientResult,
    exactPrefixMatch,
    comparedBytes: chromePrefix.length,
    scope:
      'Client preface through two HEADERS frames, including HPACK, SETTINGS, WINDOW_UPDATE, priorities and ACK; connection teardown is a separate lifecycle policy',
    scenario:
      'Two sequential document navigations to the same controlled HTTPS HTTP/2 origin; Chrome trusts only the ephemeral test certificate SPKI',
    connections: fixture.connections.map(({ raw, ...rest }) => ({
      ...rest,
      rawHex: Buffer.concat(raw).toString('hex'),
    })),
    requests: fixture.requests,
  };
  const out = `artifacts/qualification/chrome157-http2-${runtime}`;
  await mkdir(out, { recursive: true });
  await writeFile(`${out}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify({
      runtime,
      exactPrefixMatch,
      comparedBytes: chromePrefix.length,
      report: `${out}/report.json`,
    }),
  );
  assert(exactPrefixMatch, 'Chrome/Omreq HTTP2 prefix differs; inspect saved wire evidence');
} finally {
  await browser?.close();
  await fixture.close();
}
