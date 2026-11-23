// Finds upstream releases newer than what omreq vendors or pins, and a Chrome stable major
// newer than the newest bundled profile. Used by .github/workflows/upstream.yml.
//
//   node scripts/upstream-check.mjs
//
// Prints (and with GITHUB_OUTPUT, writes) `updates`: one entry per pull request to try, each
// with the upgrade-vendor.mjs arguments, and `chrome`: the new Chrome major, if any. With
// GH_TOKEN set it leaves out updates that already have an open pull request, an open issue
// from a run on the same commit, or a declined pull request (UPSTREAM_RETRY=true retries those).
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { latestChrome } from './profile-catalog.mjs';
import {
  compareVersions,
  crateVersions,
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

const manifest = readJson(MANIFEST);
const units = new Map();
function add(key, crate) {
  const unit = units.get(key) ?? { key, crates: [] };
  unit.crates.push(crate);
  units.set(key, unit);
}

for (const [name, config] of Object.entries(VENDORED)) {
  const from = manifest.packages.find((p) => p.name === name).version;
  const to = newestVersion(await crateVersions(name), from);
  if (to && compareVersions(to, from) > 0)
    add(config.group ?? name, { name, repo: config.repo, from, to, target: to });
}
for (const [name, config] of Object.entries(PINNED)) {
  const from = pinnedVersion(name);
  const to = newestVersion(await crateVersions(name), from);
  if (to && compareVersions(to, from) > 0)
    add(name, { name, repo: config.repo, from, to, target: to });
}
for (const [name, config] of Object.entries(GIT_PINNED)) {
  const from = pinnedRevision(name);
  const to = execFileSync('git', ['ls-remote', `https://github.com/${config.repo}`, 'HEAD'], {
    encoding: 'utf8',
  }).split(/\s/)[0];
  if (to && to !== from)
    add(name, { name, repo: config.repo, from: from.slice(0, 8), to: to.slice(0, 8), target: to });
}

const updates = [...units.values()].map((unit) => {
  const version = unit.crates[0].to;
  const id = `${unit.key}-${version}`;
  return {
    id,
    key: unit.key,
    branch: `upstream/${id}`,
    title: `Update ${unit.crates.map((c) => `${c.name} to ${c.to}`).join(', ')}`,
    args: unit.crates.map((c) => `${c.name} ${c.target}`).join(' '),
    crates: unit.crates,
  };
});

const versions = (
  await (
    await fetchOk(
      'https://versionhistory.googleapis.com/v1/chrome/platforms/mac/channels/stable/versions?pageSize=20',
    )
  ).json()
).versions.map((v) => v.version);
const stable = versions.sort((a, b) => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  return x.reduce((r, n, i) => r || n - y[i], 0);
})[versions.length - 1];
const profile = latestChrome();
const chrome =
  Number(stable.split('.')[0]) > profile.major
    ? { major: Number(stable.split('.')[0]), version: stable, profile: profile.major }
    : null;

// Leave out what is already waiting for review or already failed on this commit.
let pending = updates;
if (process.env.GH_TOKEN) {
  const gh = (args) => JSON.parse(execFileSync('gh', args, { encoding: 'utf8' }));
  const prs = gh([
    'pr',
    'list',
    '--state',
    'all',
    '--label',
    'upstream',
    '--limit',
    '500',
    '--json',
    'headRefName,state',
  ]);
  const issues = gh([
    'issue',
    'list',
    '--state',
    'open',
    '--label',
    'upstream',
    '--limit',
    '500',
    '--json',
    'body',
  ]);
  const retry = process.env.UPSTREAM_RETRY === 'true';
  const head =
    process.env.GITHUB_SHA ??
    execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  pending = updates.filter((u) => {
    // An open pull request waits for review; a closed one was declined (retry reopens it).
    const pr = prs.find((p) => p.headRefName === u.branch);
    if (pr && (pr.state === 'OPEN' || !retry)) return false;
    const issue = issues.find((i) => i.body.includes(`<!-- upstream-id: ${u.id} -->`));
    return retry || !issue?.body.includes(`<!-- upstream-base: ${head} -->`);
  });
}

console.log(JSON.stringify({ updates, pending: pending.map((u) => u.id), chrome }, null, 2));
if (process.env.GITHUB_OUTPUT)
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `updates=${JSON.stringify(pending)}\nchrome=${chrome ? JSON.stringify(chrome) : ''}\n`,
  );
