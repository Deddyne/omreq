import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { artifactIdentity } from './artifact-identity.mjs';

const root = 'artifacts/qualification';
mkdirSync(root, { recursive: true });
const commands = [
  ['transport-source', 'pnpm', ['verify:transport']],
  ['cookie-source', 'node', ['scripts/verify-cookies.mjs', '--self-test']],
  ['notices', 'node', ['scripts/notices.mjs', '--check']],
  ['lint', 'pnpm', ['lint']],
  ['typecheck', 'pnpm', ['typecheck']],
  ['rust-fmt', 'cargo', ['fmt', '--all', '--check']],
  [
    'rust-clippy',
    'cargo',
    ['clippy', '--workspace', '--locked', '--all-targets', '--', '-D', 'warnings'],
  ],
  ['rust-tests', 'cargo', ['test', '--workspace', '--locked']],
  ['upstream-http2', 'pnpm', ['test:transport']],
  ['upstream-wreq', 'pnpm', ['test:transport:wreq']],
  ['node-local', 'pnpm', ['test']],
  ['bun', 'pnpm', ['test:bun']],
  ['runtime-matrix', 'node', ['scripts/runtime-matrix.mjs']],
  ['install-matrix', 'node', ['scripts/pack-check.mjs']],
  ['reference', 'pnpm', ['test:profile:reference']],
];
const results = [];
const identity = await artifactIdentity();
for (const [id, bin, args] of commands) {
  const startedAt = new Date().toISOString();
  console.log(`Checking ${id}`);
  const result = await new Promise((resolve) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    const timer = setTimeout(
      () => {
        p.kill('SIGKILL');
        resolve({ status: null, error: 'Evidence subprocess deadline', log });
      },
      id === 'upstream-wreq' ? 600000 : 120000,
    );
    p.stdout.on('data', (b) => (log += b));
    p.stderr.on('data', (b) => (log += b));
    p.on('error', (e) => {
      clearTimeout(timer);
      resolve({ status: null, error: e.message, log });
    });
    p.on('exit', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, log });
    });
  });
  writeFileSync(`${root}/${id}.log`, result.log);
  results.push({
    id,
    command: [bin, ...args],
    startedAt,
    finishedAt: new Date().toISOString(),
    status: result.status,
    signal: result.signal ?? null,
    error: result.error ?? null,
    log: `${id}.log`,
  });
  if (result.status !== 0) {
    process.stdout.write(result.log);
    console.error(`FAILED ${id}`);
    process.exitCode = 1;
  }
}
assert.deepEqual(await artifactIdentity(), identity, 'Artifacts changed during qualification');
const profile = JSON.parse(readFileSync(`${root}/chrome157/report.json`, 'utf8'));
assert.equal(profile.nativeSha256, identity.nativeSha256);
assert.equal(profile.javascriptSha256, identity.javascriptSha256);
writeFileSync(
  `${root}/acceptance.json`,
  `${JSON.stringify(
    {
      recordedAt: new Date().toISOString(),
      stage: 'A0/A1/B-internal-development',
      alphaReady: false,
      ...identity,
      checks: results,
      limitations: [
        'Successful checks cover named scenarios only; T01–T24 are not all fully accepted.',
        'G1 final catalog/evidence policy, G3 total resource accounting, G4 minimum OS and G5 full cookie/trust policy are open.',
      ],
    },
    null,
    2,
  )}\n`,
);
