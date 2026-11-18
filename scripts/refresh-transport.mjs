// Developer maintenance only. Builds verify the manifest; they never refresh it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [name, original] = process.argv.slice(2);
assert(
  name && original,
  'Usage: node scripts/refresh-transport.mjs <crate> <verified-original-directory>',
);
const manifestPath = 'patches/vendor-manifest.json';
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const entry = manifest.packages.find((p) => p.name === name);
assert(entry, 'Unknown vendored crate');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
for (const [file, expected] of Object.entries(entry.baseFiles))
  assert.equal(sha(readFileSync(resolve(original, file))), expected, `Wrong original: ${file}`);
function files(path, prefix = '') {
  return readdirSync(path, { withFileTypes: true }).flatMap((item) =>
    item.isDirectory()
      ? files(`${path}/${item.name}`, `${prefix}${item.name}/`)
      : [`${prefix}${item.name}`],
  );
}
const root = `vendor/${name}`;
const paths = ['Cargo.toml', 'LICENSE', ...files(`${root}/src`, 'src/')].sort();
entry.effectiveFiles = Object.fromEntries(
  paths.map((file) => [file, sha(readFileSync(`${root}/${file}`))]),
);
entry.modifiedFiles = paths.filter((file) => entry.effectiveFiles[file] !== entry.baseFiles[file]);
let patch = '';
for (const file of entry.modifiedFiles) {
  const base = resolve(original, file);
  try {
    execFileSync(
      'diff',
      [
        '-u',
        '--label',
        `a/${file}`,
        '--label',
        `b/${file}`,
        existsSync(base) ? base : '/dev/null',
        `${root}/${file}`,
      ],
      { encoding: 'utf8' },
    );
  } catch (error) {
    if (error.status !== 1) throw error;
    patch += error.stdout;
  }
}
writeFileSync(entry.patch, patch);
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  `Refreshed ${name}: review ${entry.modifiedFiles.length} changed files and ${entry.patch}`,
);
