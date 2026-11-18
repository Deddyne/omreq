import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { currentTarget } from './native-target.mjs';

const target = currentTarget();
const windows = process.platform === 'win32';
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
// MSVC does not understand -ffile-prefix-map; C paths stay in Windows builds.
const cflags = windows
  ? ''
  : prefixes.map(([from, to]) => `-ffile-prefix-map=${from}=${to}`).join(' ');
// Linux: link the C++ runtime statically so the binary only needs glibc.
if (process.platform === 'linux') rustflags.push('-Clink-arg=-static-libstdc++');
execFileSync('cargo', ['build', '--release', '--locked', '-p', 'omreq-napi'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    CARGO_ENCODED_RUSTFLAGS: rustflags.join('\x1f'),
    ...(cflags
      ? {
          CFLAGS: `${process.env.CFLAGS ?? ''} ${cflags}`.trim(),
          CXXFLAGS: `${process.env.CXXFLAGS ?? ''} ${cflags}`.trim(),
        }
      : {}),
  },
});
const binary = `${target.dir}/omreq.node`;
const staged = `${binary}.staging`;
copyFileSync(`target/release/${target.library}`, staged);
if (process.platform === 'darwin') {
  execFileSync('install_name_tool', ['-id', '@rpath/omreq.node', staged]);
  execFileSync('codesign', ['--force', '--sign', '-', '--timestamp=none', staged], {
    stdio: 'pipe',
  });
}
// Replace the inode atomically: existing consumers may still map the previous binary.
renameSync(staged, binary);
const run = (command, args) => {
  try {
    return execFileSync(command, args, { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
};
const platformInfo =
  process.platform === 'darwin'
    ? {
        deploymentTarget: '15.0',
        os: run('sw_vers', ['-productVersion']),
        sdk: run('xcrun', ['--show-sdk-version']),
        clang: run('clang', ['--version']),
        linkage: run('otool', ['-L', binary]),
      }
    : process.platform === 'linux'
      ? {
          os: run('uname', ['-sr']),
          glibc: run('ldd', ['--version'])?.split('\n')[0] ?? null,
          cc: run('cc', ['--version'])?.split('\n')[0] ?? null,
          linkage: run('readelf', ['-d', binary]),
        }
      : { os: run('cmd', ['/c', 'ver']) };
const manifest = {
  packageVersion: JSON.parse(readFileSync(`${target.dir}/package.json`, 'utf8')).version,
  transportPatches: JSON.parse(readFileSync('patches/transport.json', 'utf8')),
  cookieProvenance: JSON.parse(readFileSync('patches/cookies.json', 'utf8')),
  vendorManifestSha256: createHash('sha256')
    .update(readFileSync('patches/vendor-manifest.json'))
    .digest('hex'),
  stage: 'internal-prototype',
  nodeApi: 8,
  bridgeAbi: JSON.parse(readFileSync('bridge.json', 'utf8')).abi,
  target: target.triple,
  builtAt: new Date().toISOString(),
  sha256: createHash('sha256').update(readFileSync(binary)).digest('hex'),
  cargoLockSha256: createHash('sha256').update(readFileSync('Cargo.lock')).digest('hex'),
  pnpmLockSha256: createHash('sha256').update(readFileSync('pnpm-lock.yaml')).digest('hex'),
  rust: run('rustc', ['--version']),
  ...platformInfo,
  cmake: run('cmake', ['--version'])?.split('\n')[0] ?? null,
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
writeFileSync(`${target.dir}/build-manifest.json`, `${JSON.stringify(publicManifest, null, 2)}\n`);
if (process.platform === 'darwin') {
  const unresolved = run('nm', ['-u', binary]);
  if (/build_script_main_|_SSL_|_X509_|_BIO_/.test(unresolved))
    throw new Error('Unresolved native TLS symbols detected');
  if (/\/opt\/homebrew|\/usr\/local/.test(manifest.linkage))
    throw new Error('Unexpected developer-machine dylib linkage');
}
if (process.platform === 'linux') {
  // BoringSSL must bind to its own copy, never to the runtime's OpenSSL.
  const imported = run('nm', ['-D', '--undefined-only', binary]) ?? '';
  if (/\b(SSL|X509|BIO|EVP|CRYPTO)_/.test(imported))
    throw new Error('Unresolved native TLS symbols detected');
  const exported = run('nm', ['-D', '--defined-only', binary]) ?? '';
  if (/\b(SSL|X509|BIO|EVP|CRYPTO)_/.test(exported))
    throw new Error('BoringSSL symbols are exported from the native module');
  const needed = [...(manifest.linkage ?? '').matchAll(/NEEDED.*\[(.+)\]/g)].map((m) => m[1]);
  const allowed = /^(libc|libm|libdl|libpthread|librt|libgcc_s|ld-linux-x86-64)\.so/;
  const unexpected = needed.filter((lib) => !allowed.test(lib));
  if (unexpected.length) throw new Error(`Unexpected shared libraries: ${unexpected.join(', ')}`);
}
mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/build-manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Built ${binary}: ${manifest.sha256}`);
