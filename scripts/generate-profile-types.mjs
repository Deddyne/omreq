import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import Ajv from 'ajv';
import standaloneCode from 'ajv/dist/standalone/index.js';
import { compileFromFile } from 'json-schema-to-typescript';
import { nativeDirs } from './native-target.mjs';

const source = 'profiles/profile-v1.schema.json';
const generated = await compileFromFile(source, {
  bannerComment: '/* Generated from profiles/profile-v1.schema.json. Run pnpm generate. */',
  additionalProperties: false,
});
await writeFile('packages/omreq/src/profile-types.ts', generated);
// Bundled profiles by name. The newest Chrome is the default ('chrome').
const bundled = {
  chrome157: JSON.parse(await readFile('profiles/chrome-157-macos.json', 'utf8')),
  neutral: JSON.parse(await readFile('profiles/neutral.json', 'utf8')),
};
await writeFile(
  'packages/omreq/src/bundled-profiles.json',
  `${JSON.stringify(bundled, null, 2)}\n`,
);

await writeFile('packages/omreq/src/bridge-version.json', await readFile('bridge.json'));
// The loader checks the native build against the package version; derive it
// from package.json so the two cannot drift.
const { version } = JSON.parse(await readFile('packages/omreq/package.json', 'utf8'));
await writeFile('packages/omreq/src/version.json', `${JSON.stringify({ version }, null, 2)}\n`);

// Precompile the profile schema so the runtime never loads or compiles Ajv. The options must
// stay equivalent to the former runtime `new Ajv({ allErrors: true, strict: false })`.
const ajv = new Ajv.default({
  allErrors: true,
  strict: false,
  code: { source: true, esm: true },
});
let code = standaloneCode.default(ajv, ajv.compile(JSON.parse(await readFile(source, 'utf8'))));
const header = '"use strict";export const validate = validate10;export default validate10;';
if (!code.startsWith(header)) throw Error('Unexpected Ajv standalone module header');
code = code.slice(header.length);
// Inline Ajv runtime helpers (ucs2length, fast-deep-equal, ...) so the package has no runtime
// dependency on Ajv. Each helper is a self-contained function whose `.code` names its require.
const ajvRequire = createRequire(createRequire(import.meta.url).resolve('ajv'));
const helpers = [];
code = code.replace(/require\("([^"]+)"\)\.default/g, (expression, id) => {
  const helper = ajvRequire(id).default;
  if (typeof helper !== 'function' || helper.code !== expression)
    throw Error(`Cannot inline Ajv runtime helper ${id}`);
  const name = `runtime${helpers.length}`;
  helpers.push(`const ${name} = (${helper.toString()});`);
  return name;
});
if (/\brequire\(/.test(code)) throw Error('Ajv standalone code still requires a module');
await writeFile(
  'packages/omreq/src/profile-validator.ts',
  `// @ts-nocheck
/* Generated from profiles/profile-v1.schema.json by Ajv standalone. Run pnpm generate. */
export interface ProfileValidationError {
  instancePath: string;
  schemaPath: string;
  keyword: string;
  params: Record<string, unknown>;
  message?: string;
}
export interface ProfileValidator {
  (data: unknown): boolean;
  errors?: ProfileValidationError[] | null;
}
${helpers.join('\n')}
${code}
export const validateProfile: ProfileValidator = validate10;
`,
);

// Every published package carries the workspace license and notices.
for (const dir of ['packages/omreq', ...nativeDirs])
  for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) await copyFile(file, `${dir}/${file}`);
