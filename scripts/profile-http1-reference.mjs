import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { launchReferenceChrome } from '../fixtures/chrome.mjs';
import { http2WireFixture } from '../fixtures/http2-wire.mjs';
import { runProfileClient } from '../fixtures/profile-client.mjs';
import { parseProfile } from '../packages/omreq/dist/index.mjs';

const runtime = process.argv[2] ?? 'node';
if (!['node', 'bun'].includes(runtime)) throw Error('Expected node or bun');
const fixture = await http2WireFixture({ protocol: 'http/1.1' });
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
  const records = fixture.connections.filter((c) => c.raw.length);
  // Compare the request byte sequence across all of a client's connections.
  // Whether Chrome reuses the socket for the second navigation varies between
  // runs (it may open a resumed connection instead), so connection reuse is
  // recorded separately rather than being part of the byte comparison.
  const bytes = (label) =>
    Buffer.concat(records.filter((c) => c.label === label).flatMap((c) => c.raw));
  const connectionsOf = (label) => records.filter((c) => c.label === label).length;
  const reference = bytes('chrome'),
    candidate = bytes('omreq');
  assert(reference.length && candidate.length, 'Missing client request bytes');
  const exactRequestMatch = reference.equals(candidate);
  const report = {
    recordedAt: new Date().toISOString(),
    runtime,
    clientResult,
    exactRequestMatch,
    connectionCount: { chrome: connectionsOf('chrome'), omreq: connectionsOf('omreq') },
    reference: reference.toString('latin1'),
    candidate: candidate.toString('latin1'),
    connections: records.map(({ raw, ...r }) => r),
    requests: fixture.requests,
  };
  const out = `artifacts/qualification/chrome157-http1-${runtime}`;
  await mkdir(out, { recursive: true });
  await writeFile(`${out}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ runtime, exactRequestMatch, comparedBytes: reference.length, out }));
  assert(exactRequestMatch, 'HTTP1 request bytes differ');
} finally {
  await browser?.close();
  await fixture.close();
}
