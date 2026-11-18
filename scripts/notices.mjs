import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { verifyCookies } from './verify-cookies.mjs';

const flags = new Set(process.argv.slice(2));
if ([...flags].some((flag) => !['--dry-run', '--check'].includes(flag)))
  throw Error('Usage: node scripts/notices.mjs [--dry-run | --check]');
if (flags.size > 1) throw Error('Choose either --dry-run or --check');

const require = createRequire(new URL('../packages/omreq/package.json', import.meta.url));
const metadata = JSON.parse(
  execFileSync('cargo', ['metadata', '--locked', '--format-version', '1'], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  }),
);
// Same output on every OS: Windows checkouts may carry CRLF line endings.
const read = (path) => readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
const items = [];
for (const p of metadata.packages
  .filter((p) => p.source || p.manifest_path.replaceAll('\\', '/').includes('/vendor/'))
  .sort((a, b) => a.name.localeCompare(b.name))) {
  const dir = dirname(p.manifest_path);
  let text = `## ${p.name} ${p.version}\n\nDeclared license: ${p.license ?? 'see license file'}\nSource: ${p.repository ?? p.source}\n`;
  const files = readdirSync(dir)
    .filter((f) => /^(LICENSE|LICENCE|COPYING|NOTICE|COPYRIGHT)(\.|-|$)/i.test(f))
    .sort();
  if (p.license_file && !files.includes(p.license_file)) files.push(p.license_file);
  if (p.name === 'btls-sys')
    for (const f of [
      'deps/boringssl/LICENSE',
      'deps/boringssl/NOTICE',
      'deps/boringssl/third_party/fiat/LICENSE',
      'deps/boringssl/third_party/sike/LICENSE',
    ])
      if (existsSync(join(dir, f))) files.push(f);
  for (const file of files) {
    try {
      const value = read(join(dir, file));
      text += `\n### ${file}\n\n\`\`\`text\n${value}\n\`\`\`\n`;
    } catch {}
  }
  items.push(text);
}
// The static-list crate's code license does not replace the source data notice.
// Include the exact pinned rules source and full data license in every shipped
// notices file, so recipients need no runtime downloader or current-list URL.
const { provenance, packages } = verifyCookies(metadata);
const data = provenance.pslData;
const rules = read(join(packages.get('psl').dir, data.rulesPath));
const dataLicense = read(data.licensePath);
items.push(
  `## Mozilla Public Suffix List data (${data.version})\n\n` +
    `Data license: ${data.license}\n` +
    `Original list project: ${data.upstreamList}\n` +
    `Pinned rules source: ${data.rulesSource}\n` +
    `Rules SHA256: ${data.rulesSha256}\n` +
    `Generated table source: ${data.generatedSource}\n` +
    `Generated table SHA256: ${data.generatedSha256}\n\n` +
    `${data.freshness}\n${data.modifications}\n\n` +
    'The PSL source data notice is retained separately from the MIT/Apache licenses ' +
    'declared by the Rust crates. The following source data and its generated table ' +
    'are not relicensed by the Omreq package license.\n\n' +
    'This Source Code Form is subject to the terms of the Mozilla Public\n' +
    'License, v. 2.0. If a copy of the MPL was not distributed with this\n' +
    'file, You can obtain one at https://mozilla.org/MPL/2.0/.\n\n' +
    `### Exact pinned rules source\n\n\`\`\`text\n${rules}\n\`\`\`\n\n` +
    `### Mozilla Public License 2.0\n\n\`\`\`text\n${dataLicense}\n\`\`\`\n`,
);
// Runtime JS packages ship with the JS package. The generated profile validator contains code
// from Ajv and its fast-deep-equal helper; Ajv itself is a build-time dependency only.
for (const name of ['ajv', 'jsonc-parser', 'fast-deep-equal']) {
  let path;
  try {
    path = require.resolve(`${name}/package.json`);
  } catch {
    const req = createRequire(require.resolve('ajv'));
    path = req.resolve(`${name}/package.json`);
  }
  const dir = dirname(path),
    p = JSON.parse(readFileSync(path));
  let text = `## npm: ${p.name} ${p.version}\n\nDeclared license: ${p.license}\n`;
  for (const file of readdirSync(dir)
    .filter((f) => /^(LICENSE|LICENCE|COPYING|NOTICE)(\.|-|$)/i.test(f))
    .sort())
    text += `\n\`\`\`text\n${read(join(dir, file))}\n\`\`\`\n`;
  items.push(text);
}
const notices =
  '# Third-party notices\n\nThis internal prototype contains and depends on third-party software. This inventory includes build and platform-specific Cargo dependencies conservatively. License expressions retain their upstream meaning; this file does not relicense upstream code. Regenerate using `node scripts/notices.mjs`.\n\n' +
  items.join('\n');
// Package copies (packages/omreq, native/*) are produced by `pnpm generate`.
if (flags.has('--check')) {
  const current = readFileSync('THIRD_PARTY_NOTICES.md', 'utf8');
  if (current !== notices) {
    const [a, b] = [current.split('\n'), notices.split('\n')];
    const line = a.findIndex((l, i) => l !== b[i]);
    throw Error(
      `Stale generated notices: THIRD_PARTY_NOTICES.md line ${line + 1}\n` +
        `  committed: ${JSON.stringify(a[line])}\n  generated: ${JSON.stringify(b[line])}`,
    );
  }
} else if (!flags.has('--dry-run')) writeFileSync('THIRD_PARTY_NOTICES.md', notices);
console.log(
  `${flags.has('--dry-run') ? 'Prepared' : flags.has('--check') ? 'Verified' : 'Generated'} notices for ${items.length} dependency entries, including exact pinned PSL source and MPL-2.0 text`,
);
