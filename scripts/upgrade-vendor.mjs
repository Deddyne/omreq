// Moves a vendored or pinned upstream crate to a new release and carries omreq's patch over.
//
//   node scripts/upgrade-vendor.mjs [--dry-run] [--summary <file>] <crate> <version|git-rev|latest> ...
//
// Vendored crates (scripts/upstream.mjs VENDORED): fetch the new upstream source (crates.io
// archive, or `cargo package` at a git revision for git-based crates), apply
// patches/<crate>-<old>.patch (git apply, then a 3-way merge against the old upstream source),
// replace vendor/<crate>, rename the patch, refresh patches/vendor-manifest.json through
// refresh-transport.mjs, then bump Cargo.toml pins, version strings, Cargo.lock and notices.
// Pinned crates (PINNED) and git-pinned btls (GIT_PINNED) only get the pin/lock/string updates.
//
// Exit status 2 means the patch does not apply; the rejected hunks and merge conflicts are
// printed and kept in the work directory. The same version as today re-vendors to no change.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  cargoManifests,
  crateVersions,
  escapeRegExp,
  fetchOk,
  GIT_PINNED,
  MANIFEST,
  newestVersion,
  PINNED,
  pinnedRevision,
  pinnedVersion,
  readJson,
  VENDORED,
} from './upstream.mjs';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 1).length > 0 : false;
};
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const dryRun = flag('--dry-run');
const summaryPath = option('--summary');
const workOption = option('--work');
const work = resolve(workOption ?? mkdtempSync(join(tmpdir(), 'omreq-upgrade-')));
if (!args.length || args.length % 2)
  throw Error(
    'Usage: node scripts/upgrade-vendor.mjs [--dry-run] [--summary <file>] [--work <dir>] <crate> <version|git-rev|latest> ...',
  );
const specs = [];
for (let i = 0; i < args.length; i += 2) specs.push({ name: args[i], target: args[i + 1] });

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const run = (cmd, argv, opts = {}) =>
  execFileSync(cmd, argv, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
const log = (...m) => console.log(...m);
const isRev = (s) => /^[0-9a-f]{7,40}$/.test(s);
const listFiles = (root, dir = '') =>
  existsSync(join(root, dir))
    ? readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? listFiles(root, `${dir}${e.name}/`) : [`${dir}${e.name}`],
      )
    : [];
/** Files the manifest pins, as refresh-transport.mjs lists them. */
const pinnedFiles = (root) =>
  ['Cargo.toml', 'LICENSE', 'build.rs']
    .filter((f) => existsSync(join(root, f)))
    .concat(listFiles(root, 'src/'))
    .sort();
const hashFiles = (root, files) =>
  Object.fromEntries(files.map((f) => [f, sha256(readFileSync(join(root, f)))]));
const copy = (from, to) => {
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true, verbatimSymlinks: true });
};

// ---------------------------------------------------------------- upstream source fetching
const clones = new Map();
function clone(repo) {
  if (!clones.has(repo)) {
    const dir = join(work, 'git', repo.replace('/', '__'));
    if (!existsSync(dir))
      run('git', [
        'clone',
        '--quiet',
        '--filter=blob:none',
        '--no-checkout',
        `https://github.com/${repo}.git`,
        dir,
      ]);
    clones.set(repo, dir);
  }
  return clones.get(repo);
}
const git = (repo, argv) => run('git', ['-C', clone(repo), ...argv]).trim();
function commit(repo, rev) {
  try {
    return git(repo, ['rev-parse', '--verify', `${rev}^{commit}`]);
  } catch {
    git(repo, ['fetch', '--quiet', 'origin', rev]);
    return git(repo, ['rev-parse', '--verify', `${rev}^{commit}`]);
  }
}
/** Extracts `path` of the repository at `rev` into `dir`. */
function exportTree(repo, rev, path, dir) {
  mkdirSync(dir, { recursive: true });
  const tar = spawnSync('git', ['-C', clone(repo), 'archive', '--format=tar', rev, path], {
    maxBuffer: 1024 * 1024 * 1024,
  });
  assert.equal(tar.status, 0, String(tar.stderr));
  run('tar', ['-xf', '-', '-C', dir], { input: tar.stdout });
  return join(dir, path);
}

async function downloadCrate(name, version) {
  const file = join(work, 'crates', `${name}-${version}.crate`);
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    const bytes = Buffer.from(
      await (
        await fetchOk(`https://static.crates.io/crates/${name}/${name}-${version}.crate`)
      ).arrayBuffer(),
    );
    writeFileSync(file, bytes);
  }
  return file;
}
function extractCrate(file, name, version, label) {
  const dir = join(work, label);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  run('tar', ['-xzf', file, '-C', dir]);
  const root = join(dir, `${name}-${version}`);
  const vcs = existsSync(join(root, '.cargo_vcs_info.json'))
    ? readJson(join(root, '.cargo_vcs_info.json'))
    : {};
  return {
    dir: root,
    version,
    rev: vcs.git?.sha1,
    dirty: !!vcs.git?.dirty,
    pathInVcs: vcs.path_in_vcs ?? '',
  };
}

/** Upstream source of a vendored crate: `{dir, version, rev, crateSha256, ...}`. */
async function fetchVendored(name, { version, rev }, label) {
  const config = VENDORED[name];
  if (config.source === 'crate') {
    assert(version, `${name} is vendored from crates.io: give a version, not a git revision`);
    const file = await downloadCrate(name, version);
    const crateSha256 = sha256(readFileSync(file));
    const published = (await crateVersions(name)).find((v) => v.version === version);
    assert(published, `${name} ${version} is not published (or was yanked)`);
    assert.equal(crateSha256, published.checksum, `${name} ${version}: checksum mismatch`);
    return { ...extractCrate(file, name, version, label), crateSha256 };
  }
  // Git-based: the published crate only tells which commit a release was cut from.
  if (!rev) {
    const published = extractCrate(
      await downloadCrate(name, version),
      name,
      version,
      `${label}-published`,
    );
    assert(published.rev, `${name} ${version} was published without VCS info; give a git revision`);
    rev = published.rev;
  }
  rev = commit(config.repo, rev);
  const tree = join(work, 'trees', `${config.repo.replace('/', '__')}-${rev}`);
  if (!existsSync(tree)) git(config.repo, ['worktree', 'add', '--quiet', '--detach', tree, rev]);
  const target = join(work, 'package', rev);
  const meta = JSON.parse(
    run('cargo', ['metadata', '--no-deps', '--format-version', '1'], { cwd: tree }),
  ).packages.find((p) => p.name === name);
  assert(meta, `${name} is not a package of ${config.repo} at ${rev}`);
  const file = join(target, 'package', `${name}-${meta.version}.crate`);
  if (!existsSync(file))
    // Sibling crates of one repository package together, so their path dependencies resolve.
    run(
      'cargo',
      [
        'package',
        ...Object.entries(VENDORED)
          .filter(([, c]) => c.repo === config.repo)
          .flatMap(([n]) => ['-p', n]),
        '--no-verify',
        '--target-dir',
        target,
      ],
      {
        cwd: tree,
        stdio: ['ignore', 'ignore', 'inherit'],
      },
    );
  return {
    ...extractCrate(file, name, meta.version, label),
    rev,
    crateSha256: sha256(readFileSync(file)),
  };
}

// ---------------------------------------------------------------- text and pin updates
const refFiles = () =>
  [
    'Cargo.toml',
    ...cargoManifests(),
    'crates/omreq-napi/src/lib.rs',
    'patches/transport.json',
    'tests/loader-policy.test.mjs',
    'scripts/verify-transport.mjs',
    'scripts/test-wreq.mjs',
  ].filter((f) => existsSync(f));
/** `name 1.2.3`, `name/1.2.3`, `name-1.2.3.patch` and `name = "=1.2.3"` pins. */
function replaceVersion(text, name, from, to) {
  const n = escapeRegExp(name);
  const f = escapeRegExp(from);
  return text
    .replace(new RegExp(`(?<![\\w-])${n}([ /])${f}(?![\\w-]|\\.\\w)`, 'g'), `${name}$1${to}`)
    .replace(new RegExp(`(?<![\\w-])${n}-${f}\\.patch`, 'g'), `${name}-${to}.patch`)
    .replace(new RegExp(`^(${n}\\s*=.*?"=)${f}(")`, 'gm'), (_, a, b) => `${a}${to}${b}`);
}
function editFiles(files, edit) {
  for (const file of files) {
    const before = readFileSync(file, 'utf8');
    const after = edit(before);
    if (after !== before) writeFileSync(file, after);
  }
}

// ---------------------------------------------------------------- patch application
/** git apply needs `--- /dev/null` for created files; refresh-transport labels them a/<file>. */
function normalizePatch(text, root) {
  return text
    .split(/(?=^--- a\/)/m)
    .map((section) => {
      const file = /^--- a\/(\S+)/.exec(section)?.[1];
      if (file && !existsSync(join(root, file)) && /^@@ -0,0 /m.test(section))
        return section.replace(/^--- a\/\S+/, '--- /dev/null');
      return section;
    })
    .join('');
}

function applyPatch(name, entry, oldSource, newSource, stage) {
  const patchText = existsSync(entry.patch) ? readFileSync(entry.patch, 'utf8') : '';
  // Upstream files omreq removed are not in the patch; carry the removal over.
  for (const file of Object.keys(entry.baseFiles))
    if (!entry.effectiveFiles[file]) rmSync(join(stage, file), { force: true });
  if (!patchText.trim()) return { status: 'none' };
  const patchFile = join(work, `${name}.patch`);
  writeFileSync(patchFile, normalizePatch(patchText, stage));
  const attempt = spawnSync('git', ['apply', '--verbose', patchFile], {
    cwd: stage,
    encoding: 'utf8',
  });
  if (attempt.status === 0) {
    const shifted = /offset|fuzz/i.test(attempt.stderr + attempt.stdout);
    return { status: shifted ? 'offsets' : 'clean' };
  }
  log(`${name}: git apply failed, trying a 3-way merge against ${entry.version}`);
  const conflicts = [];
  for (const file of entry.modifiedFiles) {
    const base = join(oldSource.dir, file);
    const ours = join('vendor', name, file);
    const theirs = join(newSource.dir, file);
    const empty = join(work, 'empty');
    writeFileSync(empty, '');
    if (!existsSync(theirs) && existsSync(base)) {
      conflicts.push({ file, text: 'removed upstream but patched by omreq' });
      continue;
    }
    const merged = spawnSync(
      'git',
      [
        'merge-file',
        '-p',
        '--diff3',
        '-L',
        `omreq (${entry.version} + patch)`,
        '-L',
        `upstream ${entry.version}`,
        '-L',
        `upstream ${newSource.version}`,
        ours,
        existsSync(base) ? base : empty,
        existsSync(theirs) ? theirs : empty,
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    assert(merged.status >= 0, merged.stderr);
    mkdirSync(dirname(join(stage, file)), { recursive: true });
    writeFileSync(join(stage, file), merged.stdout);
    if (merged.status > 0) {
      const regions = merged.stdout.match(/^<<<<<<< [^\n]*\n[\s\S]*?^>>>>>>> [^\n]*$/gm) ?? [];
      conflicts.push({ file, text: regions.join('\n\n') });
    }
  }
  if (!conflicts.length) return { status: '3-way' };
  // For the report: the hunks git apply rejects outright.
  const rejects = join(work, 'rejects', name);
  rmSync(rejects, { recursive: true, force: true });
  copy(newSource.dir, rejects);
  spawnSync('git', ['apply', '--reject', patchFile], { cwd: rejects, encoding: 'utf8' });
  const rej = listFiles(rejects)
    .filter((f) => f.endsWith('.rej'))
    .map((f) => `--- ${f}\n${readFileSync(join(rejects, f), 'utf8')}`);
  return { status: 'conflict', conflicts, rejected: rej.join('\n') };
}

// ---------------------------------------------------------------- per-kind upgrades
const manifest = readJson(MANIFEST);
const summary = { crates: [] };
const cargoUpdates = [];
let failed = false;

async function upgradeVendored(name, target) {
  const config = VENDORED[name];
  const entry = manifest.packages.find((p) => p.name === name);
  assert(entry, `${name} is not in ${MANIFEST}`);
  let wanted = isRev(target) ? { rev: target } : { version: target };
  if (target === 'latest')
    wanted =
      config.source === 'git'
        ? { rev: commit(config.repo, 'HEAD') }
        : { version: newestVersion(await crateVersions(name), entry.version) };
  log(
    `${name}: ${entry.version} (${entry.baseRevision.slice(0, 12)}) -> ${wanted.version ?? wanted.rev}`,
  );

  const oldSource = await fetchVendored(
    name,
    config.source === 'git' ? { rev: entry.baseRevision } : { version: entry.version },
    `old-${name}`,
  );
  for (const [file, expected] of Object.entries(entry.baseFiles))
    assert.equal(
      existsSync(join(oldSource.dir, file)) && sha256(readFileSync(join(oldSource.dir, file))),
      expected,
      `${name} ${entry.version}: upstream ${file} differs from the manifest`,
    );
  const newSource = await fetchVendored(name, wanted, `new-${name}`);
  if (config.source === 'git' && newSource.rev !== entry.baseRevision) {
    const ancestor = spawnSync('git', [
      '-C',
      clone(config.repo),
      'merge-base',
      '--is-ancestor',
      entry.baseRevision,
      newSource.rev,
    ]);
    assert.equal(
      ancestor.status,
      0,
      `${name}: ${newSource.rev} does not contain the current base ${entry.baseRevision}; pass a newer git revision`,
    );
  }

  // Stage: the same top-level layout as today's vendor/<name>.
  const stage = join(work, 'stage', name);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  const vendorDir = join('vendor', name);
  const owned = [];
  for (const item of readdirSync(vendorDir)) {
    if (config.extra?.includes(item)) {
      const repoPath = [newSource.pathInVcs, item].filter(Boolean).join('/');
      copy(
        exportTree(config.repo, newSource.rev, repoPath, join(work, 'extra', name)),
        join(stage, item),
      );
    } else if (lstatExists(join(newSource.dir, item))) {
      copy(join(newSource.dir, item), join(stage, item));
    } else {
      copy(join(vendorDir, item), join(stage, item));
      owned.push(item);
    }
  }
  for (const item of ['Cargo.toml', 'LICENSE', 'build.rs', 'src'])
    if (existsSync(join(newSource.dir, item)) && !existsSync(join(stage, item)))
      copy(join(newSource.dir, item), join(stage, item));
  for (const item of owned)
    if (lstatSync(join(stage, item)).isFile())
      editFiles([join(stage, item)], (t) =>
        replaceVersion(t, name, entry.version, newSource.version).replaceAll(
          entry.baseRevision,
          newSource.rev,
        ),
      );

  const result = applyPatch(name, entry, oldSource, newSource, stage);
  const record = {
    name,
    kind: 'vendored',
    repo: config.repo,
    from: entry.version,
    to: newSource.version,
    fromRev: entry.baseRevision,
    toRev: newSource.rev,
    publishedFromDirtyTree: newSource.dirty || undefined,
    patch: result.status,
  };
  summary.crates.push(record);
  if (result.status === 'conflict') {
    failed = true;
    log(`\n${name}: patches/${name}-${entry.version}.patch does not apply to ${newSource.version}`);
    for (const c of result.conflicts) log(`\n=== conflict in ${c.file}\n${c.text}`);
    if (result.rejected) log(`\n=== hunks git apply rejects\n${result.rejected}`);
    log(`\nMerged files with conflict markers: ${stage}`);
    record.conflicts = result.conflicts.map((c) => c.file);
    return;
  }
  log(`${name}: patch ${result.status}`);
  if (dryRun) {
    const diff = spawnSync('git', ['diff', '--no-index', '--stat', vendorDir, stage], {
      encoding: 'utf8',
    });
    log(diff.stdout.trim() || `${name}: no change`);
    return;
  }

  rmSync(vendorDir, { recursive: true, force: true });
  copy(stage, vendorDir);
  const oldPatch = entry.patch;
  Object.assign(entry, {
    version: newSource.version,
    baseRevision: newSource.rev,
    crateSha256: newSource.crateSha256,
    patch: `patches/${name}-${newSource.version}.patch`,
    baseFiles: hashFiles(newSource.dir, pinnedFiles(newSource.dir)),
  });
  const fixtures = manifest[`${name}Fixtures`];
  if (fixtures) {
    // Upstream test fixtures, pinned as git blob ids.
    const blob = (bytes) =>
      createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    manifest[`${name}Fixtures`] = Object.fromEntries(
      config.extra
        .flatMap((item) => listFiles(vendorDir, `${item}/`))
        .sort()
        .map((f) => [f, blob(readFileSync(join(vendorDir, f)))]),
    );
  }
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  run(process.execPath, ['scripts/refresh-transport.mjs', name, newSource.dir], {
    stdio: 'inherit',
  });
  if (oldPatch !== entry.patch && existsSync(oldPatch)) unlinkSync(oldPatch);
  Object.assign(manifest, readJson(MANIFEST));

  editFiles(refFiles(), (t) => replaceVersion(t, name, record.from, record.to));
  const transport = readJson('patches/transport.json');
  if (transport.base?.crate === name) {
    Object.assign(transport.base, {
      version: newSource.version,
      revision: newSource.rev,
      crateSha256: newSource.crateSha256,
    });
    writeFileSync('patches/transport.json', `${JSON.stringify(transport, null, 2)}\n`);
  }
  cargoUpdates.push(`${name}@${record.from}`);
}

function lstatExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

async function upgradePinned(name, target) {
  const config = PINNED[name];
  const from = pinnedVersion(name);
  const versions = await crateVersions(name);
  const to = target === 'latest' ? newestVersion(versions, from) : target;
  assert(
    versions.some((v) => v.version === to),
    `${name} ${to} is not published (or was yanked)`,
  );
  log(`${name}: ${from} -> ${to}`);
  summary.crates.push({ name, kind: 'pinned', repo: config.repo, from, to });
  if (dryRun || from === to) return;
  editFiles(refFiles(), (t) => replaceVersion(t, name, from, to));
  cargoUpdates.push(`${name}@${from}`);
}

async function upgradeGitPinned(name, target) {
  const key = Object.keys(GIT_PINNED).find(
    (k) => k === name || GIT_PINNED[k].crates.includes(name),
  );
  const config = GIT_PINNED[key];
  const fromRev = pinnedRevision(key);
  const toRev = commit(config.repo, target === 'latest' ? 'HEAD' : target);
  const workspaceVersion = (rev) =>
    /\[workspace\.package\][^[]*?^version\s*=\s*"([^"]+)"/m.exec(
      git(config.repo, ['show', `${rev}:Cargo.toml`]),
    )?.[1];
  const submodule = (rev) =>
    config.boringssl && git(config.repo, ['ls-tree', rev, config.boringssl]).split(/\s+/)[2];
  const from = pinnedVersion(key);
  const to = workspaceVersion(toRev) ?? from;
  const record = {
    name: key,
    kind: 'git',
    repo: config.repo,
    from,
    to,
    fromRev,
    toRev,
    boringssl: { from: submodule(fromRev), to: submodule(toRev) },
  };
  log(`${key}: ${fromRev.slice(0, 12)} -> ${toRev.slice(0, 12)} (${from} -> ${to})`);
  summary.crates.push(record);
  if (dryRun || fromRev === toRev) return;
  editFiles(refFiles(), (t) => {
    let out = t.replaceAll(fromRev, toRev);
    if (record.boringssl.from && record.boringssl.to)
      out = out.replaceAll(record.boringssl.from, record.boringssl.to);
    for (const crate of config.crates) out = replaceVersion(out, crate, from, to);
    return out;
  });
  cargoUpdates.push(...config.crates);
}

// ---------------------------------------------------------------- main
for (const { name, target } of specs) {
  if (VENDORED[name]) await upgradeVendored(name, target);
  else if (PINNED[name]) await upgradePinned(name, target);
  else if (Object.entries(GIT_PINNED).some(([k, c]) => k === name || c.crates.includes(name)))
    await upgradeGitPinned(name, target);
  else
    throw Error(
      `Unknown crate ${name}; expected one of ${[...Object.keys(VENDORED), ...Object.keys(PINNED), ...Object.keys(GIT_PINNED)].join(', ')}`,
    );
}

if (!failed && !dryRun && cargoUpdates.length) {
  log(`cargo update ${cargoUpdates.join(' ')}`);
  const update = spawnSync('cargo', ['update', ...cargoUpdates], { stdio: 'inherit' });
  // A spec that no longer matches the lock (already moved by an earlier crate) is not an error.
  if (update.status !== 0) run('cargo', ['metadata', '--format-version', '1'], { stdio: 'ignore' });
  run(process.execPath, ['scripts/notices.mjs'], { stdio: 'inherit' });
  run(process.execPath, ['scripts/verify-transport.mjs'], { stdio: 'inherit' });
}

summary.ok = !failed;
summary.changed = summary.crates.some((c) => c.from !== c.to || c.fromRev !== c.toRev);
if (summaryPath) writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
// Keep the work directory (merged files, rejects) only when the patch did not apply.
if (failed) {
  log(`Work directory: ${work}`);
  process.exit(2);
}
if (!workOption) rmSync(work, { recursive: true, force: true });
