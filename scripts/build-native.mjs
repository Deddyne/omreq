import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';

if (process.platform !== 'darwin' || process.arch !== 'arm64')
  throw new Error('Qualification build currently targets macOS arm64');
execFileSync(process.execPath, ['scripts/verify-transport.mjs'], { stdio: 'inherit' });
execFileSync(process.execPath, ['scripts/verify-cookies.mjs'], { stdio: 'inherit' });
// Source paths end up in panic locations and C assertion strings. Map the
// machine-specific prefixes to neutral names so the shipped binary does not
// carry the builder's home directory or checkout location. Later rustc
// remappings win, so the most specific prefixes come last.
const home = homedir();
const prefixes = [
  [home, '~'],
  [`${home}/.cargo`, 'cargo'],
  [`${home}/.rustup`, 'rustup'],
  [process.cwd(), 'omreq'],
];
const rustflags = prefixes.map(([from, to]) => `--remap-path-prefix=${from}=${to}`);
const cflags = prefixes.map(([from, to]) => `-ffile-prefix-map=${from}=${to}`).join(' ');
execFileSync('cargo', ['build', '--release', '--locked', '-p', 'omreq-napi'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    CARGO_ENCODED_RUSTFLAGS: rustflags.join('\x1f'),
    CFLAGS: `${process.env.CFLAGS ?? ''} ${cflags}`.trim(),
    CXXFLAGS: `${process.env.CXXFLAGS ?? ''} ${cflags}`.trim(),
  },
});
const binary = 'native/omreq-darwin-arm64/omreq.node';
const staged = `${binary}.staging`;
copyFileSync('target/release/libomreq_napi.dylib', staged);
execFileSync('install_name_tool', ['-id', '@rpath/omreq.node', staged]);
execFileSync('codesign', ['--force', '--sign', '-', '--timestamp=none', staged], { stdio: 'pipe' });
// Replace the inode atomically: existing consumers may still map the previous binary.
renameSync(staged, binary);
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8' }).trim();
const manifest = {
  packageVersion: '0.0.0-internal.1',
  transportPatches: JSON.parse(readFileSync('patches/transport.json', 'utf8')),
  cookieProvenance: JSON.parse(readFileSync('patches/cookies.json', 'utf8')),
  vendorManifestSha256: createHash('sha256')
    .update(readFileSync('patches/vendor-manifest.json'))
    .digest('hex'),
  stage: 'internal-prototype',
  nodeApi: 8,
  bridgeAbi: JSON.parse(readFileSync('bridge.json', 'utf8')).abi,
  target: 'aarch64-apple-darwin',
  deploymentTarget: '15.0',
  minimumOsVerified: false,
  builtAt: new Date().toISOString(),
  sha256: createHash('sha256').update(readFileSync(binary)).digest('hex'),
  cargoLockSha256: createHash('sha256').update(readFileSync('Cargo.lock')).digest('hex'),
  pnpmLockSha256: createHash('sha256').update(readFileSync('pnpm-lock.yaml')).digest('hex'),
  rust: run('rustc', ['--version']),
  os: run('sw_vers', ['-productVersion']),
  sdk: run('xcrun', ['--show-sdk-version']),
  clang: run('clang', ['--version']),
  cmake: run('cmake', ['--version']),
  linkage: run('otool', ['-L', binary]),
  loadCommands: run('otool', ['-l', binary]),
  dependencyGraph: JSON.parse(run('cargo', ['metadata', '--locked', '--format-version', '1'])),
};
const publicManifest = {
  ...manifest,
  dependencyGraph: {
    packages: manifest.dependencyGraph.packages.map((p) => ({
      name: p.name,
      version: p.version,
      source: p.source,
      license: p.license,
    })),
  },
};
writeFileSync(
  'native/omreq-darwin-arm64/build-manifest.json',
  `${JSON.stringify(publicManifest, null, 2)}\n`,
);
const unresolved = run('nm', ['-u', binary]);
if (/build_script_main_|_SSL_|_X509_|_BIO_/.test(unresolved))
  throw new Error('Unresolved native TLS symbols detected');
if (/\/opt\/homebrew|\/usr\/local/.test(manifest.linkage))
  throw new Error('Unexpected developer-machine dylib linkage');
mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/build-manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Built ${binary}: ${manifest.sha256}`);
