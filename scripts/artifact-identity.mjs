import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { currentTarget } from './native-target.mjs';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export async function artifactIdentity() {
  const javascript = [];
  for (const file of (await readdir('packages/omreq/dist')).sort())
    javascript.push({ file, sha256: sha256(await readFile(`packages/omreq/dist/${file}`)) });
  const nativeSha256 = sha256(await readFile(`${currentTarget().dir}/omreq.node`));
  const manifest = JSON.parse(await readFile(`${currentTarget().dir}/build-manifest.json`, 'utf8'));
  assert.equal(manifest.sha256, nativeSha256, 'Native binary differs from its build manifest');
  return {
    nativeSha256,
    javascriptSha256: sha256(JSON.stringify(javascript)),
    javascript,
    cargoLockSha256: sha256(await readFile('Cargo.lock')),
    pnpmLockSha256: sha256(await readFile('pnpm-lock.yaml')),
  };
}
