import type { Node as JsonNode, ParseError } from 'jsonc-parser';
import { BUNDLED_ALIASES, type BundledProfileName } from './bundled-names.js';
import bundledProfiles from './bundled-profiles.json';
import { OmreqError } from './errors.js';
import { MAX_HEADER_BYTES, MAX_HEADER_PAIRS, PROFILE_FORBIDDEN_HEADERS } from './headers.js';
import { loadNative, type ProfileCheck } from './native.js';
import type { ProfileInputV1 } from './profile-types.js';
import { validateProfile as validate } from './profile-validator.js';

export type { ProfileInputV1 } from './profile-types.js';

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends object
    ? { readonly [P in keyof T]: DeepReadonly<T[P]> }
    : T;
export type ProfileV1 = DeepReadonly<ProfileInputV1>;
// Profiles returned by defineProfile are deep-frozen snapshots built here, so they never need
// to be validated again; their canonical serialization is cached alongside.
const validated = new WeakMap<object, string | undefined>();
let jsonc: typeof import('jsonc-parser') | undefined;
/**
 * Bundled profile names. `'chrome'` is the newest bundled Chrome and the
 * default; `'neutral'` is a plain client without browser emulation.
 */
export type ProfileName = BundledProfileName;
type BundledName = keyof typeof bundledProfiles;
const ALIASES: Readonly<Record<string, BundledName>> = BUNDLED_ALIASES;
export const DEFAULT_PROFILE: ProfileName = 'chrome';
const builtins = new Map<BundledName, ProfileV1>();
function bad(path: string, message: string): never {
  throw new OmreqError('ERR_PROFILE_INVALID', 'configuration', `${path || '/'}: ${message}`);
}
function snapshot(
  value: unknown,
  path = '',
  depth = 0,
  state = { nodes: 0, seen: new Set<object>() },
): unknown {
  if (depth > 16 || ++state.nodes > 4096) bad(path, 'profile complexity limit exceeded');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.length > 262144) bad(path, 'string too long');
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return Object.is(value, -0) ? 0 : value;
  if (typeof value !== 'object' || !value) bad(path, 'expected JSON data');
  if (state.seen.has(value)) bad(path, 'cyclic object');
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null && !Array.isArray(value))
    bad(path, 'expected a plain object');
  if (Object.getOwnPropertySymbols(value).length) bad(path, 'symbol keys are not JSON data');
  state.seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out: unknown[] | Record<string, unknown> = Array.isArray(value)
    ? []
    : (Object.create(null) as Record<string, unknown>);
  if (Array.isArray(value) && value.length > 256) bad(path, 'list too long');
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (Array.isArray(value) && key === 'length') continue;
    if (!('value' in descriptor) || !descriptor.enumerable)
      bad(`${path}/${key}`, 'accessors and non-enumerable fields are forbidden');
    if (Array.isArray(value) && (!/^(0|[1-9][0-9]*)$/.test(key) || +key >= value.length))
      bad(path, 'array properties are forbidden');
    Object.defineProperty(out, key, {
      value: snapshot(descriptor.value, `${path}/${key}`, depth + 1, state),
      enumerable: true,
    });
  }
  if (Array.isArray(value) && Object.keys(out).length !== value.length)
    bad(path, 'sparse arrays are forbidden');
  state.seen.delete(value);
  return Object.freeze(out);
}
export function defineProfile(input: unknown): ProfileV1 {
  if (typeof input === 'object' && input !== null && validated.has(input))
    return input as ProfileV1;
  const profile = snapshot(input);
  if (Buffer.byteLength(JSON.stringify(profile), 'utf8') > 262144)
    bad('/', 'profile exceeds 256 KiB');
  if (!validate(profile)) {
    const issue = validate.errors?.[0];
    bad(issue?.instancePath ?? '/', issue?.message ?? 'invalid profile');
  }
  const p = profile as ProfileV1;
  const tls = p.transport.tls;
  if ((tls?.minVersion ?? '1.2') > (tls?.maxVersion ?? '1.3'))
    bad('/transport/tls', 'minimum TLS version exceeds maximum');
  const version = p.transport.httpVersion ?? 'auto';
  const alpn =
    tls?.alpn ?? (version === '1.1' ? ['http/1.1'] : version === '2' ? ['h2'] : ['h2', 'http/1.1']);
  if (
    (version === '2' && (alpn.length !== 1 || alpn[0] !== 'h2')) ||
    (version === '1.1' && (alpn.length !== 1 || alpn[0] !== 'http/1.1'))
  )
    bad('/transport/tls/alpn', 'ALPN conflicts with strict HTTP version');
  const h1Order = p.transport.http1?.headerOrder;
  if (h1Order && new Set(h1Order.map((name) => name.toLowerCase())).size !== h1Order.length)
    bad('/transport/http1/headerOrder', 'duplicate header name');
  const http2 = p.transport.http2;
  if (http2?.settings) {
    const names = new Set<string>();
    for (const setting of http2.settings) {
      if (names.has(setting.name)) bad('/transport/http2/settings', 'duplicate setting name');
      names.add(setting.name);
    }
    for (const name of ['initialWindowSize', 'maxFrameSize'] as const) {
      if (
        http2[name] !== undefined &&
        http2.settings.find((s) => s.name === name)?.value !== http2[name]
      )
        bad('/transport/http2', 'option conflicts with explicit SETTINGS');
    }
  }
  const http3 = p.transport.http3;
  if (version === '3' && !http3)
    bad('/transport/httpVersion', 'HTTP/3 needs a transport.http3 block');
  if (http3) {
    const settings = new Set<string>();
    for (const setting of http3.settings ?? []) {
      if (settings.has(setting.name)) bad('/transport/http3/settings', 'duplicate setting');
      settings.add(setting.name);
    }
    const parameters = http3.quic?.transportParameters;
    if (parameters) {
      const names = new Set<string>();
      const windows = new Set<number>();
      for (const parameter of parameters) {
        if (parameter.name !== 'custom' && names.has(parameter.name))
          bad('/transport/http3/quic/transportParameters', 'duplicate parameter');
        names.add(parameter.name);
        const bare = ['initialSourceConnectionId', 'versionInformation', 'grease'].includes(
          parameter.name,
        );
        if (bare === (parameter.value !== undefined))
          bad(
            '/transport/http3/quic/transportParameters',
            `${parameter.name} ${bare ? 'takes no' : 'needs a'} value`,
          );
        if (parameter.name.startsWith('initialMaxStreamData')) windows.add(Number(parameter.value));
      }
      if (windows.size > 1)
        bad('/transport/http3/quic/transportParameters', 'stream data limits must be equal');
      if (!names.has('initialSourceConnectionId'))
        bad('/transport/http3/quic/transportParameters', 'initialSourceConnectionId is required');
    }
  }
  // The same forbidden set and limits apply when the profile's headers are
  // merged into a request, so a profile that validates here never fails later.
  let headerBytes = 0;
  for (const [name, value] of p.headers) {
    const n = name.toLowerCase();
    if (
      PROFILE_FORBIDDEN_HEADERS.has(n) ||
      (n === 'te' && value.trim().toLowerCase() !== 'trailers')
    )
      bad('/headers', `profile cannot contain ${name}`);
    headerBytes += name.length + value.length;
  }
  if (p.headers.length > MAX_HEADER_PAIRS || headerBytes > MAX_HEADER_BYTES)
    bad('/headers', `at most ${MAX_HEADER_PAIRS} headers and ${MAX_HEADER_BYTES} bytes`);
  validated.set(p, undefined);
  return p;
}
function duplicates(node: JsonNode, path = '', depth = 0): void {
  if (depth > 16) bad(path, 'profile too deep');
  if (node.type === 'object') {
    const names = new Set<string>();
    for (const property of node.children ?? []) {
      const key = String(property.children?.[0]?.value);
      if (names.has(key)) bad(`${path}/${key}`, 'duplicate object key');
      names.add(key);
      const value = property.children?.[1];
      if (value) duplicates(value, `${path}/${key}`, depth + 1);
    }
  } else
    for (const [i, child] of (node.children ?? []).entries())
      duplicates(child, `${path}/${i}`, depth + 1);
}
export function parseProfile(text: string): ProfileV1 {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 262144)
    bad('/', 'expected JSON text up to 256 KiB');
  jsonc ??= require('jsonc-parser') as typeof import('jsonc-parser');
  const errors: ParseError[] = [];
  const tree = jsonc.parseTree(text, errors, {
    disallowComments: true,
    allowTrailingComma: false,
    allowEmptyContent: false,
  });
  if (errors.length || !tree) bad('/', `invalid JSON at offset ${errors[0]?.offset ?? 0}`);
  duplicates(tree);
  return defineProfile(jsonc.getNodeValue(tree));
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export function serializeProfile(profile: ProfileV1): string {
  const p = defineProfile(profile);
  let text = validated.get(p);
  if (text === undefined) {
    text = canonical(p);
    validated.set(p, text);
  }
  return text;
}
/** A bundled profile by name (`'chrome'`, `'chrome158'`, `'neutral'`, …) or id. */
export function getProfile(name: ProfileName | (string & {})): ProfileV1 {
  const key = typeof name === 'string' ? ALIASES[name] : undefined;
  if (key === undefined)
    throw new OmreqError(
      'ERR_PROFILE_UNKNOWN',
      'configuration',
      `Unknown profile ${JSON.stringify(name)}; expected one of ${Object.keys(ALIASES)
        .filter((k) => !k.includes('/'))
        .join(', ')}`,
    );
  let profile = builtins.get(key);
  if (!profile) {
    profile = defineProfile(bundledProfiles[key]);
    builtins.set(key, profile);
  }
  return profile;
}
/** True when the profile is byte-for-byte one of the bundled profiles. */
export function isBundledProfile(profile: ProfileV1): boolean {
  const text = serializeProfile(profile);
  return (Object.keys(bundledProfiles) as BundledName[]).some(
    (name) => serializeProfile(getProfile(name)) === text,
  );
}
export function listProfiles() {
  return Object.freeze(
    (Object.keys(bundledProfiles) as BundledName[]).map((name) => {
      const p = getProfile(name);
      return Object.freeze({
        name,
        aliases: Object.freeze(
          Object.keys(ALIASES).filter((k) => ALIASES[k] === name && k !== name),
        ),
        id: p.id,
        revision: p.revision,
        default: ALIASES[DEFAULT_PROFILE] === name,
        verification: 'bundled-verified' as const,
        target: p.target,
      });
    }),
  );
}
export async function checkProfile(input: ProfileV1 | ProfileInputV1): Promise<ProfileCheck> {
  const p = defineProfile(input);
  const report = JSON.parse(loadNative().checkProfile(serializeProfile(p))) as ProfileCheck;
  return isBundledProfile(p) ? { ...report, verification: 'bundled-verified' } : report;
}
