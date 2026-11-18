import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { checkProfile, getRuntimeInfo, parseProfile } from '../packages/omreq/dist/index.mjs';
import { artifactIdentity } from './artifact-identity.mjs';

const candidatePath = 'profiles/chrome-157-macos-arm64.candidate.json';
const profile = parseProfile(await readFile(candidatePath, 'utf8'));
const samples = Number(process.argv[2] ?? 16);
if (!Number.isSafeInteger(samples) || samples < 2 || samples > 64)
  throw Error('Expected 2–64 TLS samples');
const out = 'artifacts/qualification/chrome157';
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
  assert(result.tlsFirstFlightMatch);
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
  const report = JSON.parse(
    await readFile(`artifacts/qualification/chrome157-http2-${runtime}/report.json`, 'utf8'),
  );
  assert(report.exactPrefixMatch);
  await writeFile(`${out}/http2-${runtime}.json`, `${JSON.stringify(report, null, 2)}\n`);
  http2.push({ runtime, exactPrefixMatch: true, comparedBytes: report.comparedBytes });
  process.stdout.write(log);
}
const http1 = [];
for (const runtime of ['node', 'bun']) {
  const log = await run('node', ['scripts/profile-http1-reference.mjs', runtime]);
  const result = JSON.parse(
    await readFile(`artifacts/qualification/chrome157-http1-${runtime}/report.json`, 'utf8'),
  );
  assert(result.exactRequestMatch);
  await writeFile(`${out}/http1-${runtime}.json`, `${JSON.stringify(result, null, 2)}\n`);
  http1.push({ runtime, exactRequestMatch: true, comparedBytes: result.reference.length });
  process.stdout.write(log);
}
process.stdout.write(await run('node', ['scripts/profile-resumption-reference.mjs']));
const resumption = JSON.parse(
  await readFile('artifacts/qualification/chrome157-resumption/report.json', 'utf8'),
);
assert.equal(resumption.nativeSha256, nativeSha256);
assert.equal(resumption.status, 'matched-in-scoped-TLS12-and-TLS13-resumption-tests');
await writeFile(`${out}/resumption.json`, `${JSON.stringify(resumption, null, 2)}\n`);
assert.deepEqual(await artifactIdentity(), identity, 'Artifacts changed during qualification');
const report = {
  recordedAt: new Date().toISOString(),
  status: 'matched-in-scoped-TLS-HTTP1-and-HTTP2-tests',
  publicVerified: false,
  profileId: profile.id,
  profile: await checkProfile(profile),
  runtime: getRuntimeInfo(),
  ...identity,
  tls,
  http2,
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
    'fixtures/clienthello.mjs explicitly validates and normalizes random TLS values, extension permutation and the bounded ECH GREASE payload envelope. HTTP2 request prefix comparison is byte-for-byte.',
};
await writeFile(`${out}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Saved ${out}/report.json`);
