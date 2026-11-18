// Supported native targets. The loader in packages/omreq/src/native.ts keeps
// the same mapping; tests/native-target.test.mjs checks they agree.
export const TARGETS = Object.freeze({
  'darwin-arm64': {
    package: 'omreq-darwin-arm64',
    triple: 'aarch64-apple-darwin',
    library: 'libomreq_napi.dylib',
    label: 'macOS arm64',
  },
  'linux-x64': {
    package: 'omreq-linux-x64-gnu',
    triple: 'x86_64-unknown-linux-gnu',
    library: 'libomreq_napi.so',
    label: 'Linux x64 (glibc)',
  },
  'win32-x64': {
    package: 'omreq-win32-x64-msvc',
    triple: 'x86_64-pc-windows-msvc',
    library: 'omreq_napi.dll',
    label: 'Windows x64',
  },
});

export function currentTarget() {
  const key = `${process.platform}-${process.arch}`;
  const target = TARGETS[key];
  if (!target) throw new Error(`Unsupported build platform ${key}`);
  return { key, ...target, dir: `native/${target.package}` };
}

export const nativeDirs = Object.values(TARGETS).map((t) => `native/${t.package}`);
