# Omreq — internal prototype

This private package is an internal qualification artifact for macOS arm64.
It is **not** the public alpha and includes **no verified Chrome profile**.
Supported runtime policy: Node 26 LTS and the qualified Bun version. Node 22/24
are outside support and rejected before native loading.

```js
import { createClient } from 'omreq';
const client = createClient();
try {
  const response = await client.get('https://example.com/');
  try {
    console.log(response.status, await response.text());
  } finally {
    await response.dispose();
  }
} finally {
  await client.close();
}
```

Implemented: custom TS/JSON profiles (TLS/HTTP1/HTTP2 adapters), lazy native
loading, HTTP/1.1 and TLS HTTP/2, pull streams, upload demand, cancellation,
operation limits, explicit response ownership, JSON/forms and Standard Schema v1
validation. ESM and CJS share a native loader. Binary installation uses an exact
optional `omreq-darwin-arm64` package without compilation or downloader scripts.

`createClient()` is synchronous and lazy. Request validation rejects its Promise.
Every response must be consumed or disposed. Bodies are single-use. Available
reading methods are `bytes`, `text`, `json`, async iteration over `response.body`
and `response.body.toWebStream()`. `json()` returns unknown; `json(schema)` returns
the schema's validated output. HTTP status errors return `ok: false` responses.

The default profile is `omreq/custom-default`. `profile: 'chrome'` fails until a
verified catalog exists. Profiles can be constructed using `defineProfile`,
`parseProfile`, `serializeProfile` and `checkProfile`. Compatibility is not proof
of browser fidelity. Native/JS build information and counters are exposed through
`getRuntimeInfo`, `client.getInfo` and `client.getStats`.

Redirects default to `follow` with up to ten transitions. `redirect: 'manual'`
returns the original response and body; `'error'` rejects a redirect.
`maxRedirects` accepts 0–10. HTTPS downgrade requires
`allowInsecureRedirects: true`. Cross-origin hops permanently strip Authorization,
explicit Cookie, Referer and the union of client/request `sensitiveHeaders`.
`response.redirects` is immutable and records status, source/destination URLs and
method changes. URLs may contain private query values; redact them before logs.
Materialized bytes, JSON and URL-encoded forms replay their original snapshot;
Blob and FormData replay through bounded streaming readers, using the same
multipart boundary on every hop. One-shot streams cannot replay. POST-to-GET stops the old upload. History,
intermediate bodies and total deadline are owned by one Rust operation.

Cookies default to an isolated Rust jar, including intermediate redirect responses.
`client.cookies.setCookie(value, url)`, `getCookies(url)` and `clear()` are async;
they initialize native state without opening a connection. Returned records and
arrays are immutable. `cookies: false` disables storage/sending and the jar API;
explicit Cookie still works. Explicit Cookie overrides automatic values until a
cross-origin hop strips it, after which the jar is recalculated for each URL.
The jar uses pinned PSL public/private rules and domain/path/Secure/expiry checks.
Limits: 3,000 cookies, 180 per registrable domain, 4 KiB per record and 12 MiB of
charged storage, with expired-first/LRU eviction. SameSite is metadata; there is
no browser navigation context. Partitioned is unsupported and counted/discarded.
`cookieCount`, `cookieBytes`, `discardedCookies`, `partitionedCookies` and
`evictedCookies` are available in stats. Close clears stored credentials.

Multipart preserves field order, duplicates and binary bytes. Names/filenames
escape CR/LF/quotes; filenames use the basename. Text newlines normalize to CRLF.
Immutable Blob payloads are read in slices of at most 64 KiB on demand, without
whole-body materialization. Multipart text/metadata share the retained-request
budget; limits are 1,000 parts and 64 KiB of encoded metadata. Length is computed
without reading Blob content. User byte-stream chunks retain their existing cap.

Current limitations: no proxy API, no decompression and no graceful close period. Unsupported options
are rejected. Certificate and hostname checks remain enabled; `ca` adds PEM
certificates to bundled roots. `trustStore: 'chromium'` explicitly selects bundled
Chromium roots; it does not implement Chromium's full verifier. Environment
proxies, retries and the transport's own redirect loop are disabled.
Idle accounting/eviction, complete protocol/DNS task ownership, transport memory limits,
complete retained-request accounting and decoder bounds require further work.
The requested minimum macOS version has not been verified on that OS. Workers
are outside this prototype's scope. No performance guarantee is made.

`maxActiveOperations` (64), `maxQueuedOperations` (256) and
`maxActivePerOrigin` (16) bound application admission. Ready origins alternate;
eligible requests within one origin preserve FIFO. An origin-blocked request
does not reserve a global slot. Redirects retain their global operation slot
and release the previous origin before waiting for the next. An already-admitted
redirect can bypass a fresh destination request waiting for a global slot; this
avoids deadlock. These are operation limits, separate from TCP connection caps.

Full reads share `maxAggregateBufferedResponseBytes` (128 MiB). Rust reserves
credits for retained chunks and the extra concatenation allocation before that
allocation occurs. A single chunk transfers directly. Budget failure returns
`ERR_RESOURCE_LIMIT`; each collector releases its own credits on all exits.
Delivered results become user-owned and no longer consume library credits.
For multi-chunk full reads, allow temporary capacity for the result copy in
addition to the collected chunks. This budget does not bound total RSS.

`getStats()` returns an immutable typed snapshot. `origins` records origin
admission counts, `originWaitOperations` counts active chains waiting for a new
origin, and `bufferedResponseBytes` reports full-read credits. Old origin records
are removed after their last operation. `maxConnections` (64) and
`maxConnectionsPerOrigin` (8) bound raw TCP sockets, including creation and
Happy Eyeballs attempts. `connections`, `creatingConnections`,
`waitingConnections` and `connectionOrigins` report these separately from
operation admission. Capacity returns after raw socket drop. Close interrupts
pending socket I/O and waits for those sockets and owned operation tasks.
The pool keeps up to `maxConnectionsPerOrigin` idle sockets per origin (and
`maxConnections` overall) for 30 seconds, so parallel requests reuse sockets
instead of reconnecting. When a new socket waits behind the global TCP cap, the
least recently used idle socket of an origin with no active or queued operation
is closed for it. A connect that loses the pool race to an idle socket finishes
in the background into the pool if it already holds TCP capacity, and is
abandoned while it still waits for capacity. `idleConnections` remains null while
idle classification is unavailable. Both outer retry policy and the inner reused-
connection replay loop are disabled; HTTP2 REFUSED_STREAM is not replayed.
