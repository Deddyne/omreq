import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const exports = Object.keys(require('../packages/omreq/dist/index.js')).filter(
  (k) => k !== '__esModule',
);
// The ESM entry re-exports the CJS bindings so both loaders share classes and error brands.
// It has named exports only, so `import omreq from 'omreq'` must not typecheck either:
// index.d.mts re-exports the CJS declarations, which have no default export.
await writeFile(
  'packages/omreq/dist/index.mjs',
  `import api from './index.js';\n${exports.map((name) => `export const ${name} = api.${name};`).join('\n')}\n`,
);
await writeFile('packages/omreq/dist/index.d.mts', "export * from './index.js';\n");
