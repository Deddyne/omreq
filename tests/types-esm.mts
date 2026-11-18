// Typecheck-only (not a test runner file): the ESM entry point only has named exports, so its
// declarations must not promise a default export.
// @ts-expect-error index.mjs has no default export at runtime.
import type omreq from '../packages/omreq/dist/index.mjs';
import type { createClient, OmreqError, ProfileV1 } from '../packages/omreq/dist/index.mjs';

export type Checks = [typeof omreq, ReturnType<typeof createClient>, OmreqError, ProfileV1];
