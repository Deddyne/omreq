// Creates a bundled profile for the Chrome installed on this Mac and qualifies it.
//
//   pnpm profile:new            capture, write profiles/chrome-<major>-macos.json, qualify
//   pnpm profile:new --force    replace an existing profile for that major version
//
// Chrome is driven against local fixtures (no network). The newest bundled profile
// is the starting point; what Chrome changes between releases is taken from the
// live capture: request headers (User-Agent, sec-ch-ua, …), HTTP/2 SETTINGS,
// connection window, HEADERS priority and pseudo-header order, HTTP/1 header order.
// TLS is checked rather than rewritten: if the qualification reports a TLS
// difference, edit transport.tls by hand and run `pnpm profile:qualify`.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { launchReferenceChrome } from '../fixtures/chrome.mjs';
import { http2WireFixture } from '../fixtures/http2-wire.mjs';
import { parseProfile } from '../packages/omreq/dist/index.mjs';
import { latestChrome } from './profile-catalog.mjs';

const force = process.argv.includes('--force');
const version = execFileSync(
  'defaults',
  ['read', '/Applications/Google Chrome.app/Contents/Info', 'CFBundleShortVersionString'],
  { encoding: 'utf8' },
).trim();
const major = Number(version.split('.')[0]);
const name = `chrome${major}`;
const path = `profiles/chrome-${major}-macos.json`;
const base = latestChrome();
if (existsSync(path) && !force) throw Error(`${path} exists; pass --force to replace it`);
if (base.major > major) throw Error(`Installed Chrome ${version} is older than ${base.name}`);
console.log(`Chrome ${version}: creating ${name} from ${base.name}`);

/** Two document navigations by the real Chrome; returns its request connection. */
async function captureChrome(protocol) {
  const fixture = await http2WireFixture({ protocol });
  let browser;
  try {
    fixture.label('chrome');
    browser = await launchReferenceChrome({ spki: fixture.spki, headless: false });
    await browser.navigate(`${fixture.url}/probe`);
    await browser.navigate(`${fixture.url}/probe?reuse=1`);
    const request = fixture.requests.find((r) => r.path === '/probe');
    const connection = fixture.connections.find((c) => c.index === request?.connection);
    if (!request || !connection) throw Error(`No ${protocol} navigation captured`);
    return { headers: request.headers, frames: connection.frames ?? [] };
  } finally {
    await browser?.close();
    await fixture.close();
  }
}
const pairs = (flat) => flat.flatMap((v, i) => (i % 2 ? [] : [[v, flat[i + 1]]]));

const h2 = await captureChrome('h2');
const h1 = await captureChrome('http/1.1');

const profile = JSON.parse(await readFile(base.path, 'utf8'));
profile.id = `chrome/${version}-${profile.target.platform}-${profile.target.architecture}`;
profile.revision = 1;
profile.target.version = version;

// Request headers exactly as Chrome sends them on HTTP/2 (lowercase, in order).
const h2Headers = pairs(h2.headers);
profile.headers = h2Headers.filter(([n]) => !n.startsWith(':'));
const http2 = profile.transport.http2;
http2.pseudoHeaderOrder = h2Headers.filter(([n]) => n.startsWith(':')).map(([n]) => n);
const SETTINGS = {
  1: 'headerTableSize',
  2: 'enablePush',
  3: 'maxConcurrentStreams',
  4: 'initialWindowSize',
  5: 'maxFrameSize',
  6: 'maxHeaderListSize',
  8: 'enableConnectProtocol',
  9: 'noRfc7540Priorities',
};
const settings = h2.frames.find((f) => f.type === 4 && !(f.flags & 1));
if (!settings) throw Error('Chrome sent no HTTP/2 SETTINGS');
http2.settings = settings.settings.map(({ id, value }) => {
  if (!SETTINGS[id]) throw Error(`Chrome sent unknown HTTP/2 setting ${id}; extend the schema`);
  return { name: SETTINGS[id], value };
});
const windowUpdate = h2.frames.find((f) => f.type === 8 && f.stream === 0);
if (windowUpdate) http2.initialConnectionWindowSize = 65535 + windowUpdate.increment;
else delete http2.initialConnectionWindowSize;
const headers = h2.frames.find((f) => f.type === 1);
if (headers?.priority) http2.headersPriority = headers.priority;
else delete http2.headersPriority;

// HTTP/1 header names keep Chrome's casing and order.
profile.transport.http1.headerOrder = pairs(h1.headers).map(([n]) => n);

profile.provenance = {
  source: `Headed Chrome ${version} on macOS ${profile.target.architecture}, en-US document navigation; TLS, HTTP/1 and HTTP/2 bytes verified against live capture`,
  date: new Date().toISOString().slice(0, 10),
};
parseProfile(JSON.stringify(profile));
await writeFile(path, `${JSON.stringify(profile, null, 2)}\n`);
console.log(`Wrote ${path}`);
const changed = (a, b) => JSON.stringify(a) !== JSON.stringify(b);
const previous = JSON.parse(await readFile(base.path, 'utf8'));
for (const [label, a, b] of [
  ['headers', previous.headers, profile.headers],
  ['http2', previous.transport.http2, profile.transport.http2],
  ['http1', previous.transport.http1, profile.transport.http1],
])
  console.log(`  ${label}: ${changed(a, b) ? 'changed' : 'same as'} ${base.name}`);

// Byte-for-byte comparison with Chrome over TLS, HTTP/2, HTTP/1 and resumption;
// on success the captures become the regression references for `pnpm test`.
const qualify = spawnSync(
  'node',
  ['scripts/qualify-profile.mjs', '--profile', name, '--write-references'],
  { stdio: 'inherit' },
);
if (qualify.status !== 0) {
  console.error(
    `\n${path} was written but does not match Chrome yet. Fix the reported part and run:\n  pnpm profile:qualify --profile ${name} --write-references`,
  );
  process.exit(1);
}
execFileSync('pnpm', ['generate'], { stdio: 'inherit' });
console.log(
  `\n${name} matches Chrome ${version}. 'chrome' now points to it. Next: pnpm build:js && pnpm test`,
);
