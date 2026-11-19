// Builds llms-full.txt (and the npm copy) from llms.txt's summary, README and docs/.
import { readFileSync, writeFileSync } from 'node:fs';
import { posix } from 'node:path';

const sources = ['README.md', 'docs/ai.md', 'docs/usage.md', 'docs/profiles.md'];
const repository = 'https://github.com/Deddyne/omreq/blob/main/';
const summary = readFileSync('llms.txt', 'utf8').split('\n## Docs')[0].trimEnd();

function section(path) {
  let text = readFileSync(path, 'utf8');
  // The README's banner and badges are for GitHub; the text starts at its first section.
  if (path === 'README.md') text = text.slice(text.indexOf('\n## ') + 1);
  return (
    text
      // Repository-relative links point at GitHub, since the file is read outside the repo.
      .replace(/\]\((?!https?:|#)([^)#\s]+)(?:#[^)]*)?\)/g, (_, link) => {
        return `](${repository}${posix.normalize(posix.join(posix.dirname(path), link))})`;
      })
      .replace(/<img [^>]*> ?/g, '')
      // Badge images (the comparison table) become their text.
      .replace(/!\[([^\]]*)\]\(https:\/\/img\.shields\.io\/[^)]*\)/g, '$1')
      .split('\n')
      // One heading level down, without the README's emoji markers.
      .map((line) =>
        /^#{1,5} /.test(line)
          ? `#${line.replace(/^(#+) (?:\p{Extended_Pictographic}\uFE0F?\s*)+/u, '$1 ')}`
          : line,
      )
      .join('\n')
      .trim()
  );
}

const full = [
  summary,
  '',
  '',
  'This file is all omreq documentation in one place: README, AI-agent notes, usage guide and profiles guide.',
  ...sources.flatMap((path) => ['', `<!-- source: ${path} -->`, '', section(path)]),
  '',
].join('\n');
for (const out of ['llms-full.txt', 'packages/omreq/llms-full.txt']) writeFileSync(out, full);
