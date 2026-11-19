---
name: omreq
description: Make HTTP requests from Node.js or Bun that look like Google Chrome on the wire (TLS JA3/JA4, HTTP/2 Akamai fingerprint, header order) with the omreq library. Use when writing or fixing code that sends HTTP requests which fetch, undici, axios or got get blocked on (403, 429, Cloudflare/Akamai/DataDome challenge) while Chrome is not, when a task mentions TLS or JA3/JA4 fingerprints, browser impersonation, curl-impersonate or curl_cffi in Node.js, when migrating from wreq-js, node-wreq, impit, got-scraping, node-tls-client or CycleTLS, or when the project already depends on omreq.
license: MIT
metadata:
  library: omreq
---

# omreq

omreq is an HTTP client for Node.js 22+ and Bun. Its TLS ClientHello, HTTP/2 connection
settings and header order match a real Chrome (default profile: newest bundled Chrome).
The engine is native (Rust + BoringSSL), prebuilt for macOS arm64, Linux x64 glibc and
Windows x64.

Full documentation for the installed version: `llms-full.txt` in the package root
(`node_modules/omreq/llms-full.txt`). Read the relevant section before using an option
not shown here.

## Install

```bash
npm install omreq
```

## Core pattern

```ts
import { createClient, isOmreqError } from 'omreq';

// One client per configuration (profile, proxy, base URL). Reuse it: it owns the
// connection pool, TLS session cache and cookie jar.
const client = createClient({
  // profile: 'chrome' is the default (newest bundled Chrome); 'chrome158', 'chrome157';
  // 'neutral' disables browser emulation.
  // proxy: 'http://user:pass@host:8080' | 'socks5h://host:1080' | 'env',
  // baseUrl: 'https://api.example.com/v1/',
});

try {
  const res = await client.get('https://example.com/api/items', {
    searchParams: [['page', '2']],
    headers: { accept: 'application/json' },
  });
  if (!res.ok) {
    await res.dispose(); // release the unread body
    throw new Error(`HTTP ${res.status}`);
  }
  const data = await res.json();
} catch (error) {
  if (isOmreqError(error)) console.error(error.code, error.phase, error.message);
  throw error;
} finally {
  await client.close();
}
```

## Rules

- Named imports only: `import { createClient } from 'omreq'` or
  `const { createClient } = require('omreq')`. There is no default export and no
  top-level `get` / `fetch`.
- Methods: `client.get|post|put|patch|delete|head|options(url, options)` and
  `client.request(url, { method })`.
- HTTP 4xx/5xx resolve with `res.ok === false`. Network, TLS, timeout, limit and usage
  failures reject with `OmreqError` (`code` such as `ERR_TIMEOUT`, `ERR_TLS`, `ERR_PROXY`).
- Read every body (`text()`, `json()`, `json(schema)`, `bytes({ maxBytes })`,
  `for await (const chunk of res.body)`, `res.body.toWebStream()`) or call `dispose()`.
  `await using res = await client.get(url)` disposes automatically.
- Bodies: `json: value`; `form: [['user', 'ada']]` or `URLSearchParams` (not a plain
  object); `body: string | Uint8Array | Blob | FormData | AsyncIterable<Uint8Array> |
  ReadableStream`.
- Timeouts in milliseconds: `connectMs` on the client, `timeouts: { headersMs, totalMs,
  bodyIdleMs }` on the client or per request. Cancel with `signal`.
- Cookies are stored per client automatically; `client.cookies.getCookies(url)`,
  `setCookie(str, url)`, `clear()`. Disable with `cookies: false`.
- Keep the profile's Chrome headers. Override only what the request needs (for JSON APIs:
  `accept`, `sec-fetch-mode: 'cors'`, `sec-fetch-dest: 'empty'`). Remove an inherited
  header with `null`.
- Do not set `NODE_TLS_REJECT_UNAUTHORIZED` or pass an `agent`; omreq does not use Node's
  TLS stack. Extra CA: `ca: pemString`.
- HTTP/3 is automatic, as in Chrome: origins that advertise `h3` (Alt-Svc or DNS HTTPS
  record) are reached over QUIC (`res.httpVersion === '3'`), with TCP fallback. Proxied
  clients stay on TCP; `http3: false` turns it off.

## Limits of the tool

omreq does not execute JavaScript or solve JavaScript challenges and CAPTCHAs. For pages
that need them, use a browser automation tool and omreq for the plain HTTP requests.
