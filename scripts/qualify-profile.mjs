import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { checkProfile, getRuntimeInfo, parseProfile } from '../packages/omreq/dist/index.mjs';
import { artifactIdentity } from './artifact-identity.mjs';
import { selectedProfile } from './profile-catalog.mjs';

const entry = selectedProfile();
// Child scripts qualify the same profile.
process.env.OMREQ_PROFILE = entry.name;
const candidatePath = entry.path;
const profile = parseProfile(await readFile(candidatePath, 'utf8'));
const samples = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)) ?? 16);
if (!Number.isSafeInteger(samples) || samples < 2 || samples > 64)
  throw Error('Expected 2–64 TLS samples');
const out = entry.qualification;
// After a full match, record the captures as the regression references in fixtures/.
const writeReferences = process.argv.includes('--write-references');
await mkdir(out, { recursive: true });
const identity = await artifactIdentity();
const { nativeSha256 } = identity;
const run = (binary, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(Error(`Qualification subprocess timed out: ${binary}`));
    }, 45000);
    child.stdout.on('data', (b) => (log += b));
    child.stderr.on('data', (b) => (log += b));
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(log);
      else reject(Error(log));
    });
  });
const tls = [];
for (let i = 0; i < samples; i++) {
  const dir = `${out}/tls-${i + 1}`;
  await run('node', ['scripts/reference-capture.mjs', candidatePath, dir]);
  const result = JSON.parse(await readFile(`${dir}/report.json`, 'utf8'));
  assert.equal(
    result.chromeVersion,
    profile.target.version,
    'Reference Chrome version changed; choose and requalify a new target',
  );
  assert(
    result.tlsFirstFlightMatch,
    `TLS differs from Chrome: compare normalizedReference and normalizedCandidate in ${dir}/report.json, then update transport.tls in ${candidatePath}`,
  );
  tls.push({
    sample: i + 1,
    referenceBytes: result.reference.clientHelloBytes,
    candidateBytes: result.candidate.clientHelloBytes,
    referenceEchPayload: result.reference.extensions.find((e) => e.id === 65037).ech.payloadLength,
    candidateEchPayload: result.candidate.extensions.find((e) => e.id === 65037).ech.payloadLength,
    referenceOrder: result.reference.extensions.map((e) => e.id),
    candidateOrder: result.candidate.extensions.map((e) => e.id),
    match: true,
  });
  if ((i + 1) % 4 === 0) console.log(`TLS ${i + 1}/${samples}: matched`);
}
const http2 = [];
for (const runtime of ['node', 'bun']) {
  const log = await run('node', ['scripts/profile-http2-reference.mjs', runtime]);
  const report = JSON.parse(await readFile(`${out}-http2-${runtime}/report.json`, 'utf8'));
  assert(report.exactPrefixMatch);
  await writeFile(`${out}/http2-${runtime}.json`, `${JSON.stringify(report, null, 2)}\n`);
  http2.push({ runtime, exactPrefixMatch: true, comparedBytes: report.comparedBytes });
  process.stdout.write(log);
}
const http3 = [];
if (profile.transport.http3)
  for (const runtime of ['node', 'bun']) {
    const log = await run('node', ['scripts/profile-http3-reference.mjs', runtime]);
    const report = JSON.parse(await readFile(`${out}-http3-${runtime}/report.json`, 'utf8'));
    assert(report.exactMatch);
    await writeFile(`${out}/http3-${runtime}.json`, `${JSON.stringify(report, null, 2)}\n`);
    http3.push({ runtime, exactMatch: true, parts: Object.keys(report.matches) });
    process.stdout.write(log);
  }
const http1 = [];
for (const runtime of ['node', 'bun']) {
  const log = await run('node', ['scripts/profile-http1-reference.mjs', runtime]);
  const result = JSON.parse(await readFile(`${out}-http1-${runtime}/report.json`, 'utf8'));
  assert(result.exactRequestMatch);
  await writeFile(`${out}/http1-${runtime}.json`, `${JSON.stringify(result, null, 2)}\n`);
  http1.push({ runtime, exactRequestMatch: true, comparedBytes: result.reference.length });
  process.stdout.write(log);
}
process.stdout.write(
  await run('node', [
    'scripts/profile-resumption-reference.mjs',
    ...(writeReferences ? ['--write-reference'] : []),
  ]),
);
const resumption = JSON.parse(await readFile(`${out}-resumption/report.json`, 'utf8'));
assert.equal(resumption.nativeSha256, nativeSha256);
assert.equal(resumption.status, 'matched-in-scoped-TLS12-and-TLS13-resumption-tests');
await writeFile(`${out}/resumption.json`, `${JSON.stringify(resumption, null, 2)}\n`);
assert.deepEqual(await artifactIdentity(), identity, 'Artifacts changed during qualification');
const report = {
  recordedAt: new Date().toISOString(),
  status: profile.transport.http3
    ? 'matched-in-scoped-TLS-HTTP1-HTTP2-and-HTTP3-tests'
    : 'matched-in-scoped-TLS-HTTP1-and-HTTP2-tests',
  publicVerified: false,
  profileId: profile.id,
  profile: await checkProfile(profile),
  runtime: getRuntimeInfo(),
  ...identity,
  tls,
  http2,
  ...(http3.length && { http3 }),
  http1,
  resumption: resumption.scenarios.map((s) => ({
    tlsVersion: s.tlsVersion,
    runtimes: Object.keys(s.comparisons),
    match: true,
  })),
  remaining: [
    'Broader connection scenarios and final bundled evidence/catalog policy',
    'Full alpha resource and HTTP policy acceptance; this report does not close those gates',
  ],
  normalization:
    'fixtures/clienthello.mjs explicitly validates and normalizes random TLS values, extension permutation and the bounded ECH GREASE payload envelope. HTTP2 request prefix comparison is byte-for-byte. fixtures/http3-compare.mjs decrypts the QUIC Initial packets, normalizes connection IDs, GREASE and transport parameter order, and compares QPACK field sections byte-for-byte.',
};
await writeFile(`${out}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Saved ${out}/report.json`);
if (writeReferences) {
  const refs = entry.references;
  await mkdir(refs, { recursive: true });
  await copyFile(`${out}/tls-1/chrome-clienthello.bin`, `${refs}/clienthello.bin`);
  await copyFile(`${out}/tls-1/report.json`, `${refs}/tls-capture.json`);
  const { clientResult: _, ...http2Capture } = JSON.parse(
    await readFile(`${out}/http2-node.json`, 'utf8'),
  );
  await writeFile(`${refs}/http2-capture.json`, `${JSON.stringify(http2Capture, null, 2)}\n`);
  if (http3.length) {
    const { chrome } = JSON.parse(await readFile(`${out}/http3-node.json`, 'utf8'));
    await writeFile(`${refs}/http3-capture.json`, `${JSON.stringify(chrome, null, 2)}\n`);
  }
  await writeFile(
    `${refs}/README.md`,
    `# Chrome ${entry.major} reference evidence

Captured on macOS ${profile.target.architecture} from the installed Chrome ${profile.target.version}
by \`pnpm profile:new\` (or \`pnpm profile:qualify --profile ${entry.name} --write-references\`),
after the profile matched it byte for byte.

- \`clienthello.bin\`: raw TLS first flight to a loopback TCP listener.
- \`tls-capture.json\`: parsed Chrome and Omreq first flights with the normalization applied
  (random values, extension permutation, ECH GREASE payload size).
- \`http2-capture.json\`: two document navigations to a local HTTP/2 fixture; exact bytes from
  the client preface through the second HEADERS frame, plus decoded request headers.
- \`resumption-capture.json\`: fresh and resumed TLS 1.2/1.3 ClientHellos.
- \`http3-capture.json\` (profiles with HTTP/3): two document navigations over QUIC, reduced
  by \`fixtures/http3-compare.mjs\`: the decrypted Initial flight, control stream and the exact
  QPACK field sections.

These are scenario-scoped test vectors used by \`pnpm test\`, not a claim about all browser
activity.
`,
  );
  console.log(`Recorded references in ${refs}`);
}
