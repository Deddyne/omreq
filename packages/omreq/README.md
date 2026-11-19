# omreq

The fastest HTTP client for Node.js and Bun with a real Chrome fingerprint: TLS
(JA3/JA4), HTTP/2 (Akamai), HTTP/3 (QUIC) and header order identical to Chrome, byte for
byte. Rust + BoringSSL in-process: up to 43% faster than wreq-js and up to 3× faster than
`fetch`.

![status](https://img.shields.io/badge/status-release-2ea44f)
![chrome](https://img.shields.io/badge/Chrome-158-4285F4?logo=googlechrome&logoColor=white)
![protocols](https://img.shields.io/badge/HTTP-1.1%20%7C%202%20%7C%203-8A2BE2)
![runtimes](https://img.shields.io/badge/runtimes-Node%2022%2B%20%7C%20Bun-blue)

```ts
import { createClient } from 'omreq';

await using client = createClient(); // newest bundled Chrome by default

const res = await client.get('https://example.com/api/items');
console.log(res.status, res.httpVersion, await res.json());
```

```ts
createClient({ profile: 'chrome158' }); // exact version; 'neutral' disables emulation
createClient({ proxy: 'socks5h://127.0.0.1:1080' }); // http, https, socks4/4a/5/5h, 'env'
createClient({ resolve: { 'api.example.com': '203.0.113.10' } });
await client.close({ graceful: true, timeoutMs: 10_000 });
```

## When to use

When a server tells Node.js and Chrome apart: `fetch`, axios or got get 403, 429 or a
challenge page where Chrome gets 200, and Chrome's User-Agent and headers don't help
because the server reads the TLS (JA3/JA4), HTTP/2 (Akamai) or QUIC fingerprint. omreq
covers the same ground as wreq-js, impers, got-scraping, impit, node-tls-client, CycleTLS and
curl-impersonate, as an in-process native client. It is an HTTP client: it doesn't run
JavaScript or solve CAPTCHAs.

## Comparison

|  | **omreq** | wreq-js 3.2 | impers 0.1 |
| --- | :---: | :---: | :---: |
| Newest Chrome profile | ![158](https://img.shields.io/badge/158-2ea44f) | ![149](https://img.shields.io/badge/149-cf222e) | ![152](https://img.shields.io/badge/152-cf222e) |
| HTTP/3 with Chrome's QUIC fingerprint, on by default like Chrome | ![yes](https://img.shields.io/badge/yes-2ea44f) | ![no HTTP/3](https://img.shields.io/badge/no%20HTTP%2F3-cf222e) | ![opt-in only](https://img.shields.io/badge/opt--in%20only-cf222e) |
| Tested against a real Chrome capture | ![byte for byte](https://img.shields.io/badge/byte%20for%20byte-2ea44f) | ![hashes only](https://img.shields.io/badge/hashes%20only-cf222e) | ![hashes only](https://img.shields.io/badge/hashes%20only-cf222e) |
| TLS HTTP/2 throughput, req/s | ![86.1k](https://img.shields.io/badge/86.1k-2ea44f) | ![60.4k](https://img.shields.io/badge/60.4k-cf222e) | ![not measured](https://img.shields.io/badge/not%20measured-lightgrey) |
| Native engine ships in the npm package | ![yes](https://img.shields.io/badge/yes-2ea44f) | ![yes](https://img.shields.io/badge/yes-2ea44f) | ![downloaded at first run](https://img.shields.io/badge/downloaded%20at%20first%20run-cf222e) |
| Release status | ![release](https://img.shields.io/badge/release-2ea44f) | ![stable](https://img.shields.io/badge/stable-2ea44f) | ![alpha](https://img.shields.io/badge/alpha-cf222e) |

"Byte for byte" means the qualification suite captures real Chrome and compares the TLS
ClientHello, HTTP/1.1 request, HTTP/2 frames, QUIC Initial and QPACK headers with omreq's
exactly, on Node and Bun. JA3/JA4/Akamai hashes leave most of those bytes out.

## Features

- Bundled profiles `chrome` (newest), `chrome158`, `chrome157`, `neutral`, or your own in
  TypeScript/JSON.
- HTTP/1.1 and HTTP/2 over ALPN, pooling, TLS session resumption.
- HTTP/3 like Chrome: origins that advertise it (Alt-Svc or a DNS HTTPS record) are reached
  over QUIC with Chrome's QUIC fingerprint, with TCP fallback.
- Cookie jar per client, redirects with cross-origin secret stripping,
  gzip/deflate/br/zstd decoding.
- Streaming uploads and downloads with backpressure; every body must be read or disposed.
- HTTP error statuses resolve with `ok: false`; failures reject with a typed `OmreqError`.
- `json(schema)` validates with any Standard Schema v1 library.
- TypeScript types, ESM and CommonJS.

Prebuilt native modules ship as optional packages, so installing runs no compiler:
`@omreq/darwin-arm64` (macOS 26+), `@omreq/linux-x64-gnu` (glibc 2.35+),
`@omreq/win32-x64-msvc` (Windows 10/11). Runtimes: Node.js 22+ and Bun.

## Documentation

- [Usage guide](https://github.com/Deddyne/omreq/blob/main/docs/usage.md)
- [Profiles](https://github.com/Deddyne/omreq/blob/main/docs/profiles.md)
- [AI agents](https://github.com/Deddyne/omreq/blob/main/docs/ai.md)

For coding agents, the package includes `llms-full.txt` (all documentation for this
version in one file) and an Agent Skill at `skills/omreq/SKILL.md`.
