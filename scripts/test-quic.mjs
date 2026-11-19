// Runs the vendored quic-proto unit tests (including the Chromium Initial layout and pacing
// backports) on a verified copy, so its development lockfile does not touch the workspace.
import { execFileSync } from 'node:child_process';
import { appendFileSync, cpSync, rmSync } from 'node:fs';

execFileSync(process.execPath, ['scripts/verify-transport.mjs'], { stdio: 'inherit' });
const destination = 'artifacts/upstream-quic-proto';
rmSync(destination, { recursive: true, force: true });
cpSync('vendor/quic-proto', destination, { recursive: true });
appendFileSync(`${destination}/Cargo.toml`, '\n[workspace]\n');
execFileSync(
  'cargo',
  [
    'test',
    '--manifest-path',
    `${destination}/Cargo.toml`,
    '--lib',
    '--locked',
    '--target-dir',
    'target/upstream-quic-proto',
  ],
  { stdio: 'inherit' },
);
execFileSync(process.execPath, ['scripts/verify-transport.mjs'], { stdio: 'inherit' });
