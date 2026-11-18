import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const manifestPath = join(root, 'patches/cookies.json');
export const cookieProvenance = () => JSON.parse(readFileSync(manifestPath, 'utf8'));
const readMetadata = () =>
  JSON.parse(
    execFileSync('cargo', ['metadata', '--locked', '--format-version', '1'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    }),
  );
const files = (dir, prefix = '') =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = prefix + entry.name;
    if (entry.isDirectory()) return files(join(dir, entry.name), `${path}/`);
    assert(entry.isFile(), `Cookie provenance rejects non-regular source: ${path}`);
    // Cargo cache bookkeeping is not published or compiled source.
    return ['.cargo-ok', '.cargo-checksum.json'].includes(path) ? [] : [path];
  });
const lockPackages = (lock) =>
  lock
    .split(/^\[\[package\]\]\s*$/m)
    .slice(1)
    .map((block) =>
      Object.fromEntries(
        [...block.matchAll(/^(name|version|source|checksum) = "([^"\n]*)"\s*$/gm)].map(
          ([, key, value]) => [key, value],
        ),
      ),
    );

/** Read-only verification. The frozen manifest is never refreshed by builds. */
export function verifyCookies(metadata = readMetadata(), provenance = cookieProvenance()) {
  assert.equal(provenance.schemaVersion, 1, 'Unsupported cookie provenance schema');
  assert.deepEqual(
    provenance.packages.map((p) => p.name).sort(),
    ['psl', 'psl-types'],
    'Cookie provenance must cover the static list and list matcher (the parser is in-tree)',
  );
  const lock = lockPackages(readFileSync(join(root, 'Cargo.lock'), 'utf8'));
  const packages = new Map();
  for (const pin of provenance.packages) {
    const selected = metadata.packages.filter((p) => p.name === pin.name);
    assert.equal(selected.length, 1, `Expected one qualified ${pin.name} package`);
    const pkg = selected[0];
    assert.equal(pkg.version, pin.version, `Unreviewed ${pin.name} version`);
    assert.equal(pkg.source, pin.registrySource, `Unreviewed ${pin.name} source`);
    assert.equal(pkg.repository, pin.repository, `Changed ${pin.name} repository`);
    assert.equal(pkg.license, pin.declaredLicense, `Changed ${pin.name} declared license`);
    const entries = lock.filter((p) => p.name === pin.name && p.version === pin.version);
    assert.equal(entries.length, 1, `Missing or duplicate ${pin.name} lockfile package`);
    assert.equal(entries[0].source, pin.registrySource, `Changed ${pin.name} registry`);
    assert.equal(entries[0].checksum, pin.registryChecksum, `Changed ${pin.name} archive checksum`);
    const dir = dirname(pkg.manifest_path);
    assert.deepEqual(
      files(dir).sort(),
      Object.keys(pin.effectiveFiles).sort(),
      `Unreviewed ${pin.name} published file set`,
    );
    for (const [path, digest] of Object.entries(pin.effectiveFiles)) {
      assert.equal(relative(dir, resolve(dir, path)), path, 'Unsafe provenance source path');
      assert.equal(
        sha(readFileSync(join(dir, path))),
        digest,
        `Unreviewed cookie source change: ${pin.name}/${path}`,
      );
    }
    const vcs = JSON.parse(readFileSync(join(dir, '.cargo_vcs_info.json'), 'utf8'));
    assert.equal(vcs.git.sha1, pin.revision, `Unreviewed ${pin.name} source revision`);
    packages.set(pin.name, { ...pkg, dir });
  }
  const core = metadata.packages.find((p) => p.name === 'omreq-core');
  assert(core, 'Missing Rust cookie owner');
  const coreNode = metadata.resolve.nodes.find((n) => n.id === core.id);
  for (const name of ['psl']) {
    assert(
      coreNode?.deps.some((d) => d.name === name && d.pkg === packages.get(name).id),
      `Core does not directly resolve the qualified ${name}`,
    );
  }
  const psl = provenance.packages.find((p) => p.name === 'psl');
  const data = provenance.pslData;
  assert.equal(data.version, `psl/${psl.version}`);
  assert.equal(data.crateRevision, psl.revision);
  assert.equal(data.rulesSha256, psl.effectiveFiles[data.rulesPath]);
  assert.equal(data.generatedSha256, psl.effectiveFiles[data.generatedPath]);
  assert.equal(data.license, 'MPL-2.0');
  assert.equal(relative(root, resolve(root, data.licensePath)), data.licensePath);
  assert.equal(
    sha(readFileSync(join(root, data.licensePath))),
    data.licenseSha256,
    'Changed PSL data license text',
  );
  const source = readFileSync(join(root, 'crates/omreq-core/src/cookies.rs'), 'utf8');
  assert.equal(
    source.match(/PSL_VERSION:\s*&str\s*=\s*"([^"]+)"/)?.[1],
    data.version,
    'Core PSL version differs from frozen provenance',
  );
  return { provenance, packages };
}

function selfTest(metadata) {
  verifyCookies(metadata);
  const temp = mkdtempSync(join(tmpdir(), 'omreq-cookie-provenance-'));
  try {
    const copy = structuredClone(metadata);
    for (const pkg of copy.packages.filter((p) => ['psl', 'psl-types'].includes(p.name))) {
      const dir = join(temp, `${pkg.name}-${pkg.version}`);
      cpSync(dirname(pkg.manifest_path), dir, { recursive: true });
      pkg.manifest_path = join(dir, 'Cargo.toml');
    }
    verifyCookies(copy);
    const psl = copy.packages.find((p) => p.name === 'psl');
    const list = join(dirname(psl.manifest_path), 'src/list.rs');
    const original = readFileSync(list);
    writeFileSync(list, Buffer.concat([original, Buffer.from('\n// changed\n')]));
    assert.throws(() => verifyCookies(copy), /Unreviewed cookie source change/);
    writeFileSync(list, original);
    const unexpected = join(dirname(psl.manifest_path), 'src/unreviewed.rs');
    writeFileSync(unexpected, '// unreviewed\n');
    assert.throws(() => verifyCookies(copy), /published file set/);
    rmSync(unexpected);
    const changedPin = cookieProvenance();
    changedPin.packages.find((p) => p.name === 'psl').registryChecksum = '0'.repeat(64);
    assert.throws(() => verifyCookies(copy, changedPin), /archive checksum/);
    const changedVersion = structuredClone(copy);
    changedVersion.packages.find((p) => p.name === 'psl').version = '2.1.255';
    assert.throws(() => verifyCookies(changedVersion), /Unreviewed psl version/);
    const changedSource = structuredClone(copy);
    changedSource.packages.find((p) => p.name === 'psl-types').source =
      'registry+https://other.invalid';
    assert.throws(() => verifyCookies(changedSource), /Unreviewed psl-types source/);
    console.log(
      'Cookie provenance self-test passed: changed source, file set, checksum, version and registry rejected',
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert(
    process.argv.length <= 3 && (!process.argv[2] || process.argv[2] === '--self-test'),
    'Usage: node scripts/verify-cookies.mjs [--self-test]',
  );
  const metadata = readMetadata();
  if (process.argv[2]) selfTest(metadata);
  else {
    const { provenance } = verifyCookies(metadata);
    console.log(
      `Verified ${provenance.packages.length} pinned cookie/PSL crates and ${provenance.pslData.version} data/table/license source`,
    );
  }
}
