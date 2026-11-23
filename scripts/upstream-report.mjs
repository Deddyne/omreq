// Renders the pull request or issue body for one upstream update in
// .github/workflows/upstream.yml from the downloaded job artifacts:
//
//   node scripts/upstream-report.mjs <artifacts-dir> <out.md>
//
// <artifacts-dir>/prepare holds upgrade-vendor.mjs's summary.json and upgrade.log;
// <artifacts-dir>/<target> holds each verify job's status.json and step logs.
// Environment: UPDATE (the update entry from upstream-check.mjs), RUN_URL, BASE_SHA.
// Prints {"ok": boolean} — true when the upgrade applied and every platform passed.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, out] = process.argv.slice(2);
if (!dir || !out) throw Error('Usage: node scripts/upstream-report.mjs <artifacts-dir> <out.md>');
const update = JSON.parse(process.env.UPDATE);
const read = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : '');
const tail = (text, lines = 120) => text.trimEnd().split('\n').slice(-lines).join('\n');
const fence = (text) => `\`\`\`\`text\n${text}\n\`\`\`\``;

const summaryText = read(join(dir, 'prepare', 'summary.json'));
const summary = summaryText ? JSON.parse(summaryText) : { ok: false, crates: [] };
const upgradeLog = read(join(dir, 'prepare', 'upgrade.log'));
const platforms = readdirSync(dir)
  .filter((d) => d !== 'prepare' && existsSync(join(dir, d, 'status.json')))
  .sort()
  .map((d) => ({ dir: join(dir, d), ...JSON.parse(read(join(dir, d, 'status.json'))) }));
const expected = Number(process.env.PLATFORMS ?? 3);
const verified =
  summary.ok &&
  platforms.length === expected &&
  platforms.every((p) =>
    p.steps.every((s) => s.outcome !== 'failure' && s.outcome !== 'cancelled'),
  );
const ok = summary.ok && verified;

const lines = [];
const links = (c) => {
  const repo = `https://github.com/${c.repo}`;
  const list =
    c.kind === 'git'
      ? []
      : [
          `[crates.io](https://crates.io/crates/${c.name}/${c.to})`,
          `[diff.rs](https://diff.rs/${c.name}/${c.from}/${c.to})`,
        ];
  if (c.fromRev && c.toRev && c.fromRev !== c.toRev)
    list.push(`[commits](${repo}/compare/${c.fromRev}...${c.toRev})`);
  list.push(`[releases](${repo}/releases)`);
  return list.join(' · ');
};
const crates = summary.crates.length
  ? summary.crates
  : update.crates.map((c) => ({ ...c, kind: '?' }));
lines.push('| Crate | From | To | Patch | Upstream |', '| --- | --- | --- | --- | --- |');
for (const c of crates) {
  const from = c.fromRev && c.kind === 'git' ? `${c.from} (\`${c.fromRev.slice(0, 8)}\`)` : c.from;
  const to = c.toRev && c.kind === 'git' ? `${c.to} (\`${c.toRev.slice(0, 8)}\`)` : c.to;
  lines.push(`| ${c.name} | ${from} | ${to} | ${c.patch ?? '—'} | ${links(c)} |`);
}
for (const c of crates) {
  if (c.publishedFromDirtyTree)
    lines.push(
      '',
      `${c.name} ${c.to} was published from a dirty tree; the manifest pins the crate archive.`,
    );
  if (c.boringssl && c.boringssl.from !== c.boringssl.to)
    lines.push('', `BoringSSL moves from \`${c.boringssl.from}\` to \`${c.boringssl.to}\`.`);
}
lines.push(
  '',
  'Patch: `clean` applied as is, `offsets` applied at shifted lines, `3-way` merged against the old upstream source (review the merged hunks), `none` no omreq changes.',
);

lines.push('', '### Verification', '');
if (!summary.ok) {
  lines.push(
    `\`node scripts/upgrade-vendor.mjs ${update.args}\` failed:`,
    '',
    fence(tail(upgradeLog, 200)),
  );
} else {
  lines.push('| Platform | Steps |', '| --- | --- |');
  for (const p of platforms)
    lines.push(
      `| ${p.target} | ${p.steps.map((s) => `${s.name}: ${s.outcome}${s.note ? ` (${s.note})` : ''}`).join(', ')} |`,
    );
  if (platforms.length < expected)
    lines.push('', `Only ${platforms.length} of ${expected} platforms reported.`);
  for (const p of platforms)
    for (const s of p.steps.filter((s) => s.outcome === 'failure' && s.log))
      lines.push(
        '',
        `<details><summary>${p.target}: ${s.name} (last lines)</summary>`,
        '',
        fence(tail(read(join(p.dir, s.log)))),
        '',
        '</details>',
      );
}
lines.push('', `Run: ${process.env.RUN_URL ?? 'local'}`);
if (ok)
  lines.push(
    '',
    'Before merging: read the upstream changes above, review any `3-way` merged hunks in `patches/`, and update `patches/transport.json` backport notes if upstream now covers one.',
  );
else
  lines.push(
    '',
    `To reproduce: \`node scripts/upgrade-vendor.mjs ${update.args}\`, then \`pnpm build && pnpm check\`.`,
    'This issue is refreshed when the update is retried; scheduled runs retry after `main` changes.',
  );
// Markers first: GitHub caps bodies at 65536 characters, so long logs are cut from the end.
const markers = `<!-- upstream-id: ${update.id} -->\n<!-- upstream-key: ${update.key} -->\n<!-- upstream-base: ${process.env.BASE_SHA ?? ''} -->\n`;
let body = `${markers}${lines.join('\n')}\n`;
if (body.length > 60000) body = `${body.slice(0, 60000)}\n\n(truncated; see the run logs)\n`;
writeFileSync(out, body);
console.log(JSON.stringify({ ok }));
