import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const versions = ['26.13.1'];
const root = resolve('artifacts/runtimes');
mkdirSync(root, { recursive: true });
const report = [];
for (const version of versions) {
  const filename = `node-v${version}-darwin-arm64.tar.xz`,
    base = `https://nodejs.org/dist/v${version}`;
  const archive = join(root, filename),
    sums = join(root, `${version}-SHASUMS256.txt`);
  for (const [url, path] of [
    [`${base}/SHASUMS256.txt`, sums],
    [`${base}/${filename}`, archive],
  ])
    if (!existsSync(path))
      execFileSync('curl', ['-fsSL', '--retry', '2', url, '-o', path], { stdio: 'inherit' });
  const expected = readFileSync(sums, 'utf8')
    .split('\n')
    .find((line) => line.endsWith(`  ${filename}`))
    ?.split(' ')[0];
  const actual = createHash('sha256').update(readFileSync(archive)).digest('hex');
  if (!expected || expected !== actual) throw Error(`Checksum mismatch for ${filename}`);
  const binary = join(root, `node-v${version}-darwin-arm64/bin/node`);
  if (!existsSync(binary)) execFileSync('tar', ['-xJf', archive, '-C', root]);
  const result = spawnSync(
    binary,
    [
      '--test',
      ...readdirSync('tests')
        .filter((f) => f.endsWith('.test.mjs'))
        .map((f) => `tests/${f}`),
    ],
    { encoding: 'utf8', timeout: 120000 },
  );
  const log = (result.stdout ?? '') + (result.stderr ?? '');
  writeFileSync(`artifacts/qualification/node-${version}.log`, log);
  process.stdout.write(log);
  report.push({
    runtime: 'node',
    version,
    status: result.status,
    signal: result.signal,
    archiveSha256: actual,
    log: `node-${version}.log`,
  });
  if (result.error) throw result.error;
}
writeFileSync(
  'artifacts/qualification/runtime-matrix.json',
  `${JSON.stringify(report, null, 2)}\n`,
);
if (report.some((r) => r.status !== 0)) process.exitCode = 1;
