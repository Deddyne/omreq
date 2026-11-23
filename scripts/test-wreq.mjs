// Test a verified copy so upstream development lockfiles/targets do not alter
// the vendored source or the native artifact's workspace lockfile.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sha256 } from './artifact-identity.mjs';

execFileSync(process.execPath, ['scripts/verify-transport.mjs'], { stdio: 'inherit' });
const source = 'vendor/wreq',
  destination = 'artifacts/upstream-wreq';
const expected = readFileSync('patches/vendor-manifest.json', 'utf8');
rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });
for (const name of ['Cargo.toml', 'LICENSE', 'README.md', 'src'])
  cpSync(`${source}/${name}`, `${destination}/${name}`, { recursive: true });
cpSync('Cargo.lock', `${destination}/Cargo.lock`);
writeFileSync(
  `${destination}/Cargo.toml`,
  `${readFileSync(`${destination}/Cargo.toml`, 'utf8')}\n[workspace]\n`,
);
const configuration = [
  'patch.crates-io.btls.git="https://github.com/0x676e67/btls"',
  'patch.crates-io.btls.rev="3c1dd080ba617d78c63cd09285d2ce31abcdcbf9"',
  'patch.crates-io.btls-sys.git="https://github.com/0x676e67/btls"',
  'patch.crates-io.btls-sys.rev="3c1dd080ba617d78c63cd09285d2ce31abcdcbf9"',
  `patch.crates-io.wreq-proto.path=${JSON.stringify(resolve('vendor/wreq-proto'))}`,
  `patch.crates-io.http2.path=${JSON.stringify(resolve('vendor/http2'))}`,
].flatMap((c) => ['--config', c]);
const args = [
  'test',
  '--manifest-path',
  `${destination}/Cargo.toml`,
  '--lib',
  '--no-default-features',
  '--features',
  'tokio-rt,stream,webpki-roots',
  '--target-dir',
  'target/upstream-wreq',
  ...configuration,
];
execFileSync('cargo', args, { stdio: 'inherit' });
assert.equal(
  sha256(readFileSync('patches/vendor-manifest.json')),
  sha256(expected),
  'Transport manifest changed during tests',
);
execFileSync(process.execPath, ['scripts/verify-transport.mjs'], { stdio: 'inherit' });
writeFileSync(
  `${destination}/tested-command.json`,
  `${JSON.stringify({ command: ['cargo', ...args], features: 'same wreq features as native artifact', manifest: JSON.parse(expected).packages.find((p) => p.name === 'wreq') }, null, 2)}\n`,
);
