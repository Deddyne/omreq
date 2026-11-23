// Upstream sources of the crates omreq vendors or pins. Shared by upgrade-vendor.mjs
// (re-vendors a new release) and upstream-check.mjs (finds new releases).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * Vendored crates: `vendor/<name>` is the upstream source plus `patches/<name>-<version>.patch`.
 * `crate`: the published crates.io archive. `git`: `cargo package` of `path` in the upstream
 * repository at `baseRevision` (used where the published crate lacks what omreq needs).
 * `extra`: top-level paths taken from the upstream git tree rather than the crate archive.
 */
export const VENDORED = {
  wreq: { repo: '0x676e67/wreq', source: 'crate' },
  'wreq-proto': { repo: '0x676e67/wreq-proto', source: 'crate' },
  http2: { repo: '0x676e67/http2', source: 'crate', extra: ['fixtures'] },
  quic: { repo: '0x676e67/quic', source: 'git', path: 'quic', group: 'quic' },
  'quic-proto': { repo: '0x676e67/quic', source: 'git', path: 'quic-proto', group: 'quic' },
  http3: { repo: '0x676e67/http3', source: 'git', path: 'http3' },
};

/** Crates pinned with `=<version>` in a Cargo.toml and taken from crates.io unchanged. */
export const PINNED = {
  'wreq-rt': { repo: '0x676e67/wreq-proto' },
  'chromium-roots': { repo: '0x676e67/chromium-roots' },
  'webpki-root-certs': { repo: 'rustls/webpki-roots' },
};

/** Crates taken from a git revision through `[patch.crates-io]`. */
export const GIT_PINNED = {
  btls: {
    repo: '0x676e67/btls',
    crates: ['btls', 'btls-sys'],
    boringssl: 'btls-sys/deps/boringssl',
  },
};

export const MANIFEST = 'patches/vendor-manifest.json';
export const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

const USER_AGENT = 'omreq-upstream-check';

export async function fetchOk(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: { 'user-agent': USER_AGENT, ...init.headers },
  });
  if (!response.ok) throw Error(`${url}: HTTP ${response.status}`);
  return response;
}

/** All published, non-yanked versions of a crate from the crates.io sparse index. */
export async function crateVersions(name) {
  const n = name.toLowerCase();
  const prefix =
    n.length <= 2
      ? `${n.length}`
      : n.length === 3
        ? `3/${n[0]}`
        : `${n.slice(0, 2)}/${n.slice(2, 4)}`;
  const text = await (await fetchOk(`https://index.crates.io/${prefix}/${n}`)).text();
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((v) => !v.yanked)
    .map((v) => ({ version: v.vers, checksum: v.cksum }));
}

const parse = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(v);
  if (!m) throw Error(`Not a semver version: ${v}`);
  return { core: [+m[1], +m[2], +m[3]], pre: m[4] ? m[4].split('.') : [] };
};
export const isPrerelease = (v) => parse(v).pre.length > 0;
/** Semver precedence: negative when a < b. */
export function compareVersions(a, b) {
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const [p, q] = [x.pre[i], y.pre[i]];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const [pn, qn] = [/^\d+$/.test(p), /^\d+$/.test(q)];
    if (pn && qn) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/**
 * Newest version worth moving to from `current`: the newest stable release, or, while
 * omreq deliberately pins a prerelease, the newest release of any kind.
 */
export function newestVersion(versions, current) {
  const candidates = versions
    .map((v) => v.version)
    .filter((v) => isPrerelease(current) || !isPrerelease(v))
    .sort(compareVersions);
  return candidates.at(-1);
}

/** Current `=x.y.z` pin of a crate in the workspace Cargo.toml files. */
export function pinnedVersion(name) {
  for (const file of ['Cargo.toml', ...cargoManifests()]) {
    const line = readFileSync(file, 'utf8')
      .split('\n')
      .find((l) => new RegExp(`^${escapeRegExp(name)}\\s*=`).test(l));
    const version = line && /"=([^"]+)"/.exec(line)?.[1];
    if (version) return version;
  }
  throw Error(`No =version pin for ${name}`);
}

export function cargoManifests() {
  return execFileSync('git', ['ls-files', 'crates/*/Cargo.toml'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

/** The pinned git revision of a GIT_PINNED crate, from the root Cargo.toml. */
export function pinnedRevision(name) {
  const line = readFileSync('Cargo.toml', 'utf8')
    .split('\n')
    .find((l) => l.startsWith(`${name} = { git =`));
  const rev = line && /rev = "([0-9a-f]{40})"/.exec(line)?.[1];
  if (!rev) throw Error(`No git rev pin for ${name}`);
  return rev;
}

export const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
