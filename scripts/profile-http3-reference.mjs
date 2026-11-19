import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { launchReferenceChrome } from '../fixtures/chrome.mjs';
import { clientDatagrams, summarizeHttp3 } from '../fixtures/http3-compare.mjs';
import { http3WireFixture } from '../fixtures/http3-wire.mjs';
import { runProfileClient } from '../fixtures/profile-client.mjs';
import { parseProfile } from '../packages/omreq/dist/index.mjs';
import { selectedProfile } from './profile-catalog.mjs';

const runtime = process.argv[2] ?? 'node';
const entry = selectedProfile();
if (!['node', 'bun'].includes(runtime)) throw Error('Expected node or bun');
const paths = ['/probe', '/probe?reuse=1'];
const fixture = await http3WireFixture();
const connections = () => fixture.events.filter((e) => e.event === 'connection').length;
let browser;
try {
  browser = await launchReferenceChrome({
    spki: fixture.spki,
    headless: false,
    extraArgs: [
      `--origin-to-force-quic-on=localhost:${fixture.port}`,
      '--host-resolver-rules=MAP localhost 127.0.0.1',
    ],
  });
  for (const path of paths) await browser.navigate(`${fixture.url}${path}`);
  await browser.close();
  browser = undefined;
  // Chrome's control stream and favicon request may still be in flight.
  await new Promise((resolve) => setTimeout(resolve, 500));
  const chromeDatagrams = fixture.datagrams.length;
  assert(connections() >= 1, 'Chrome did not reach the HTTP/3 fixture');
  const chromeConnection = 0;

  const input = JSON.parse(await readFile(entry.path, 'utf8'));
  assert(input.transport.http3, `${entry.path} has no transport.http3 block`);
  input.transport.httpVersion = '3';
  const profile = parseProfile(JSON.stringify(input));
  const clientResult = await runProfileClient(runtime, {
    profile,
    ca: fixture.ca,
    url: fixture.url,
    paths,
    options: { resolve: { localhost: '127.0.0.1' } },
  });
  assert.deepEqual(clientResult.versions, ['3', '3']);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const omreqConnection = connections() - 1;
  assert(omreqConnection > chromeConnection, 'Omreq did not open its own connection');

  const capture = { events: fixture.events };
  const chrome = summarizeHttp3(
    { ...capture, datagrams: clientDatagrams(fixture.datagrams, { to: chromeDatagrams }) },
    chromeConnection,
    paths,
  );
  const omreq = summarizeHttp3(
    { ...capture, datagrams: clientDatagrams(fixture.datagrams, { from: chromeDatagrams }) },
    omreqConnection,
    paths,
  );
  const parts = ['initial', 'uniStreams', 'control', 'requests'];
  const matches = Object.fromEntries(
    parts.map((part) => [part, isDeepStrictEqual(chrome[part], omreq[part])]),
  );
  const exactMatch = parts.every((part) => matches[part]);
  const report = {
    recordedAt: new Date().toISOString(),
    runtime,
    clientResult,
    exactMatch,
    matches,
    scope:
      'QUIC first flight (datagram layout, normalized ClientHello and transport parameters, chaos protection), unidirectional stream types, control stream frames, and the exact QPACK field sections of two navigations',
    scenario:
      'Two sequential document navigations to a controlled HTTPS HTTP/3 origin; Chrome is forced to QUIC for that origin and trusts only the ephemeral test certificate SPKI',
    chrome,
    omreq,
    datagrams: fixture.datagrams.map((d) => ({ ...d, data: d.data.toString('hex') })),
    events: fixture.events,
  };
  const out = `${entry.qualification}-http3-${runtime}`;
  await mkdir(out, { recursive: true });
  await writeFile(`${out}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ runtime, exactMatch, matches, report: `${out}/report.json` }));
  assert(exactMatch, 'Chrome/Omreq HTTP3 differs; compare chrome and omreq in the saved report');
} finally {
  await browser?.close();
  await fixture.close();
}
