<div align="center">

# omreq

**The fastest HTTP client for Node.js and Bun with a real Chrome fingerprint.**

TLS (JA3/JA4), HTTP/2 (Akamai) and header order identical to Chrome, byte for byte.<br>
Rust + BoringSSL in-process: up to **43% faster than wreq-js** and **up to 3× faster than `fetch`**.

![status](https://img.shields.io/badge/status-pre--release-orange)
![platform](https://img.shields.io/badge/platform-macOS%20arm64-lightgrey)
![runtimes](https://img.shields.io/badge/runtimes-Node%2026%20%7C%20Bun%201.4-blue)
![license](https://img.shields.io/badge/license-MIT-green)
![tls](https://img.shields.io/badge/TLS-JA3%20%7C%20JA4-8A2BE2)
![http2](https://img.shields.io/badge/HTTP%2F2-Akamai%20fingerprint-8A2BE2)
![chrome](https://img.shields.io/badge/Chrome-157-4285F4?logo=googlechrome&logoColor=white)
![rust](https://img.shields.io/badge/core-Rust%20%2B%20BoringSSL-B7410E?logo=rust)

</div>

Modern bot protection rarely trusts the `User-Agent` header. It looks at how the client
speaks: the cipher and extension order in the TLS ClientHello (JA3/JA4), the key-share
groups, ALPS and certificate compression, the HTTP/2 SETTINGS frame, window sizes,
stream priority and pseudo-header order (the Akamai H2 fingerprint), and the order of
the request headers. Node's own TLS stack is OpenSSL with Node's defaults, so a request
from `fetch` or `undici` identifies itself as Node no matter which headers you set.

omreq moves the whole transport into a Rust core built on
[wreq](https://github.com/0x676e67/wreq) and BoringSSL — the TLS library Chrome itself
uses — and loads it in-process as a Node-API module. Out of the box every request carries
the TLS, HTTP/2, HTTP/1 and header shape of the current Chrome release, checked
byte-for-byte against captures from a real browser. The API on top stays small: one
client per configuration, `get`/`post`/…, typed errors, streaming in both directions.

```ts
import { createClient } from 'omreq';

await using client = createClient(); // Chrome 157 by default

const res = await client.get('https://example.com/api/items');
console.log(res.status, res.httpVersion); // 200 '2'
console.log(await res.json());
```

omreq works at the network layer. It does not execute JavaScript, render pages or solve
challenges; a site that requires a script-driven check needs a real browser.

## Contents

- [Features](#features)
- [Performance](#performance)
- [Install](#install)
- [Profiles](#profiles)
- [Requests and responses](#requests-and-responses)
- [Proxies](#proxies)
- [Sessions and cookies](#sessions-and-cookies)
- [Documentation](#documentation)
- [Behavior reference](#behavior-reference)
- [Development](#development)

## Features

- **Chrome by default.** TLS ClientHello, HTTP/2 SETTINGS/priority/pseudo-header order,
  HTTP/1 header layout and default headers of Chrome 157, verified against live captures.
- **Simple profile choice:** `'chrome'` (newest), `'chrome157'`, `'neutral'`, or your own
  profile written in TypeScript or JSON — no native rebuild needed.
- **HTTP/1.1 and HTTP/2** negotiated through ALPN, connection pooling and multiplexing,
  TLS session resumption.
- **Proxies:** HTTP, HTTPS (CONNECT tunnels), SOCKS4/4a/5/5h, credentials, per-scheme
  routes, `NO_PROXY`-style bypass lists, opt-in environment variables.
- **Cookie jar** per client (RFC 6265bis, public-suffix aware), redirects with
  cross-origin secret stripping, transparent gzip/deflate/br/zstd decoding.
- **Streaming** uploads (async iterables, web streams, Blob, FormData) and downloads with
  backpressure; every body has exactly one owner.
- **Bounded resources:** admission queues, per-origin limits, socket caps, buffered-byte
  budgets and header limits are enforced natively and visible in `getStats()`.
- **Fast:** one native call per request; small bodies arrive together with the headers.
- **DNS overrides** (`resolve`), graceful shutdown, `AbortSignal` everywhere, Standard
  Schema validation for `json(schema)`, ESM and CommonJS, full TypeScript types.

## Performance

Against [wreq-js](https://github.com/sqdshguy/wreq-js) 3.2.0 (same `wreq` engine and
BoringSSL) on wreq-js's own scenarios, plus the runtime's built-in `fetch`. Node 26,
Apple M4, server in a separate process, requests per second, mean of 5 runs:

| Scenario | omreq | wreq-js | `fetch` | omreq vs wreq-js |
| --- | ---: | ---: | ---: | ---: |
| GET 2 B, c=20 | 101.4k | 94.4k | 36.6k | **+7%** |
| GET 4 KiB, c=20 | 97.3k | 91.0k | 39.8k | **+7%** |
| POST 32 B, c=20 | 93.6k | 88.9k | 28.8k | **+5%** |
| TLS HTTP/2 GET 2 B, c=20 | 86.1k | 60.4k | — | **+43%** |
| TLS HTTP/2 GET 4 KiB, c=20 | 61.2k | 46.8k | — | **+31%** |
| GET 1 MiB, c=20 | 10.2k | 10.4k | 2.8k | −1% |
| All scenarios at c=1 | | | | within ±3% |

Run-to-run variance is up to ±10%; differences within ±5% are a tie. The harness is in
[`scripts/compare`](scripts/compare) (`WREQ_JS_DIR` points at a local wreq-js install).

## Install

omreq is not published to npm yet. Build it from source (macOS arm64, Rust 1.100, CMake,
Xcode command-line tools, Node 26, pnpm 11):

```bash
pnpm install --frozen-lockfile
pnpm build
```

```bash
pnpm pack:check   # produces installable tarballs in artifacts/packages
```

The package ships the prebuilt native module as an optional platform dependency;
installing it runs no compiler and downloads nothing.

## Profiles

A profile is everything that makes a client recognizable: TLS parameters, HTTP/2 and
HTTP/1 framing, default headers. Pick one by name; the rest is automatic.

```ts
createClient(); // newest bundled Chrome ('chrome')
createClient({ profile: 'chrome157' }); // pin an exact version
createClient({ profile: 'neutral' }); // a plain client, no browser emulation
```

| Name | Emulates |
| --- | --- |
| `chrome` | newest bundled Chrome (currently `chrome157`) — default |
| `chrome157` | Chrome 157.0.8103.79, macOS |
| `neutral` | `user-agent: Omreq/<version>`, transport defaults |

The HTTP version is negotiated per connection, as in browsers: ALPN offers `h2` and
`http/1.1` over TLS and the server chooses; plain `http://` uses HTTP/1.1. A custom
profile can force `'1.1'` or `'2'`.

Profile headers are Chrome's navigation headers (`accept`, `sec-ch-ua*`, `sec-fetch-*`,
`accept-language`, …). Client and request headers override them, and `null` removes one:

```ts
const api = createClient({
  headers: { accept: 'application/json', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' },
});
```

Need something the presets don't cover? Write your own profile:
[docs/profiles.md](docs/profiles.md).

## Requests and responses

```ts
const client = createClient({ baseUrl: 'https://api.example.com/v1/' });

const created = await client.post('items', { json: { name: 'omreq' } });
if (!created.ok) throw new Error(`HTTP ${created.status}`); // HTTP errors don't throw

const page = await client.get('items', { searchParams: [['page', '2']] });
const items = await page.json();

await client.put('files/report.pdf', { body: new Blob([bytes]) }); // or a stream

await using download = await client.get('https://example.com/video.mp4');
for await (const chunk of download.body) handle(chunk); // backpressured

await client.get('slow', { signal: AbortSignal.timeout(5_000), timeouts: { headersMs: 2_000 } });

await client.close({ graceful: true, timeoutMs: 10_000 }); // let in-flight requests finish
```

Every response body must be read (`text`, `bytes`, `json`, iteration, `toWebStream()`)
or disposed (`await using`, `dispose()`); an unread body keeps its slot.

## Proxies

```ts
createClient({ proxy: 'http://user:pass@proxy.example.com:8080' });
createClient({ proxy: 'socks5h://127.0.0.1:1080' }); // DNS at the proxy
createClient({
  proxy: { https: 'http://corp-proxy:3128', noProxy: ['.internal', '10.0.0.0/8'] },
});
createClient({ proxy: 'env' }); // HTTP_PROXY, HTTPS_PROXY, ALL_PROXY, NO_PROXY
```

HTTPS through an HTTP proxy uses a CONNECT tunnel, so the browser fingerprint and
certificate verification are end-to-end. Environment variables are only read with
`proxy: 'env'`.

## Sessions and cookies

A client is a session: it keeps the connection pool, TLS session tickets and cookie jar
across requests, so create one and reuse it. Separate clients are fully isolated.

```ts
const client = createClient();
await client.post('https://example.com/login', { form: [['user', 'ada'], ['pass', '…']] });
await client.get('https://example.com/account'); // sends the session cookie

await client.cookies.setCookie('consent=yes; Path=/', 'https://example.com');
console.log(await client.cookies.getCookies('https://example.com/'));
```

## Documentation

- [Usage guide](docs/usage.md): bodies, streaming, timeouts, redirects, cookies, proxies,
  DNS overrides, errors, limits, TLS — with TypeScript examples.
- [Profiles](docs/profiles.md): what a profile controls and how to write your own.

## Behavior reference

<details>
<summary><b>Headers</b></summary>

- Client and request `headers` accept a plain object (string, string array, or `null`
  to remove an inherited header), name/value pairs, `Headers` or `Map`.
- Profile, client and request headers share one forbidden set: `host`, `connection`,
  `keep-alive`, `proxy-connection`, `transfer-encoding`, `upgrade`,
  `proxy-authorization`, `content-length`, and `te` other than `trailers`. Profiles
  also reject `cookie` and `authorization`.
- One limit applies everywhere: 200 pairs and 64 KiB. One layer may set a single `cookie`.
- `content-type: null` removes the automatic body content type. An explicit multipart
  content type on a FormData body receives the generated boundary.
- `response.headers.get()` joins repeated fields with `", "` like fetch, except
  Set-Cookie (first value); use `getSetCookie()` or `getAll()` for every value.

</details>

<details>
<summary><b>Bodies and uploads</b></summary>

- Bodies have one owner: `bytes`, `text`, `json`, async iteration and
  `body.toWebStream()` compete for it.
- Strings, byte snapshots, JSON and URL-encoded forms are snapshotted at the call and can
  be replayed on redirects. Blob and FormData are replayable streaming sources.
- Upload chunks reach the native bridge without a JavaScript copy; a producer must not
  mutate a chunk after yielding it.
- Multipart uses one boundary per operation, reads Blob slices on demand and computes the
  length without reading payloads: at most 1,000 parts and 64 KiB of metadata.
- If the final response arrives before a streaming upload finishes, the request body is
  aborted on the wire (connection close or stream reset).

</details>

<details>
<summary><b>Redirects</b></summary>

- `redirect: 'follow'` by default, at most ten hops; `'manual'` returns the 3xx response,
  `'error'` rejects. HTTPS → HTTP needs `allowInsecureRedirects: true`.
- Cross-origin hops remove Authorization, explicit Cookie, Referer and the names in
  `sensitiveHeaders` for the rest of the chain.
- One-shot streams fail with `ERR_BODY_NOT_REPLAYABLE` when a hop keeps their body;
  POST-to-GET transitions stop the original upload immediately.

</details>

<details>
<summary><b>Cookies</b></summary>

- Enabled and isolated per client; `cookies: false` disables the jar. An explicit Cookie
  header overrides automatic values until a cross-origin hop strips it.
- Set-Cookie is stored before the next redirect, with public-suffix rules and LRU-bounded
  count and bytes. Partitioned cookies are discarded and counted.

</details>

<details>
<summary><b>Decompression</b></summary>

- gzip, deflate, br and zstd (chains of up to two) are decoded for every reading method.
  `response.decoded` is then true and `originalHeaders` keeps the encoded headers.
- Skipped with `decompress: false`, when client or request headers set
  `accept-encoding`, for HEAD/204/304 and for unknown codings.
- Decoded output is bounded by `maxBytes`/`maxResponseBytes`; corrupt data fails with
  `ERR_DECODE`.

</details>

<details>
<summary><b>Limits, connections and timeouts</b></summary>

| Option | Default |
| --- | ---: |
| `maxActiveOperations` | 64 |
| `maxQueuedOperations` | 256 |
| `maxActivePerOrigin` | 32 |
| `maxConnections` | 256 |
| `maxConnectionsPerOrigin` | 32 |
| `maxAggregateBufferedResponseBytes` | 128 MiB |
| `maxBufferedResponseBytes` | 64 MiB |
| `connectMs` | 10 s |
| `timeouts.headersMs` | 30 s |

- Admission is round-robin across origins and FIFO within one origin.
- Socket caps are reserved before each TCP connect; all Happy Eyeballs attempts of one
  connection share a single reservation. Through a proxy, sockets are accounted to the
  target origin.
- `headersMs` runs from dispatch to the response headers and so includes connecting;
  `connectMs` separately bounds each TCP+TLS connect.
- Native work runs on 2 Tokio worker threads; `OMREQ_WORKER_THREADS` overrides it.
- Not reported yet: the number of idle pooled sockets (`idleConnections` is `null` while
  connections are open).

</details>

## Development

```bash
pnpm check                     # lint, typecheck, rustfmt, clippy, Rust, Node and Bun tests
pnpm test:transport            # vendored http2 tests
pnpm test:profile:reference    # compare wire bytes with a headed Chrome
node --expose-gc scripts/soak.mjs
node scripts/benchmark.mjs
pnpm evidence                  # bind all checks to the native and JS hashes
```

Tests run against loopback servers with throwaway certificates. The reference runner
starts separate headed Chrome instances with temporary profiles.

| Path | Contents |
| --- | --- |
| `crates/omreq-core` | Rust core: admission, operations, redirects, cookies, connections, profiles |
| `crates/omreq-napi` | Node-API bridge (napi-rs) |
| `packages/omreq` | TypeScript API, loader, uploads, decoding |
| `native/omreq-darwin-arm64` | Platform package for the prebuilt native module |
| `profiles` | Bundled profiles and the profile JSON schema |
| `vendor`, `patches` | Pinned `wreq`, `wreq-proto` and `http2` with their patches |
| `scripts`, `tests`, `fixtures` | Build, packaging, benchmarks, test suites and fixtures |
| `docs` | Usage and profile guides |
| `licenses` | License texts of bundled data (Public Suffix List) |

## License

[MIT](LICENSE). Third-party licenses are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
