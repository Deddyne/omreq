import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const manifest = JSON.parse(readFileSync('patches/vendor-manifest.json', 'utf8'));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const allFiles = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? allFiles(join(dir, entry.name)) : [join(dir, entry.name)],
  );
for (const p of manifest.packages) {
  for (const [path, expected] of Object.entries(p.effectiveFiles))
    if (sha(readFileSync(`vendor/${p.name}/${path}`)) !== expected)
      throw Error(`Unreviewed native source change: ${p.name}/${path}`);
  for (const path of allFiles(`vendor/${p.name}/src`)) {
    const relative = path.replaceAll('\\', '/').slice(`vendor/${p.name}/`.length);
    if (!p.effectiveFiles[relative]) throw Error(`Unreviewed native source file: ${path}`);
  }
}
for (const [path, expected] of Object.entries(manifest.http2Fixtures)) {
  const bytes = readFileSync(`vendor/http2/${path}`);
  const actual = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if (actual !== expected) throw Error(`Changed upstream HPACK fixture: ${path}`);
}
const lock = readFileSync('Cargo.lock', 'utf8');
if (
  !lock.includes(
    'git+https://github.com/0x676e67/btls?rev=5ec1c113a03626a5877b34dd6d2ea8d440897a91#5ec1c113a03626a5877b34dd6d2ea8d440897a91',
  )
)
  throw Error('TLS source is not pinned to the qualified revision');
console.log(
  `Verified ${manifest.packages.length} vendored crates and ${Object.keys(manifest.http2Fixtures).length} pinned upstream HPACK fixture files`,
);
