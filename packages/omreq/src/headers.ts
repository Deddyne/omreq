import { invalid } from './errors.js';
export type HeaderInput =
  | Readonly<Record<string, string | readonly string[] | null>>
  | readonly (readonly [string, string])[]
  | Headers
  | ReadonlyMap<string, string | readonly string[] | null>;
export type Pair = [string, string];
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
export function headerName(name: unknown): string {
  if (typeof name !== 'string' || !TOKEN.test(name)) invalid('Invalid header name');
  return name.toLowerCase();
}
function headerValue(value: unknown): string {
  if (typeof value !== 'string' || /[^\t\x20-\x7e\x80-\xff]/.test(value))
    invalid('Invalid header value');
  return value;
}
/**
 * Header names the transport owns. They are rejected in every layer (profile,
 * client and request) so a profile that validates never fails per request.
 * `te` is allowed only with the value `trailers`, the one value HTTP/2 permits.
 */
export const TRANSPORT_HEADERS: ReadonlySet<string> = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'proxy-authorization',
  'content-length',
]);
/** Profiles describe a client, never a session: credentials are rejected too. */
export const PROFILE_FORBIDDEN_HEADERS: ReadonlySet<string> = new Set([
  ...TRANSPORT_HEADERS,
  'cookie',
  'authorization',
]);
/** Runtime limits on the merged request header list, shared by every layer. */
export const MAX_HEADER_PAIRS = 200;
export const MAX_HEADER_BYTES = 65536;
/**
 * Validates one name/value pair against the shared rules and returns the
 * lowercase name. Throws ERR_INVALID_ARGUMENT with `message(name)` when the
 * name is forbidden in this layer.
 */
export function checkHeader(
  name: unknown,
  value: unknown,
  forbidden: ReadonlySet<string> = TRANSPORT_HEADERS,
  message: (name: string) => string = (n) => `Transport manages ${n}`,
): string {
  const n = headerName(name);
  if (forbidden.has(n)) invalid(message(n));
  const v = headerValue(value);
  if (n === 'te' && v.trim().toLowerCase() !== 'trailers') invalid(message('te'));
  return n;
}
/** Applies the shared count/byte limits to a complete header list. */
export function checkHeaderList(
  pairs: Iterable<readonly [string, string]>,
  message = 'Request headers exceed the prototype limit',
): void {
  let count = 0;
  let bytes = 0;
  for (const [key, value] of pairs) {
    count++;
    bytes += key.length + value.length;
  }
  if (count > MAX_HEADER_PAIRS || bytes > MAX_HEADER_BYTES) invalid(message);
}
function groups(layer: HeaderInput | undefined): Map<string, Pair[]> {
  const result = new Map<string, Pair[]>();
  if (layer === undefined) return result;
  if (!layer || typeof layer !== 'object') invalid('headers: expected an object or pairs');
  const add = (key: unknown, value: unknown, group?: Pair[]): Pair[] => {
    const n = checkHeader(key, value);
    const values = group ?? result.get(n) ?? [];
    values.push([n, value as string]);
    // RFC 6265 allows one Cookie field; several would be sent as separate
    // HTTP/1 fields (or joined with ", " by intermediaries).
    if (n === 'cookie' && values.length > 1)
      invalid('Only one cookie header is allowed; join cookies with "; "');
    result.set(n, values);
    return values;
  };
  const pairs = (list: Iterable<unknown>) => {
    for (const pair of list) {
      if (!Array.isArray(pair) || pair.length !== 2) invalid('headers: expected name/value pairs');
      add(pair[0], pair[1]);
    }
  };
  const record = (entries: Iterable<[unknown, unknown]>) => {
    for (const [key, raw] of entries) {
      const list = raw === null ? [] : Array.isArray(raw) ? raw : [raw];
      if (!list.length) {
        // `null` (or []) removes an inherited header: an empty group replaces it.
        const n = headerName(key);
        if (TRANSPORT_HEADERS.has(n)) invalid(`Transport manages ${n}`);
        result.set(n, result.get(n) ?? []);
        continue;
      }
      let group: Pair[] | undefined;
      for (const value of list) group = add(key, value, group);
    }
  };
  // Headers and Map have no own enumerable fields, so Object.entries would
  // silently drop every header. Any other non-plain object is rejected.
  const proto = Object.getPrototypeOf(layer);
  if (Array.isArray(layer)) pairs(layer);
  else if (typeof Headers === 'function' && layer instanceof Headers) pairs(layer);
  else if (layer instanceof Map) record(layer.entries());
  else if (proto === Object.prototype || proto === null) record(Object.entries(layer));
  else invalid('headers: expected a plain object, name/value pairs, Headers or Map');
  return result;
}
export function snapshotHeaders(input: HeaderInput | undefined): HeaderInput {
  const result: Record<string, readonly string[] | null> = Object.create(null);
  const normalized = groups(input);
  checkHeaderList([...normalized.values()].flat());
  for (const [name, values] of normalized)
    result[name] = values.length ? Object.freeze(values.map(([, value]) => value)) : null;
  return Object.freeze(result);
}
export function headerOverrideNames(...layers: (HeaderInput | undefined)[]): string[] {
  return [...new Set(layers.flatMap((layer) => [...groups(layer).keys()]))];
}
/** Header groups of several layers, later layers replacing whole names. */
export function headerGroups(
  ...layers: (HeaderInput | undefined)[]
): ReadonlyMap<string, readonly Pair[]> {
  const result = new Map<string, Pair[]>();
  for (const layer of layers) for (const [name, pairs] of groups(layer)) result.set(name, pairs);
  checkHeaderList([...result.values()].flat());
  return result;
}
/**
 * Pairs of pre-validated (and size-checked) base groups with one more layer
 * applied on top. The layer is validated once; its names extend
 * `baseOverrides`, which is returned unchanged when there is no layer.
 */
export function mergeOnto(
  base: ReadonlyMap<string, readonly Pair[]>,
  layer: HeaderInput | undefined,
  baseOverrides: readonly string[],
): { headers: Pair[]; overrides: readonly string[] } {
  const pairs: Pair[] = [];
  if (layer === undefined) {
    for (const group of base.values()) for (const pair of group) pairs.push(pair);
    return { headers: pairs, overrides: baseOverrides };
  }
  const extra = groups(layer);
  const copy = new Map(base);
  for (const [name, group] of extra) copy.set(name, group);
  for (const group of copy.values()) for (const pair of group) pairs.push(pair);
  checkHeaderList(pairs);
  const overrides = [...baseOverrides];
  for (const name of extra.keys()) if (!overrides.includes(name)) overrides.push(name);
  return { headers: pairs, overrides };
}
type HeaderPair = readonly [string, string];
function parseRaw(raw: string): readonly HeaderPair[] {
  const pairs: HeaderPair[] = [];
  let start = 0;
  while (start < raw.length) {
    const split = raw.indexOf('\0', start);
    const end = raw.indexOf('\0', split + 1);
    pairs.push(Object.freeze([raw.slice(start, split), raw.slice(split + 1, end)] as const));
    start = end + 1;
  }
  return Object.freeze(pairs);
}
export class ResponseHeaders implements Iterable<HeaderPair> {
  // Native responses carry `name\0value\0…` with lowercase names; it is only
  // split into pairs when the headers are first read.
  #raw: string | undefined;
  #parsed: readonly HeaderPair[] | undefined;
  constructor(input: string | readonly HeaderPair[]) {
    if (typeof input === 'string') this.#raw = input;
    else this.#parsed = Object.freeze(input.map((p) => Object.freeze([p[0], p[1]] as const)));
    Object.freeze(this);
  }
  get #pairs(): readonly HeaderPair[] {
    if (this.#parsed === undefined) {
      this.#parsed = parseRaw(this.#raw as string);
      this.#raw = undefined;
    }
    return this.#parsed;
  }
  /**
   * All values of `name` joined with ", ", like fetch's `Headers.get()`.
   * Set-Cookie values cannot be joined safely (Expires contains commas), so
   * `get('set-cookie')` returns the first one; use `getSetCookie()`.
   */
  get(name: string): string | null {
    const wanted = name.toLowerCase();
    let joined: string | null = null;
    for (const [n, v] of this.#pairs)
      if (n.toLowerCase() === wanted) {
        if (joined === null) {
          joined = v;
          if (wanted === 'set-cookie') break;
        } else joined += `, ${v}`;
      }
    return joined;
  }
  has(name: string): boolean {
    const wanted = name.toLowerCase();
    for (const [n] of this.#pairs) if (n.toLowerCase() === wanted) return true;
    return false;
  }
  /** Every Set-Cookie field value, in order, like fetch's `Headers.getSetCookie()`. */
  getSetCookie(): readonly string[] {
    return this.getAll('set-cookie');
  }
  getAll(name: string): readonly string[] {
    const wanted = name.toLowerCase();
    const values: string[] = [];
    for (const [n, v] of this.#pairs) if (n.toLowerCase() === wanted) values.push(v);
    return Object.freeze(values);
  }
  [Symbol.iterator]() {
    return this.#pairs[Symbol.iterator]();
  }
}
