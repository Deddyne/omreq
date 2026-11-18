import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { artifactIdentity, sha256 } from './artifact-identity.mjs';
import { currentTarget } from './native-target.mjs';

const source = 'artifacts/qualification';
const identity = await artifactIdentity();
const acceptance = JSON.parse(await readFile(`${source}/acceptance.json`, 'utf8'));
assert.equal(acceptance.nativeSha256, identity.nativeSha256);
assert.equal(acceptance.javascriptSha256, identity.javascriptSha256);
assert(
  acceptance.checks.every((c) => c.status === 0),
  'Fix failed checks before making a snapshot',
);
const destination =
  process.argv[2] ?? `artifacts/releases/development-${identity.nativeSha256.slice(0, 12)}`;
assert(
  resolve(destination).startsWith(`${resolve('artifacts/releases')}/`),
  'Snapshot belongs under artifacts/releases',
);
try {
  const previous = JSON.parse(await readFile(`${destination}/summary.json`, 'utf8'));
  assert.equal(
    previous.nativeSha256,
    identity.nativeSha256,
    'Use a new directory for a different native artifact',
  );
  assert.equal(
    previous.javascriptSha256,
    identity.javascriptSha256,
    'Use a new directory for different JavaScript',
  );
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
await mkdir(destination, { recursive: true });
for (const name of [
  'acceptance.json',
  'runtime-matrix.json',
  'install-matrix.json',
  ...acceptance.checks.map((c) => c.log),
])
  await cp(`${source}/${name}`, `${destination}/${name}`);
const runtimes = JSON.parse(await readFile(`${source}/runtime-matrix.json`, 'utf8'));
for (const runtime of runtimes)
  await cp(`${source}/${runtime.log}`, `${destination}/${runtime.log}`);
await cp(`${source}/chrome157`, `${destination}/wire`, { recursive: true });
await cp(`${currentTarget().dir}/build-manifest.json`, `${destination}/build-manifest.json`);
await cp('patches/cookies.json', `${destination}/cookie-provenance.json`);
await cp('THIRD_PARTY_NOTICES.md', `${destination}/THIRD_PARTY_NOTICES.md`);
const wire = JSON.parse(await readFile(`${destination}/wire/report.json`, 'utf8'));
assert.equal(wire.nativeSha256, identity.nativeSha256);
assert.equal(wire.javascriptSha256, identity.javascriptSha256);
const soaks = [];
for (const runtime of ['node', 'bun']) {
  let soak;
  try {
    soak = JSON.parse(await readFile(`${source}/soak-${runtime}.json`, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    else continue;
  }
  if (
    soak.nativeSha256 !== identity.nativeSha256 ||
    soak.javascriptSha256 !== identity.javascriptSha256
  )
    continue;
  assert.equal(
    soak.harnessSha256,
    sha256(await readFile('scripts/soak.mjs')),
    'Soak harness differs from its report',
  );
  await cp(`${source}/soak-${runtime}.json`, `${destination}/soak-${runtime}.json`);
  soaks.push({
    runtime,
    cycles: soak.cycles,
    abortPhases: soak.abortPhases,
    normalSources: soak.normalSources,
    streamBytes: soak.stream.bytes,
    harnessSha256: soak.harnessSha256,
  });
}
if (soaks.length) await cp('scripts/soak.mjs', `${destination}/soak-harness.mjs`);
const benchmarks = [];
for (const runtime of ['node', 'bun']) {
  let report;
  try {
    report = JSON.parse(await readFile(`artifacts/benchmarks/${runtime}.json`, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') continue;
    throw error;
  }
  if (
    report.nativeSha256 !== identity.nativeSha256 ||
    report.javascriptSha256 !== identity.javascriptSha256
  )
    continue;
  assert.equal(
    report.harnessSha256,
    sha256(await readFile('scripts/benchmark.mjs')),
    'Benchmark harness differs from report',
  );
  assert.equal(
    report.fixtureSha256,
    sha256(await readFile('fixtures/server.mjs')),
    'Benchmark fixture differs from report',
  );
  await cp(`artifacts/benchmarks/${runtime}.json`, `${destination}/benchmark-${runtime}.json`);
  benchmarks.push({
    runtime,
    status: report.status,
    configuration: report.configuration,
    coldSamples: report.cold.length,
    warmCases: report.warm.length,
    harnessSha256: report.harnessSha256,
  });
}
if (benchmarks.length) await cp('scripts/benchmark.mjs', `${destination}/benchmark-harness.mjs`);
const summary = {
  recordedAt: new Date().toISOString(),
  goalStatus: 'active',
  alphaReady: false,
  ...identity,
  bridgeAbi: JSON.parse(await readFile('bridge.json', 'utf8')).abi,
  os: execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim(),
  architecture: process.arch,
  profileScope: wire.status,
  tlsSamples: wire.tls.length,
  http1: wire.http1,
  http2: wire.http2,
  resumption: wire.resumption,
  checks: acceptance.checks.map(({ id, status }) => ({ id, status })),
  soaks,
  benchmarks,
  remaining:
    'Earlier soak reports bind to earlier artifacts; this development snapshot is not final alpha acceptance.',
};
await writeFile(`${destination}/summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
// Logs and reports record absolute paths (cwd, runtime binaries, temporary
// directories). Snapshots may be shared, so replace machine-specific prefixes
// with neutral names before checksumming.
const redactions = [
  [process.cwd(), '<repo>'],
  [homedir(), '~'],
];
async function redact(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      await redact(path);
      continue;
    }
    if (!/\.(json|log|txt|md|mjs)$/.test(entry.name)) continue;
    const text = await readFile(path, 'utf8');
    let clean = text;
    for (const [from, to] of redactions) clean = clean.split(from).join(to);
    if (clean !== text) await writeFile(path, clean);
  }
}
await redact(destination);
const files = [];
async function collect(dir, prefix = '') {
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (entry.name === 'checksums.json') continue;
    const name = prefix + entry.name;
    if (entry.isDirectory()) await collect(`${dir}/${entry.name}`, `${name}/`);
    else files.push({ file: name, sha256: sha256(await readFile(`${dir}/${entry.name}`)) });
  }
}
await collect(destination);
await writeFile(`${destination}/checksums.json`, `${JSON.stringify(files, null, 2)}\n`);
assert.deepEqual(await artifactIdentity(), identity, 'Artifacts changed while making the snapshot');
console.log(`Saved artifact-bound development evidence in ${destination}`);
