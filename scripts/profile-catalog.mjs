// Bundled Chrome profiles live in profiles/chrome-<major>-<platform>.json, with
// their wire references in fixtures/references/chrome<major>/. Every script and
// test finds them here, so adding a version needs no code changes.
import { existsSync, readdirSync, readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);

/** All bundled Chrome profiles, oldest first. */
export function chromeProfiles() {
  return readdirSync(new URL('profiles/', root))
    .map((file) => /^chrome-(\d+)-[a-z]+\.json$/.exec(file))
    .filter(Boolean)
    .map(([file, major]) => {
      const name = `chrome${major}`;
      return {
        name,
        major: Number(major),
        path: `profiles/${file}`,
        references: `fixtures/references/${name}`,
        qualification: `artifacts/qualification/${name}`,
      };
    })
    .sort((a, b) => a.major - b.major);
}

/** The newest bundled Chrome; the `chrome` alias points here. */
export const latestChrome = () => chromeProfiles().at(-1);

/**
 * The profile a qualification script works on: `--profile chrome158` or
 * OMREQ_PROFILE, otherwise the newest Chrome.
 */
export function selectedProfile(argv = process.argv) {
  const flag = argv.indexOf('--profile');
  const name = flag >= 0 ? argv[flag + 1] : process.env.OMREQ_PROFILE;
  if (!name) return latestChrome();
  const entry = chromeProfiles().find((p) => p.name === name);
  if (!entry)
    throw Error(
      `Unknown profile ${name}; expected one of ${chromeProfiles()
        .map((p) => p.name)
        .join(', ')}`,
    );
  return entry;
}

export const readProfileText = (entry) => readFileSync(new URL(entry.path, root), 'utf8');
export const hasReferences = (entry) => existsSync(new URL(`${entry.references}/`, root));
export const referenceUrl = (entry, file) => new URL(`${entry.references}/${file}`, root);
