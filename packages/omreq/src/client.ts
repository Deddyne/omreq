import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';
import { invalid, keys, nativeError, OmreqError, positive } from './errors.js';
import {
  type HeaderInput,
  headerGroups,
  headerOverrideNames,
  mergeOnto,
  type Pair,
  snapshotHeaders,
} from './headers.js';
import {
  loadNative,
  type NativeClient,
  type NativeOperation,
  type ProfileCheck,
} from './native.js';
import {
  DEFAULT_PROFILE,
  defineProfile,
  getProfile,
  isBundledProfile,
  type ProfileName,
  type ProfileV1,
  serializeProfile,
} from './profile.js';
import {
  type DecodeOptions,
  OmreqResponse,
  type RedirectHop,
  type ResponseMeta,
} from './response.js';
import {
  type BodyInput,
  type PreparedBody,
  prepareBody,
  startUpload,
  type UploadControl,
} from './upload.js';
export interface Timeouts {
  queueMs?: number;
  headersMs?: number;
  uploadIdleMs?: number;
  bodyIdleMs?: number;
  consumerIdleMs?: number | null;
  totalMs?: number | null;
}
export interface RedirectOptions {
  redirect?: 'follow' | 'manual' | 'error';
  maxRedirects?: number;
  allowInsecureRedirects?: boolean;
  sensitiveHeaders?: readonly string[];
}
export interface RequestOptions extends RedirectOptions {
  method?: string;
  headers?: HeaderInput;
  body?: BodyInput;
  json?: unknown;
  form?: URLSearchParams | readonly (readonly [string, string])[];
  searchParams?: URLSearchParams | readonly (readonly [string, string])[];
  signal?: AbortSignal;
  timeouts?: Timeouts;
  maxResponseBytes?: number | null;
  maxBufferedResponseBytes?: number;
  /**
   * Transparently decode gzip, deflate, br and (where the runtime supports it)
   * zstd response bodies. Defaults to the client option, which defaults to
   * true. Bodies are never decoded when `accept-encoding` is set explicitly in
   * client or request headers.
   */
  decompress?: boolean;
}
/**
 * Proxy routes. `url` carries all traffic; `http`/`https` override it per
 * target scheme. URLs use http, https, socks4, socks4a, socks5 or socks5h and
 * may embed `user:password@` credentials. `noProxy` lists hosts, domains
 * (matching subdomains), IPs or CIDR ranges that connect directly; `*`
 * bypasses every proxy.
 */
export interface ProxyOptions {
  url?: string | URL;
  http?: string | URL;
  https?: string | URL;
  noProxy?: string | readonly string[];
}
export interface ClientOptions extends RedirectOptions {
  /**
   * A proxy URL, explicit routes, or `'env'` to read HTTP_PROXY, HTTPS_PROXY,
   * ALL_PROXY and NO_PROXY once at construction. Omitted or `false`: direct
   * connections; environment variables are never applied implicitly.
   */
  proxy?: string | URL | ProxyOptions | 'env' | false;
  /**
   * Fixed IP addresses per host name, used instead of DNS (like curl
   * `--resolve`). The port and TLS server name still come from the URL.
   */
  resolve?: Readonly<Record<string, string | readonly string[]>>;
  cookies?: boolean;
  /**
   * `'chrome'` (default, the newest bundled Chrome), `'chrome158'`,
   * `'neutral'` (no browser emulation) or a custom profile from defineProfile.
   */
  profile?: ProfileName | ProfileV1;
  baseUrl?: string | URL;
  headers?: HeaderInput;
  ca?: string;
  trustStore?: 'bundled' | 'chromium';
  /**
   * Use HTTP/3 when the profile describes it (default `true`): origins that advertise h3
   * through Alt-Svc or a DNS HTTPS record are reached over QUIC, falling back to TCP when
   * QUIC fails. `false` keeps every request on TCP.
   */
  http3?: boolean;
  maxActiveOperations?: number;
  maxActivePerOrigin?: number;
  maxConnections?: number;
  maxConnectionsPerOrigin?: number;
  maxQueuedOperations?: number;
  maxInputChunkBytes?: number;
  maxRetainedRequestBodyBytes?: number;
  maxBufferedResponseBytes?: number;
  maxAggregateBufferedResponseBytes?: number;
  connectMs?: number;
  timeouts?: Timeouts;
  /** Default for RequestOptions.decompress; true when omitted. */
  decompress?: boolean;
}
export interface CloseOptions {
  /** Let admitted requests and their bodies finish before closing. */
  graceful?: boolean;
  /** Upper bound for a graceful drain; remaining work is then cancelled. */
  timeoutMs?: number;
}
export interface OriginAdmissionStats {
  readonly origin: string;
  readonly activeOperations: number;
  readonly waitingOperations: number;
}
export interface CookieRecord {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
  readonly hostOnly: boolean;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly sameSite: 'Strict' | 'Lax' | 'None' | null;
  readonly expiresAt: number | null;
}
export interface CookieStore {
  setCookie(value: string, url: string | URL): Promise<void>;
  getCookies(url: string | URL): Promise<readonly CookieRecord[]>;
  clear(): Promise<void>;
}
export interface ClientStats {
  readonly cookieCount: number;
  readonly cookieBytes: number;
  readonly discardedCookies: number;
  readonly partitionedCookies: number;
  readonly evictedCookies: number;
  readonly activeOperations: number;
  readonly queuedOperations: number;
  readonly initializingOperations: number;
  readonly originWaitOperations: number;
  readonly origins: readonly OriginAdmissionStats[];
  readonly admissionLimits: Readonly<{
    maxActiveOperations: number;
    maxQueuedOperations: number;
    maxActivePerOrigin: number;
  }>;
  readonly openBodies: number;
  readonly uploadBridgeBytes: number;
  readonly downloadBridgeBytes: number;
  readonly nativeTasks: number;
  readonly completed: number;
  readonly aborted: number;
  readonly timedOut: number;
  readonly bufferedResponseBytes: number;
  readonly bufferedResponseLimitBytes: number;
  readonly retainedRequestBodyBytes: number;
  readonly connections: number;
  readonly creatingConnections: number;
  readonly waitingConnections: number;
  readonly connectionOrigins: readonly Readonly<{
    origin: string;
    connections: number;
    waitingConnections: number;
  }>[];
  readonly connectionLimits: Readonly<{ maxConnections: number; maxConnectionsPerOrigin: number }>;
  readonly idleConnections: number | null;
  readonly connectionAccounting: string;
  /** Open HTTP/3 (QUIC) connections; they are not counted in `connections`. */
  readonly http3Connections: number;
}
type NativeStats = Omit<ClientStats, 'initializingOperations' | 'retainedRequestBodyBytes'>;
const redirectKeys = ['redirect', 'maxRedirects', 'allowInsecureRedirects', 'sensitiveHeaders'];
const STANDARD_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const NO_BODY: PreparedBody = Object.freeze({});
const DECODE_UNLIMITED: DecodeOptions = Object.freeze({ limit: null });
const requestKeys = [
  ...redirectKeys,
  'method',
  'headers',
  'body',
  'json',
  'form',
  'searchParams',
  'signal',
  'timeouts',
  'maxResponseBytes',
  'maxBufferedResponseBytes',
  'decompress',
];
const clientKeys = [
  'cookies',
  ...redirectKeys,
  'profile',
  'baseUrl',
  'headers',
  'ca',
  'trustStore',
  'http3',
  'maxActiveOperations',
  'maxActivePerOrigin',
  'maxConnections',
  'maxConnectionsPerOrigin',
  'maxQueuedOperations',
  'maxInputChunkBytes',
  'maxRetainedRequestBodyBytes',
  'maxBufferedResponseBytes',
  'maxAggregateBufferedResponseBytes',
  'connectMs',
  'timeouts',
  'decompress',
  'proxy',
  'resolve',
];
function resolveMap(value: ClientOptions['resolve']): Record<string, string[]> {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    invalid('resolve: expected an object of host names to IP addresses');
  const out: Record<string, string[]> = {};
  const entries = Object.entries(value);
  if (entries.length > 1024) invalid('resolve: at most 1024 hosts');
  for (const [name, addrs] of entries) {
    let host: string;
    try {
      host = new URL(`http://${name}/`).hostname;
    } catch {
      invalid(`resolve: invalid host name ${JSON.stringify(name)}`);
    }
    if (host !== name.toLowerCase() || host.startsWith('[') || isIP(host) !== 0)
      invalid(`resolve: invalid host name ${JSON.stringify(name)}`);
    const list = typeof addrs === 'string' ? [addrs] : addrs;
    if (!Array.isArray(list) || list.length === 0 || list.length > 32)
      invalid(`resolve.${name}: expected 1 to 32 IP addresses`);
    out[host] = list.map((ip: unknown) => {
      const text = typeof ip === 'string' ? ip.replace(/^\[(.*)\]$/, '$1') : '';
      if (isIP(text) === 0) invalid(`resolve.${name}: ${JSON.stringify(ip)} is not an IP address`);
      return text;
    });
  }
  return out;
}
const PROXY_SCHEMES = ['http:', 'https:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:'];
interface ProxyRoute {
  scope: 'all' | 'http' | 'https';
  url: string;
  noProxy: string | null;
}
function proxyUrl(value: unknown, path: string): string {
  if (!(typeof value === 'string' || value instanceof URL))
    invalid(`${path}: expected a proxy URL`);
  let text = String(value).trim();
  // Environment values are often bare host:port.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    invalid(`${path}: expected a proxy URL`);
  }
  if (!PROXY_SCHEMES.includes(url.protocol) || url.hostname === '')
    invalid(`${path}: expected an http, https, socks4, socks4a, socks5 or socks5h URL`);
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash)
    invalid(`${path}: a proxy URL has no path, query or fragment`);
  return url.href.replace(/\/$/, '');
}
function noProxyList(value: unknown, path: string): string | null {
  if (value === undefined || value === null) return null;
  const items =
    typeof value === 'string'
      ? value.split(',')
      : Array.isArray(value) && value.every((v) => typeof v === 'string')
        ? (value as string[])
        : invalid(`${path}: expected a string or string array`);
  const list = items.map((v) => v.trim()).filter(Boolean);
  if (list.some((v) => /[\s,]/.test(v)))
    invalid(`${path}: entries cannot contain spaces or commas`);
  return list.length ? list.join(',') : null;
}
function env(name: string): string | undefined {
  const value = process.env[name] ?? process.env[name.toLowerCase()];
  return value?.trim() ? value : undefined;
}
/** Resolves the proxy option into ordered native routes. */
export function proxyRoutes(option: ClientOptions['proxy']): ProxyRoute[] {
  if (option === undefined || option === false) return [];
  if (option === 'env') {
    const all = env('ALL_PROXY');
    // HTTP_PROXY is attacker-controlled in CGI ("httpoxy"); ignore it there.
    const http = process.env.REQUEST_METHOD ? env('http_proxy') : env('HTTP_PROXY');
    const https = env('HTTPS_PROXY');
    const noProxy = env('NO_PROXY');
    return proxyRoutes({
      ...(all === undefined ? {} : { url: all }),
      ...(http === undefined ? {} : { http }),
      ...(https === undefined ? {} : { https }),
      ...(noProxy === undefined ? {} : { noProxy }),
    });
  }
  if (typeof option === 'string' || option instanceof URL)
    return [{ scope: 'all', url: proxyUrl(option, 'proxy'), noProxy: null }];
  if (typeof option !== 'object' || option === null)
    invalid('proxy: expected a URL, an object, "env" or false');
  keys(option, ['url', 'http', 'https', 'noProxy'], 'proxy');
  const noProxy = noProxyList(option.noProxy, 'proxy.noProxy');
  const routes: ProxyRoute[] = [];
  // "*" bypasses every proxy (curl semantics), IP literals included.
  const direct = noProxy?.split(',').includes('*') ?? false;
  for (const scope of ['http', 'https'] as const)
    if (option[scope] !== undefined)
      routes.push({ scope, url: proxyUrl(option[scope], `proxy.${scope}`), noProxy });
  if (option.url !== undefined)
    routes.push({ scope: 'all', url: proxyUrl(option.url, 'proxy.url'), noProxy });
  return direct ? [] : routes;
}
/** Trims the cookie WSP (space and HTAB) that Set-Cookie parsing ignores. */
function trimWsp(value: string): string {
  return value.replace(/^[ \t]+|[ \t]+$/g, '');
}
/**
 * RFC 6265bis limits: name + value up to 4096 octets (the cookie is rejected),
 * each attribute value up to 1024 octets (that attribute is ignored natively).
 * The whole line is bounded like a response header block.
 */
function checkSetCookie(value: string): void {
  if (value.length > 65536 || Buffer.byteLength(value) > 65536)
    throw new OmreqError('ERR_INVALID_COOKIE', 'configuration', 'Set-Cookie exceeds 64 KiB');
  const end = value.indexOf(';');
  const pair = end === -1 ? value : value.slice(0, end);
  const split = pair.indexOf('=');
  const name = split === -1 ? '' : trimWsp(pair.slice(0, split));
  const cookieValue = trimWsp(split === -1 ? pair : pair.slice(split + 1));
  if (Buffer.byteLength(name) + Buffer.byteLength(cookieValue) > 4096)
    throw new OmreqError(
      'ERR_INVALID_COOKIE',
      'configuration',
      'Cookie name and value exceed 4 KiB',
    );
}
/**
 * Adds the body's automatic content-type unless client or request headers set
 * or remove (`null`) it. A FormData body is framed here, so an explicit
 * multipart content-type gets this operation's boundary.
 */
function contentType(headers: Pair[], overrides: readonly string[], prepared: PreparedBody): void {
  const index = headers.findIndex(([n]) => n === 'content-type');
  if (index === -1) {
    if (!overrides.includes('content-type'))
      headers.push(['content-type', prepared.contentType as string]);
    return;
  }
  if (prepared.boundary === undefined) return;
  const [type = '', ...params] = (headers[index] as Pair)[1].split(';');
  if (!/^multipart\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/i.test(type.trim()))
    invalid('content-type: a FormData body requires a multipart media type');
  const kept = params.map((p) => p.trim()).filter((p) => p && !/^boundary\s*=/i.test(p));
  headers[index] = [
    'content-type',
    [type.trim(), ...kept, `boundary=${prepared.boundary}`].join('; '),
  ];
}
function redirectPolicy(value: RedirectOptions): RedirectOptions {
  const { redirect, maxRedirects, allowInsecureRedirects, sensitiveHeaders } = value;
  if (redirect !== undefined && !['follow', 'manual', 'error'].includes(redirect))
    invalid('redirect: expected follow, manual or error');
  if (
    maxRedirects !== undefined &&
    (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 10)
  )
    invalid('maxRedirects: expected an integer from 0 to 10');
  if (allowInsecureRedirects !== undefined && typeof allowInsecureRedirects !== 'boolean')
    invalid('allowInsecureRedirects: expected a boolean');
  if (
    sensitiveHeaders !== undefined &&
    (!Array.isArray(sensitiveHeaders) ||
      sensitiveHeaders.length > 200 ||
      sensitiveHeaders.some(
        (name) =>
          typeof name !== 'string' ||
          name.length > 256 ||
          !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name),
      ))
  )
    invalid('sensitiveHeaders: expected at most 200 valid header names');
  return {
    ...(redirect !== undefined ? { redirect } : {}),
    ...(maxRedirects !== undefined ? { maxRedirects } : {}),
    ...(allowInsecureRedirects !== undefined ? { allowInsecureRedirects } : {}),
    ...(sensitiveHeaders !== undefined
      ? { sensitiveHeaders: Object.freeze(sensitiveHeaders.map((name) => name.toLowerCase())) }
      : {}),
  };
}
function timeouts(value: Timeouts = {}): Timeouts {
  if (!value || typeof value !== 'object') invalid('timeouts: expected an object');
  keys(
    value,
    ['queueMs', 'headersMs', 'uploadIdleMs', 'bodyIdleMs', 'consumerIdleMs', 'totalMs'],
    'timeouts',
  );
  for (const [key, v] of Object.entries(value))
    positive(v, `timeouts.${key}`, ['consumerIdleMs', 'totalMs'].includes(key));
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
}
function normalizedUrl(
  input: string | URL,
  base?: string,
  params?: RequestOptions['searchParams'],
): string {
  let url: URL;
  try {
    url = new URL(String(input), base);
  } catch {
    invalid('Expected an absolute HTTP(S) URL or a relative URL with baseUrl');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    invalid('Only HTTP(S) URLs without credentials are allowed');
  url.hash = '';
  if (params !== undefined) {
    if (!(params instanceof URLSearchParams) && !Array.isArray(params))
      invalid('searchParams: expected URLSearchParams or string pairs');
    const pairs = [...params];
    for (const pair of pairs)
      if (!Array.isArray(pair) || pair.length !== 2 || pair.some((v) => typeof v !== 'string'))
        invalid('searchParams: expected string pairs');
    if (pairs.length) {
      // Edit the raw query instead of url.searchParams: any searchParams
      // mutation re-serializes every existing pair as form data, which changes
      // signed URLs (%20 -> +, ',' -> %2C, '~' -> %7E). Only segments whose
      // decoded key is replaced are removed; the rest keep their exact bytes.
      const replaced = new Set(pairs.map(([key]) => key));
      const raw = url.search.slice(1);
      const kept = (raw ? raw.split('&') : []).filter((segment) => {
        const [first] = new URLSearchParams(segment);
        return !first || !replaced.has(first[0]);
      });
      kept.push(new URLSearchParams(pairs as [string, string][]).toString());
      url.search = kept.join('&');
    }
  }
  return url.href;
}
export class OmreqClient {
  readonly #profile: ProfileV1;
  readonly #options: ClientOptions;
  readonly #proxies: readonly ProxyRoute[];
  readonly #resolve: Readonly<Record<string, string[]>>;
  readonly #headers: HeaderInput;
  readonly #base: string | undefined;
  #native: NativeClient | undefined;
  #init: Promise<NativeClient> | undefined;
  #failure: unknown;
  #state: 'created' | 'initializing' | 'ready' | 'closing' | 'closed' | 'failed' = 'created';
  #close: Promise<void> | undefined;
  #profileCheck: ProfileCheck | undefined;
  #retained = 0;
  #admitted = 0;
  #initializingRequests = 0;
  readonly #uploads = new Set<UploadControl>();
  // Native operations opened and not yet released in JavaScript; close()
  // resolves only after every one of them has settled.
  #live = 0;
  #nextId = 0;
  #drained: (() => void) | undefined;
  /** Set by a graceful close: new requests are refused, admitted ones finish. */
  #draining = false;
  #idle: (() => void)[] = [];
  // Request-independent layers, validated once.
  readonly #baseHeaders: ReadonlyMap<string, readonly Pair[]>;
  readonly #baseOverrides: readonly string[];
  readonly #baseTimers: Required<Timeouts>;
  readonly #baseRedirect: Required<Omit<RedirectOptions, 'sensitiveHeaders'>> & {
    sensitiveHeaders: string[];
  };
  readonly cookies: CookieStore = Object.freeze({
    setCookie: async (value: string, url: string | URL): Promise<void> => {
      if (typeof value !== 'string') invalid('Cookie value must be a string');
      checkSetCookie(value);
      const target = normalizedUrl(url);
      try {
        (await this.#cookieClient()).setCookie(value, target);
      } catch (error) {
        throw nativeError(error);
      }
    },
    getCookies: async (url: string | URL): Promise<readonly CookieRecord[]> => {
      const target = normalizedUrl(url);
      try {
        const values = JSON.parse(
          (await this.#cookieClient()).getCookies(target),
        ) as CookieRecord[];
        return Object.freeze(values.map((value) => Object.freeze(value)));
      } catch (error) {
        throw nativeError(error);
      }
    },
    clear: async (): Promise<void> => {
      try {
        (await this.#cookieClient()).clearCookies();
      } catch (error) {
        throw nativeError(error);
      }
    },
  });
  async #cookieClient(): Promise<NativeClient> {
    this.#assertOpen();
    if (this.#options.cookies === false) invalid('Cookies are disabled for this client');
    const native = await this.#initialize();
    this.#assertOpen();
    return native;
  }
  constructor(options: ClientOptions = {}) {
    if (!options || typeof options !== 'object') invalid('options: expected an object');
    keys(options, clientKeys, 'options');
    if (options.cookies !== undefined && typeof options.cookies !== 'boolean')
      invalid('cookies: expected a boolean');
    if (options.decompress !== undefined && typeof options.decompress !== 'boolean')
      invalid('decompress: expected a boolean');
    this.#profile =
      typeof options.profile === 'string'
        ? getProfile(options.profile)
        : options.profile === undefined
          ? getProfile(DEFAULT_PROFILE)
          : defineProfile(options.profile);
    this.#headers = snapshotHeaders(options.headers);
    this.#base = options.baseUrl === undefined ? undefined : normalizedUrl(options.baseUrl);
    for (const [key, v] of Object.entries(options))
      if (
        [
          'maxActiveOperations',
          'maxActivePerOrigin',
          'maxConnections',
          'maxConnectionsPerOrigin',
          'maxInputChunkBytes',
          'maxRetainedRequestBodyBytes',
          'maxBufferedResponseBytes',
          'maxAggregateBufferedResponseBytes',
          'connectMs',
        ].includes(key)
      )
        positive(v, key);
    if (
      options.maxQueuedOperations !== undefined &&
      (!Number.isSafeInteger(options.maxQueuedOperations) ||
        options.maxQueuedOperations < 0 ||
        options.maxQueuedOperations > 4096)
    )
      invalid('maxQueuedOperations: expected an integer from 0 to 4096');
    if ((options.maxActiveOperations ?? 64) > 1024) invalid('maxActiveOperations: maximum is 1024');
    if ((options.maxActivePerOrigin ?? 32) > 1024) invalid('maxActivePerOrigin: maximum is 1024');
    if ((options.maxConnections ?? 256) > 4096) invalid('maxConnections: maximum is 4096');
    if ((options.maxConnectionsPerOrigin ?? 32) > 1024)
      invalid('maxConnectionsPerOrigin: maximum is 1024');
    if ((options.maxInputChunkBytes ?? 1048576) > 1048576)
      invalid('maxInputChunkBytes: prototype maximum is 1 MiB');
    if (
      options.ca !== undefined &&
      (typeof options.ca !== 'string' || !options.ca.includes('-----BEGIN CERTIFICATE-----'))
    )
      invalid('ca: expected PEM certificates');
    if (options.trustStore !== undefined && !['bundled', 'chromium'].includes(options.trustStore))
      invalid('trustStore: expected bundled or chromium');
    if (options.http3 !== undefined && typeof options.http3 !== 'boolean')
      invalid('http3: expected a boolean');
    this.#proxies = proxyRoutes(options.proxy);
    this.#resolve = resolveMap(options.resolve);
    this.#options = {
      ...options,
      ...redirectPolicy(options),
      timeouts: timeouts(options.timeouts),
    };
    this.#baseHeaders = headerGroups(
      this.#profile.headers as readonly (readonly [string, string])[],
      this.#headers,
    );
    this.#baseOverrides = headerOverrideNames(this.#headers);
    this.#baseTimers = {
      queueMs: 10000,
      headersMs: 30000,
      uploadIdleMs: 30000,
      bodyIdleMs: 30000,
      consumerIdleMs: 60000,
      totalMs: null,
      ...this.#options.timeouts,
    };
    this.#baseRedirect = {
      redirect: this.#options.redirect ?? 'follow',
      maxRedirects: this.#options.maxRedirects ?? 10,
      allowInsecureRedirects: this.#options.allowInsecureRedirects ?? false,
      sensitiveHeaders: [...new Set(this.#options.sensitiveHeaders ?? [])],
    };
  }
  #initialize(): Promise<NativeClient> {
    if (this.#state === 'failed') return Promise.reject(this.#failure);
    if (this.#state === 'closing' || this.#state === 'closed')
      return Promise.reject(new OmreqError('ERR_CLIENT_CLOSED', 'queue', 'Client is closed'));
    if (this.#init) return this.#init;
    this.#state = 'initializing';
    this.#init = Promise.resolve()
      .then(async () => {
        const addon = loadNative();
        const profile = serializeProfile(this.#profile);
        // The cheap report covers capabilities; constructing the client below
        // reports a TLS backend rejection without building a transport twice.
        const check = JSON.parse(addon.profileReport(profile)) as ProfileCheck;
        if (!check.compatible)
          throw new OmreqError(
            'ERR_PROFILE_UNSUPPORTED',
            'initialization',
            check.issues.map((i) => i.message).join('; '),
          );
        if (this.#state === 'closing' || this.#state === 'closed')
          throw new OmreqError(
            'ERR_CLIENT_CLOSED',
            'initialization',
            'Client closed during initialization',
          );
        const native = new addon.NativeClient(
          profile,
          JSON.stringify({
            maxActiveOperations: this.#options.maxActiveOperations ?? 64,
            maxQueuedOperations: this.#options.maxQueuedOperations ?? 256,
            maxActivePerOrigin: this.#options.maxActivePerOrigin ?? 32,
            maxConnections: this.#options.maxConnections ?? 256,
            maxConnectionsPerOrigin: this.#options.maxConnectionsPerOrigin ?? 32,
            maxAggregateBufferedResponseBytes:
              this.#options.maxAggregateBufferedResponseBytes ?? 134217728,
            connectMs: this.#options.connectMs ?? 10000,
            ca: this.#options.ca ?? null,
            trustStore: this.#options.trustStore ?? 'bundled',
            http3: this.#options.http3 ?? true,
            cookies: this.#options.cookies ?? true,
            proxies: this.#proxies,
            resolve: this.#resolve,
          }),
        );
        this.#native = native;
        this.#profileCheck = check;
        this.#state = 'ready';
        return native;
      })
      .catch((error: unknown) => {
        const converted = nativeError(error);
        this.#failure = converted;
        if (this.#state !== 'closing' && this.#state !== 'closed') this.#state = 'failed';
        throw converted;
      });
    return this.#init;
  }
  async request(input: string | URL, options: RequestOptions = {}): Promise<OmreqResponse> {
    const invokedAt = performance.now();
    this.#assertOpen();
    if (!options || typeof options !== 'object') invalid('request options: expected an object');
    keys(options, requestKeys, 'request');
    const signal = options.signal;
    if (
      signal &&
      (typeof signal.addEventListener !== 'function' || typeof signal.aborted !== 'boolean')
    )
      invalid('signal: expected an AbortSignal');
    if (signal?.aborted)
      throw new OmreqError('ERR_ABORTED', 'queue', 'Request was aborted', { cause: signal.reason });
    let op: NativeOperation | undefined;
    let native: NativeClient | undefined;
    let id = 0;
    let cleanup: Promise<void> | undefined;
    let upload: UploadControl | undefined;
    let abortReason: unknown;
    let uploadFailure: unknown;
    // Without a signal nothing can abort the request from JavaScript, so the
    // abort promise and its race are only built when a signal is passed.
    let aborted: Promise<never> | undefined;
    let onAbort: (() => void) | undefined;
    if (signal) {
      let rejectAbort!: (error: unknown) => void;
      aborted = new Promise<never>((_, reject) => {
        rejectAbort = reject;
      });
      // Always attach a rejection handler, including after headers when a signal aborts body reads.
      void aborted.catch(() => {});
      onAbort = () => {
        abortReason = signal.reason;
        if (id) native?.cancel(id, 'ERR_ABORTED');
        upload?.stop();
        rejectAbort(
          new OmreqError('ERR_ABORTED', 'queue', 'Request was aborted', { cause: abortReason }),
        );
      };
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    }
    let released = false;
    let admitted = false;
    let opened = false;
    let retained = 0;
    const finish = () => {
      if (released) return;
      released = true;
      if (admitted && --this.#admitted === 0) {
        const idle = this.#idle.splice(0);
        for (const resolve of idle) resolve();
      }
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      this.#retained -= retained;
      retained = 0;
      if (upload) {
        this.#uploads.delete(upload);
        void upload.cleanup();
      }
      if (opened && --this.#live === 0) {
        const drained = this.#drained;
        this.#drained = undefined;
        drained?.();
      }
    };
    try {
      if (
        this.#admitted >=
        (this.#options.maxActiveOperations ?? 64) + (this.#options.maxQueuedOperations ?? 256)
      )
        throw new OmreqError('ERR_QUEUE_FULL', 'queue', 'Operation queue is full');
      this.#admitted++;
      admitted = true;
      const url = normalizedUrl(input, this.#base, options.searchParams);
      let method = options.method ?? 'GET';
      if (!STANDARD_METHODS.has(method)) {
        if (
          typeof method !== 'string' ||
          !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(method) ||
          method.toUpperCase() === 'CONNECT'
        )
          invalid('Unsupported or invalid method');
        if (STANDARD_METHODS.has(method.toUpperCase())) method = method.toUpperCase();
      }
      // `body: undefined` and `form: undefined` mean no body; `json: undefined`
      // is rejected below because JSON has no representation for it.
      const hasJson = Object.hasOwn(options, 'json');
      const source =
        options.body !== undefined
          ? 'body'
          : hasJson
            ? 'json'
            : options.form !== undefined
              ? 'form'
              : undefined;
      if (
        (options.body !== undefined ? 1 : 0) +
          (hasJson ? 1 : 0) +
          (options.form !== undefined ? 1 : 0) >
        1
      )
        invalid('body, json and form are mutually exclusive');
      let prepared: PreparedBody;
      if (source === undefined) prepared = NO_BODY;
      else if (source === 'json') {
        let json: string | undefined;
        try {
          json = JSON.stringify(options.json);
        } catch (cause) {
          throw new OmreqError(
            'ERR_INVALID_ARGUMENT',
            'configuration',
            'JSON serialization failed',
            { cause },
          );
        }
        if (json === undefined) invalid('json: undefined is not a JSON body');
        prepared = { bytes: Buffer.from(json), contentType: 'application/json' };
      } else if (source === 'form') {
        const form = options.form;
        if (!(form instanceof URLSearchParams) && !Array.isArray(form))
          invalid('form: expected URLSearchParams or string pairs');
        const pairs = [...form];
        for (const p of pairs)
          if (!Array.isArray(p) || p.length !== 2 || p.some((v) => typeof v !== 'string'))
            invalid('form: expected string pairs');
        prepared = {
          bytes: Buffer.from(new URLSearchParams(pairs.map(([k, v]) => [k, v])).toString()),
          contentType: 'application/x-www-form-urlencoded',
        };
      } else {
        // Reserve materialized input capacity before making the owned byte snapshot.
        const body = options.body;
        const size =
          typeof body === 'string'
            ? Buffer.byteLength(body)
            : body instanceof ArrayBuffer
              ? body.byteLength
              : ArrayBuffer.isView(body)
                ? body.byteLength
                : 0;
        if (size + this.#retained > (this.#options.maxRetainedRequestBodyBytes ?? 67108864))
          throw new OmreqError(
            'ERR_RESOURCE_LIMIT',
            'queue',
            'Retained request byte budget exceeded; use a stream',
          );
        prepared = prepareBody(
          body,
          (this.#options.maxRetainedRequestBodyBytes ?? 67108864) - this.#retained,
          Math.min(this.#options.maxInputChunkBytes ?? 1048576, 65536),
        );
      }
      if ((method === 'GET' || method === 'HEAD') && source !== undefined)
        invalid(`${method} cannot have a body`);
      retained = prepared.retainedBytes ?? prepared.bytes?.length ?? 0;
      if (retained + this.#retained > (this.#options.maxRetainedRequestBodyBytes ?? 67108864)) {
        retained = 0;
        throw new OmreqError(
          'ERR_RESOURCE_LIMIT',
          'queue',
          'Retained request byte budget exceeded',
        );
      }
      this.#retained += retained;
      const { headers, overrides: headerOverrides } = mergeOnto(
        this.#baseHeaders,
        options.headers,
        this.#baseOverrides,
      );
      if (prepared.contentType) contentType(headers, headerOverrides, prepared);
      if (options.decompress !== undefined && typeof options.decompress !== 'boolean')
        invalid('decompress: expected a boolean');
      // An explicit accept-encoding means the caller handles content codings.
      const decompress =
        (options.decompress ?? this.#options.decompress ?? true) &&
        !headerOverrides.includes('accept-encoding');
      const timers =
        options.timeouts === undefined
          ? this.#baseTimers
          : { ...this.#baseTimers, ...timeouts(options.timeouts) };
      positive(options.maxResponseBytes, 'maxResponseBytes', true, Number.MAX_SAFE_INTEGER);
      positive(options.maxBufferedResponseBytes, 'maxBufferedResponseBytes');
      const maxResponseBytes = options.maxResponseBytes ?? null;
      const maxBufferedResponseBytes =
        options.maxBufferedResponseBytes ?? this.#options.maxBufferedResponseBytes ?? 67108864;
      let redirect = this.#baseRedirect;
      if (
        options.redirect !== undefined ||
        options.maxRedirects !== undefined ||
        options.allowInsecureRedirects !== undefined ||
        options.sensitiveHeaders !== undefined
      ) {
        redirect = {
          ...redirect,
          ...redirectPolicy(options),
          sensitiveHeaders: [
            ...new Set([
              ...redirect.sensitiveHeaders,
              ...(options.sensitiveHeaders ?? []).map((name) => name.toLowerCase()),
            ]),
          ],
        };
        if (redirect.sensitiveHeaders.length > 200)
          invalid('sensitiveHeaders: combined maximum is 200');
      }
      const strict = this.#profile.transport.httpVersion;
      if ((strict === '2' || strict === '3') && !url.startsWith('https:'))
        invalid(`Strict HTTP/${strict} requires HTTPS; h2c is unsupported`);
      const queueDeadline = invokedAt + timers.queueMs;
      const totalDeadline = timers.totalMs === null ? null : invokedAt + timers.totalMs;
      const initDeadline = Math.min(queueDeadline, totalDeadline ?? Infinity);
      const expired = () =>
        new OmreqError('ERR_TIMEOUT', 'queue', 'Request deadline expired before admission');
      if (performance.now() >= initDeadline) throw expired();
      native = this.#native;
      if (native === undefined) {
        let initTimer: ReturnType<typeof setTimeout> | undefined;
        const initTimeout = new Promise<never>((_, reject) => {
          initTimer = setTimeout(
            () => reject(expired()),
            Math.max(1, initDeadline - performance.now()),
          );
        });
        this.#initializingRequests++;
        try {
          native = await Promise.race(
            aborted
              ? [this.#initialize(), aborted, initTimeout]
              : [this.#initialize(), initTimeout],
          );
        } finally {
          this.#initializingRequests--;
          clearTimeout(initTimer);
        }
        this.#assertOpen(false);
      }
      const admittedAt = performance.now();
      // A blocked JS thread can delay the timer callback. Check monotonic time
      // before native work even if initialization won that Promise race.
      if (admittedAt >= initDeadline) throw expired();
      if (signal?.aborted) onAbort?.();
      const streaming = !!(prepared.source || prepared.replay);
      id = ++this.#nextId;
      // Opening registers admission synchronously, in invocation order; the
      // rest of the operation runs natively until the response is available.
      const executing = native.request(
        id,
        url,
        JSON.stringify({
          url,
          method,
          headers,
          headerOverrides,
          streaming,
          replayable: !!prepared.replay,
          bodyLength: prepared.contentLength,
          queueMs: Math.ceil(queueDeadline - admittedAt),
          hopQueueMs: timers.queueMs,
          headersMs: timers.headersMs,
          uploadIdleMs: timers.uploadIdleMs,
          bodyIdleMs: timers.bodyIdleMs,
          consumerIdleMs: timers.consumerIdleMs,
          totalMs: totalDeadline === null ? null : Math.ceil(totalDeadline - admittedAt),
          redirect: redirect.redirect,
          maxRedirects: redirect.maxRedirects,
          allowInsecureRedirects: redirect.allowInsecureRedirects,
          sensitiveHeaders: redirect.sensitiveHeaders,
          maxResponseBytes,
        }),
        prepared.bytes,
      );
      opened = true;
      this.#live++;
      if (signal?.aborted) {
        native.cancel(id, 'ERR_ABORTED');
        throw new OmreqError('ERR_ABORTED', 'queue', 'Request was aborted', {
          cause: signal.reason,
        });
      }
      if (streaming) {
        // Missing only when the operation already failed; `executing` rejects.
        op = native.operation(id) ?? undefined;
        if (op) {
          upload = startUpload(
            op,
            prepared,
            this.#options.maxInputChunkBytes ?? 1048576,
            (error) => {
              uploadFailure = error;
            },
          );
          this.#uploads.add(upload);
        }
      }
      const [status, httpVersion, finalUrl, rawHeaders, history, inline, cleaned, streamed] =
        aborted ? await Promise.race([executing, aborted]) : await executing;
      const meta: ResponseMeta = {
        status,
        url: finalUrl ?? url,
        httpVersion,
        headers: rawHeaders,
        redirects: history === undefined ? [] : (JSON.parse(history) as RedirectHop[]),
      };
      upload?.stop();
      if (upload) void upload.cleanup();
      // Final headers end the request side: redirects can no longer replay
      // the body and native code has dropped its copy, so the retained
      // request budget is released now rather than when the response body
      // is finished.
      this.#retained -= retained;
      retained = 0;
      if (inline !== undefined && cleaned) {
        // The whole body arrived with the headers and the native operation has
        // already released its slot and connection.
        cleanup = undefined;
        finish();
      } else {
        cleanup = streamed ? streamed.waitCleanup() : native.waitCleanup(id);
        void cleanup.then(finish, finish);
      }
      return new OmreqResponse(
        meta,
        streamed,
        maxBufferedResponseBytes,
        finish,
        () => abortReason,
        cleanup,
        inline,
        // HEAD, 204 and 304 have no body, so no decoding is claimed for them.
        decompress && method !== 'HEAD' && status !== 204 && status !== 304
          ? maxResponseBytes === null
            ? DECODE_UNLIMITED
            : { limit: maxResponseBytes }
          : undefined,
      );
    } catch (error) {
      if (opened && native) {
        native.cancel(id, 'ERR_BODY_DISPOSED');
        await native.waitCleanup(id).catch(() => {});
      }
      finish();
      const converted = nativeError(error);
      if (
        uploadFailure !== undefined &&
        ['ERR_UPLOAD_SOURCE', 'ERR_RESOURCE_LIMIT'].includes(converted.code)
      )
        throw new OmreqError(converted.code, converted.phase, converted.message, {
          cause: uploadFailure,
        });
      throw converted;
    }
  }
  /** `accepting`: also refuse new work while a graceful close drains. */
  #assertOpen(accepting = true): void {
    if (this.#state === 'closing' || this.#state === 'closed' || (accepting && this.#draining))
      throw new OmreqError('ERR_CLIENT_CLOSED', 'queue', 'Client is closed');
  }
  #verb(
    method: string,
    url: string | URL,
    options: Omit<RequestOptions, 'method'> = {},
  ): Promise<OmreqResponse> {
    if ('method' in options)
      return Promise.reject(
        new OmreqError(
          'ERR_INVALID_ARGUMENT',
          'configuration',
          'Convenience methods do not accept method',
        ),
      );
    return this.request(url, { ...options, method });
  }
  get(url: string | URL, options?: Omit<RequestOptions, 'method'>) {
    return this.#verb('GET', url, options);
  }
  post(url: string | URL, options?: Omit<RequestOptions, 'method'>) {
    return this.#verb('POST', url, options);
  }
  put(url: string | URL, options?: Omit<RequestOptions, 'method'>) {
    return this.#verb('PUT', url, options);
  }
  patch(url: string | URL, options?: Omit<RequestOptions, 'method'>) {
    return this.#verb('PATCH', url, options);
  }
  delete(url: string | URL, options?: Omit<RequestOptions, 'method'>) {
    return this.#verb('DELETE', url, options);
  }
  head(url: string | URL, options?: Omit<RequestOptions, 'method'>) {
    return this.#verb('HEAD', url, options);
  }
  options(url: string | URL, options?: Omit<RequestOptions, 'method'>) {
    return this.#verb('OPTIONS', url, options);
  }
  /** `await using client = createClient()` closes the client at scope exit. */
  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
  /**
   * Closes the client. By default active and queued requests are cancelled.
   * With `graceful: true` new requests are refused while admitted ones (and
   * their response bodies) finish; after `timeoutMs` the rest is cancelled.
   */
  close(options: CloseOptions = {}): Promise<void> {
    if (this.#close) return this.#close;
    try {
      if (!options || typeof options !== 'object') invalid('close options: expected an object');
      keys(options, ['graceful', 'timeoutMs'], 'close');
      if (options.graceful !== undefined && typeof options.graceful !== 'boolean')
        invalid('close.graceful: expected a boolean');
      if (options.timeoutMs !== undefined) positive(options.timeoutMs, 'close.timeoutMs');
    } catch (error) {
      return Promise.reject(error);
    }
    this.#draining = true;
    this.#close = (async () => {
      if (options.graceful) await this.#drain(options.timeoutMs);
      this.#state = 'closing';
      try {
        if (this.#init) await this.#init.catch(() => {});
        for (const upload of this.#uploads) upload.stop();
        await Promise.all([this.#native?.close(), ...[...this.#uploads].map((u) => u.cleanup())]);
        while (this.#live > 0)
          await new Promise<void>((resolve) => {
            this.#drained = resolve;
          });
      } catch (error) {
        throw nativeError(error);
      } finally {
        this.#uploads.clear();
        this.#state = 'closed';
      }
    })();
    return this.#close;
  }
  async #drain(timeoutMs: number | undefined): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired =
      timeoutMs === undefined
        ? undefined
        : new Promise<void>((resolve) => {
            timer = setTimeout(resolve, timeoutMs);
          });
    let timedOut = false;
    void expired?.then(() => {
      timedOut = true;
    });
    try {
      while (this.#admitted > 0 && !timedOut) {
        const idle = new Promise<void>((resolve) => this.#idle.push(resolve));
        await (expired ? Promise.race([idle, expired]) : idle);
      }
    } finally {
      clearTimeout(timer);
    }
  }
  getInfo() {
    return Object.freeze({
      state: this.#state,
      nativeReady: !!this.#native,
      profileId: this.#profile.id,
      profileDigest: this.#profileCheck?.profileDigest ?? null,
      engineBuildId: this.#profileCheck?.engineBuildId ?? null,
      verification: isBundledProfile(this.#profile) ? 'bundled-verified' : 'custom-unverified',
      trustStore: this.#options.trustStore ?? 'bundled',
      stage: 'internal-prototype',
    });
  }
  getStats(): ClientStats {
    const stats: NativeStats = this.#native
      ? (JSON.parse(this.#native.stats()) as NativeStats)
      : {
          activeOperations: 0,
          queuedOperations: 0,
          openBodies: 0,
          uploadBridgeBytes: 0,
          downloadBridgeBytes: 0,
          nativeTasks: 0,
          completed: 0,
          aborted: 0,
          timedOut: 0,
          cookieCount: 0,
          cookieBytes: 0,
          discardedCookies: 0,
          partitionedCookies: 0,
          evictedCookies: 0,
          connections: 0,
          creatingConnections: 0,
          waitingConnections: 0,
          connectionOrigins: [],
          connectionLimits: {
            maxConnections: this.#options.maxConnections ?? 256,
            maxConnectionsPerOrigin: this.#options.maxConnectionsPerOrigin ?? 32,
          },
          idleConnections: 0,
          http3Connections: 0,
          connectionAccounting: 'physical TCP sockets/attempts bounded; idle lifecycle unavailable',
          bufferedResponseBytes: 0,
          bufferedResponseLimitBytes: this.#options.maxAggregateBufferedResponseBytes ?? 134217728,
          originWaitOperations: 0,
          origins: [],
          admissionLimits: {
            maxActiveOperations: this.#options.maxActiveOperations ?? 64,
            maxQueuedOperations: this.#options.maxQueuedOperations ?? 256,
            maxActivePerOrigin: this.#options.maxActivePerOrigin ?? 32,
          },
        };
    return Object.freeze({
      ...stats,
      origins: Object.freeze(stats.origins.map((origin) => Object.freeze({ ...origin }))),
      admissionLimits: Object.freeze({ ...stats.admissionLimits }),
      connectionLimits: Object.freeze({ ...stats.connectionLimits }),
      connectionOrigins: Object.freeze(
        stats.connectionOrigins.map((origin) => Object.freeze({ ...origin })),
      ),
      queuedOperations: stats.queuedOperations + this.#initializingRequests,
      initializingOperations: this.#initializingRequests,
      retainedRequestBodyBytes: this.#retained,
    });
  }
}
export function createClient(options?: ClientOptions): OmreqClient {
  return new OmreqClient(options);
}
