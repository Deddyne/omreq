// Release step: put each downloaded binary into its platform package and make
// sure the tag, every package version and the dependency pins agree.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TARGETS } from './native-target.mjs';

const [tag, downloaded] = process.argv.slice(2);
assert(tag?.startsWith('v') && downloaded, 'usage: release-prepare.mjs <vX.Y.Z> <artifact dir>');
const version = tag.slice(1);
const main = JSON.parse(readFileSync('packages/omreq/package.json', 'utf8'));
assert.equal(main.version, version, `Tag ${tag} does not match packages/omreq ${main.version}`);
assert(!main.private, 'packages/omreq is private');
for (const [key, target] of Object.entries(TARGETS)) {
  const dir = `native/${target.folder}`;
  const manifest = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'));
  assert.equal(manifest.version, version, `${target.package} version`);
  assert(!manifest.private, `${target.package} is private`);
  assert.equal(main.optionalDependencies[target.package], `workspace:${version}`);
  for (const file of ['omreq.node', 'build-manifest.json']) {
    const source = join(downloaded, `native-${key}`, file);
    assert(existsSync(source), `Missing ${source}`);
    copyFileSync(source, `${dir}/${file}`);
  }
  const build = JSON.parse(readFileSync(`${dir}/build-manifest.json`, 'utf8'));
  const sha = createHash('sha256')
    .update(readFileSync(`${dir}/omreq.node`))
    .digest('hex');
  assert.equal(build.sha256, sha, `${target.package} binary does not match its manifest`);
  assert.equal(build.target, target.triple, `${target.package} was built for ${build.target}`);
  assert.equal(build.packageVersion, version, `${target.package} manifest version`);
  for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md'])
    assert(existsSync(`${dir}/${file}`), `${dir}/${file} missing; run pnpm generate`);
  console.log(`${target.package}@${version}: ${sha}`);
}
