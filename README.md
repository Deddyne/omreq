<div align="center">

# omreq

**A Rust HTTP/1.1 and HTTP/2 client for Node.js and Bun**

Native transport (`wreq` + BoringSSL) behind a small, strict TypeScript API:
explicit body ownership, bounded resources, redirect and cookie policy in Rust.

![status](https://img.shields.io/badge/status-internal%20prototype-orange)
![platform](https://img.shields.io/badge/platform-macOS%20arm64-lightgrey)
![runtimes](https://img.shields.io/badge/runtimes-Node%2026%20LTS%20%7C%20Bun%201.4-blue)
![license](https://img.shields.io/badge/license-MIT-green)

</div>

> [!IMPORTANT]
> omreq is a **pre-release prototype**: packages are marked private and nothing is
> published to npm yet. APIs may still change.

## Contents

- [Highlights](#highlights)
- [Performance](#performance)
- [Getting started](#getting-started)
- [Usage](#usage)
- [Profiles](#profiles)
- [Behavior reference](#behavior-reference)
- [Documentation](#documentation)
- [Development](#development)
- [Project layout](#project-layout)
- [License](#license)

## Highlights

- **One native call per request.** Small bodies (known length ≤ 64 KiB) arrive together
  with the headers; larger ones stream through bounded bridge chunks or one `readAll`.
- **HTTP/1.1 and HTTP/2 over TLS** with certificate and hostname verification, a custom
  TS/JSON transport profile and lazy native initialization.
- **Explicit ownership.** Every response body has one owner (`bytes`, `text`, `json`,
  async iteration or a web stream) and must be consumed or disposed.
- **Bounded by design.** Admission queues, per-origin caps, TCP socket caps, an aggregate
  buffered-bytes budget and header limits are enforced in Rust and exposed as typed stats.
- **Redirects and cookies in Rust.** Bounded history, body replay, sticky removal of
  secrets across origins, an RFC 6265bis cookie jar with PSL rules.
- **Transparent decompression** of gzip, deflate, br and zstd with decoded-size limits.
- **Standard Schema v1** validation for `response.json(schema)`.
- **ESM and CJS** entry points share one implementation and one native loader.

## Performance

Compared with [wreq-js](https://github.com/sqdshguy/wreq-js) 3.2.0 (same `wreq` engine and
BoringSSL) on its own scenarios. Node 26, Apple M4, server in a separate process,
requests per second, mean of 5 runs:

| Scenario | omreq | wreq-js | runtime `fetch` | omreq vs wreq-js |
| --- | ---: | ---: | ---: | ---: |
| GET 2 B, c=20 | 101.4k | 94.4k | 36.6k | **+7%** |
| GET 4 KiB, c=20 | 97.3k | 91.0k | 39.8k | **+7%** |
| POST 32 B, c=20 | 93.6k | 88.9k | 28.8k | **+5%** |
| TLS HTTP/2 GET 2 B, c=20 | 86.1k | 60.4k | — | **+43%** |
| TLS HTTP/2 GET 4 KiB, c=20 | 61.2k | 46.8k | — | **+31%** |
| GET 1 MiB, c=20 | 10.2k | 10.4k | 2.8k | −1% |
| All scenarios at c=1 | | | | within ±3% |

Run-to-run variance is up to ±10%; differences within ±5% are a tie. The harness is in
[`scripts/compare`](scripts/compare) (`WREQ_JS_DIR` points at a local wreq-js install);
`scripts/benchmark.mjs` compares omreq with the runtime's own `http`/`https`/`http2`
modules.

## Getting started

Requirements for development: macOS arm64, Rust 1.100.0, CMake, Apple command-line
tools, Node 26 and pnpm 11.22.0. Consumers of the packed artifact do not compile Rust
or download a binary in an install script.

```sh
pnpm install --frozen-lockfile
pnpm build        # generate types, compile TypeScript, build the native module
pnpm check        # lint, typecheck, rustfmt, clippy, Rust tests, Node and Bun tests
pnpm pack:check   # pack and install the tarballs via npm, pnpm and Bun
```

The workspace package lives in `packages/omreq`. After building, import its compiled
entry point locally or install the tarballs produced in `artifacts/packages`.

## Usage

```js
import { createClient } from './packages/omreq/dist/index.mjs';

const client = createClient(); // custom profile; no native load or connection yet
try {
  await using response = await client.get('https://example.com/');
  console.log(response.status, await response.text());
} finally {
  await client.close();
}
```

- HTTP errors resolve with `ok: false`; they do not throw.
- `response.json()` returns `unknown`; `response.json(schema)` returns the validator's
  output type.
- `await using` (or `response.dispose()`) releases an unread body. A response holds its
  operation slot until EOF or cancellation.
- `client.close()` cancels active and queued work and waits for owned native activity.

## Profiles

No verified Chrome profile is bundled: `profile: 'chrome'` fails explicitly, and the
default `omreq/custom-default` is not browser emulation. A profile maps TLS
versions, algorithms and extensions, explicit HTTP/2 settings and HPACK policy,
HTTP/1 header formatting and header pairs. The Chrome 157 candidate is under
qualification. Compatibility means the options can be applied, not that they match
Chrome. See [docs/profiles.md](docs/profiles.md).

```js
import { defineProfile, checkProfile } from './packages/omreq/dist/index.mjs';

const profile = defineProfile({
  schemaVersion: 1,
  id: 'local/my-client',
  revision: 1,
  target: { family: 'custom', platform: 'generic' },
  defaults: 'omreq-transport-v1',
  requires: [],
  transport: { httpVersion: 'auto', tls: { minVersion: '1.2', maxVersion: '1.3' } },
  headers: [['user-agent', 'MyClient/1']],
});
const report = await checkProfile(profile); // native validation; no network
```

## Behavior reference

<details open>
<summary><b>Headers</b></summary>

- Client and request `headers` accept a plain object (string, string array, or `null`
  to remove an inherited header), name/value pairs, `Headers` or `Map`. Other objects
  are rejected.
- Profile, client and request headers share one forbidden set: `host`, `connection`,
  `keep-alive`, `proxy-connection`, `transfer-encoding`, `upgrade`,
  `proxy-authorization`, `content-length`, and `te` other than `trailers`. Profiles
  also reject `cookie` and `authorization`.
- One limit applies everywhere: 200 pairs and 64 KiB. One layer may set a single `cookie`.
- `content-type: null` removes the automatic body content type. An explicit multipart
  content type on a FormData body receives the generated boundary.
- `response.headers.get()` joins repeated fields with `", "` like fetch, except
  Set-Cookie (first value); use `getSetCookie()` or `getAll()` for every value.
- `searchParams` replaces only the named query keys and keeps the other query bytes.
- `response.httpVersion` is `'1.0'`, `'1.1'` or `'2'`.

</details>

<details>
<summary><b>Bodies and uploads</b></summary>

- Bodies have one owner: `bytes`, `text`, `json`, async iteration and
  `body.toWebStream()` compete for it.
- Strings, byte snapshots, JSON and URL-encoded forms are snapshotted at the call and can
  be replayed on redirects. Blob and FormData are replayable streaming sources.
- Upload chunks reach the native bridge without a JavaScript copy; a producer must not
  mutate a chunk after yielding or enqueuing it until its next read is requested.
- A stalled user iterator cannot be forced to stop its side effects: cleanup requests
  `return()` without waiting behind a pending `next()`, and an async generator closes
  once that step settles.
- Multipart snapshots ordered parts, uses one boundary per operation, reads immutable Blob
  slices on demand and computes the length without reading payloads. Text and metadata
  share the retained-request budget: at most 1,000 parts and 64 KiB of metadata.
- The retained-request budget is released when final response headers arrive.
- If the final response arrives before a streaming upload finishes, the request body is
  aborted on the wire (connection close or stream reset) instead of ending cleanly.

</details>

<details>
<summary><b>Redirects</b></summary>

- `redirect: 'follow'` by default, at most ten transitions. Options: `redirect:
  'manual' | 'error' | 'follow'`, `maxRedirects` (0–10), `allowInsecureRedirects`
  (false by default) and `sensitiveHeaders`.
- Cross-origin hops remove Authorization, explicit Cookie, Referer and the named
  sensitive fields for the rest of the chain.
- One-shot streams fail with `ERR_BODY_NOT_REPLAYABLE` when a hop preserves their body;
  POST-to-GET transitions stop the original upload immediately.
- A raw UTF-8 `Location` is decoded as UTF-8; small HTTP/1 intermediate bodies are
  drained so the connection returns to the pool.

</details>

<details>
<summary><b>Cookies</b></summary>

- Enabled and isolated per client; `cookies: false` disables the jar. Explicit Cookie
  headers remain supported and override automatic values until a cross-origin hop
  strips them.
- Rust stores Set-Cookie before the next redirect, applies pinned public/private PSL
  rules and bounds count and bytes with LRU eviction.
- Per RFC 6265bis, name plus value may have 4,096 octets and attribute values over
  1,024 octets are ignored.
- `client.cookies.setCookie(value, url)`, `getCookies(url)` and `clear()` are
  asynchronous; jar access initializes native state without network.
- SameSite is metadata (there is no browser navigation context). Partitioned cookies are
  discarded with counters. Values returned by the jar are credentials.

</details>

<details>
<summary><b>Decompression</b></summary>

- `Content-Encoding` gzip, deflate (zlib or raw), br and zstd (chains of up to two) are
  decoded for `bytes`, `text`, `json` and streams. `response.decoded` is then true,
  `headers` omits Content-Encoding and Content-Length, `originalHeaders` keeps them.
- Skipped with `decompress: false` (client or request), when client or request headers
  set `accept-encoding`, for HEAD/204/304 and for unknown codings.
- Full reads bound encoded and decoded bytes by `maxBytes` (or
  `maxBufferedResponseBytes`); `maxResponseBytes` also bounds decoded output. Overruns
  fail with `ERR_RESOURCE_LIMIT`, corrupt data with `ERR_DECODE`.
- Decoding runs in JavaScript (`node:zlib`), not in the Rust core.

</details>

<details>
<summary><b>Admission, limits and connections</b></summary>

| Option | Default |
| --- | ---: |
| `maxActiveOperations` | 64 |
| `maxQueuedOperations` | 256 |
| `maxActivePerOrigin` | 32 |
| `maxConnections` | 256 |
| `maxConnectionsPerOrigin` | 32 |
| `maxAggregateBufferedResponseBytes` | 128 MiB |
| `maxBufferedResponseBytes` | 64 MiB |

- Admission selects ready origins round-robin, FIFO among eligible requests within an
  origin. Waiting for a full origin consumes no global slot; a redirect keeps its global
  slot and releases its old origin before waiting for the destination.
- Full reads are charged to the aggregate buffered budget while they are filled;
  exhausting it fails with `ERR_RESOURCE_LIMIT` instead of waiting with owned bytes.
- `maxConnections` and `maxConnectionsPerOrigin` reserve capacity before each raw TCP
  socket; all address-race attempts of one connection share a single reservation.
  `connections`, `creatingConnections`, `waitingConnections` and `connectionOrigins`
  report this physical lifetime.
- The pool keeps up to `maxConnectionsPerOrigin` idle sockets per origin. A socket
  waiting behind the global cap closes the least recently used idle socket of an origin
  without active or queued operations.
- Native work runs on 2 Tokio worker threads; `OMREQ_WORKER_THREADS` overrides it.

</details>

<details>
<summary><b>Not implemented yet</b></summary>

- Proxy configuration (environment proxies are ignored) and graceful-close options.
- Automatic retries and the transport's own redirect loop are disabled on purpose.
- Header waiting for requests without an upload includes connect time.
- Idle socket counters, complete protocol/DNS task ownership and complete
  transport/decoder byte accounting; `idleConnections` is reported as unknown.

</details>

## Documentation

- [Usage guide](docs/usage.md): requests, bodies, streaming, timeouts, redirects,
  cookies, errors, limits, TLS — with TypeScript examples.
- [Profiles](docs/profiles.md): what a profile controls and how to write one.

## Development

```sh
pnpm test                      # Node test suite
pnpm test:bun                  # Bun test suite
pnpm test:transport            # vendored http2 tests
pnpm test:transport:wreq       # vendored wreq tests
node scripts/runtime-matrix.mjs
pnpm test:profile:reference    # compare wire output with a headed Chrome
node --expose-gc scripts/soak.mjs
pnpm evidence                  # bind all checks to the native and JS hashes
node scripts/snapshot-evidence.mjs
```

Tests use loopback HTTP/TLS servers and ephemeral test certificates. The reference
runner launches separate headed Chrome instances with temporary profiles; no user
browser profile is read. `pnpm evidence` and `snapshot-evidence.mjs` produce a
checksummed development snapshot under `artifacts/releases/` (not committed).

## Project layout

| Path | Contents |
| --- | --- |
| `crates/omreq-core` | Rust core: admission, operations, redirects, cookies, connections, profiles |
| `crates/omreq-napi` | Node-API bridge (napi-rs) and the shared completion channel |
| `packages/omreq` | TypeScript API, loader, uploads, decoding |
| `native/omreq-darwin-arm64` | Platform package for the prebuilt native module |
| `profiles` | Profile JSON schema, the default profile and the Chrome candidate |
| `vendor` | Pinned `wreq`, `wreq-proto` and `http2` with documented patches (`patches/`) |
| `scripts` | Build, packaging, notices, evidence, benchmark and soak tooling |
| `tests`, `fixtures` | Node/Bun test suites and loopback fixtures |
| `docs` | [Usage guide](docs/usage.md) and [profile guide](docs/profiles.md) |
| `licenses` | License texts of bundled data (Public Suffix List) |

## License

[MIT](LICENSE). Third-party licenses are collected in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
