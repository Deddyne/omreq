<div align="center">

# omreq

**The fastest HTTP client for Node.js and Bun with a real Chrome fingerprint.**

TLS (JA3/JA4), HTTP/2 (Akamai), HTTP/3 (QUIC) and header order identical to Chrome, byte for byte.<br>
Rust + BoringSSL in-process: up to **43% faster than wreq-js** and **up to 3× faster than `fetch`**.

![status](https://img.shields.io/badge/status-release-2ea44f)
![chrome](https://img.shields.io/badge/Chrome-158-4285F4?logo=googlechrome&logoColor=white)
![protocols](https://img.shields.io/badge/HTTP-1.1%20%7C%202%20%7C%203-8A2BE2)
![runtimes](https://img.shields.io/badge/runtimes-Node%2022%2B%20%7C%20Bun-blue)
![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey)
![license](https://img.shields.io/badge/license-MIT-green)

</div>

## Quick start

```bash
npm install omreq
```

```ts
import { createClient } from 'omreq';

await using client = createClient(); // Chrome 158 by default

const res = await client.get('https://example.com/api/items');
console.log(res.status, res.httpVersion, await res.json()); // 200 '2' {…}
```

## When to use

When a server tells Node.js and Chrome apart:

- `fetch`, axios or got get **403, 429 or a challenge page** where Chrome gets 200
- Chrome's User-Agent and headers don't help: the server reads the **TLS (JA3/JA4), HTTP/2
  (Akamai) or QUIC fingerprint**
- you need plain HTTP speed, not a headless browser
- you're on wreq-js, impers, got-scraping, impit, node-tls-client, CycleTLS or shelling out to
  curl-impersonate

omreq is an HTTP client: it doesn't run JavaScript or solve CAPTCHAs.

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

- **Chrome fingerprint out of the box**: TLS, HTTP/1.1, HTTP/2, HTTP/3 and headers, checked
  against a real Chrome
- **HTTP/3 like Chrome**: discovered through Alt-Svc or DNS HTTPS records, with TCP fallback
- **One-word profiles**: `'chrome'`, `'chrome158'` or your own in TS/JSON
- **Fast**: one native call per request, small bodies arrive with the headers
- **Proxies**: HTTP, HTTPS, SOCKS4/5, auth, `noProxy`, `'env'`
- **Sessions**: connection pool, TLS resumption and cookie jar per client
- **Streaming**: uploads and downloads with backpressure
- **Decoding**: gzip, deflate, br, zstd
- **Bounded**: queues, connection caps and byte limits enforced in Rust
- **Developer experience**: TypeScript types, ESM + CJS, `AbortSignal`, typed errors,
  `json(schema)`

## Performance

Against [wreq-js](https://github.com/sqdshguy/wreq-js) 3.2.0 (same `wreq` engine) and built-in
`fetch`. Node 26, Apple M4, requests per second:

| Scenario | omreq | wreq-js | `fetch` |
| --- | ---: | ---: | ---: |
| GET 2 B, c=20 | **101.4k** | 94.4k | 36.6k |
| GET 4 KiB, c=20 | **97.3k** | 91.0k | 39.8k |
| POST 32 B, c=20 | **93.6k** | 88.9k | 28.8k |
| TLS HTTP/2 GET 2 B, c=20 | **86.1k** | 60.4k | — |
| TLS HTTP/2 GET 4 KiB, c=20 | **61.2k** | 46.8k | — |

Harness: [`scripts/compare`](scripts/compare).

## Install

```bash
npm install omreq
```

Prebuilt binaries, nothing to compile:

| OS | Arch | Package |
| --- | --- | --- |
| macOS 26+ | arm64 | `@omreq/darwin-arm64` |
| Linux (glibc 2.35+) | x64 | `@omreq/linux-x64-gnu` |
| Windows 10 / 11 | x64 | `@omreq/win32-x64-msvc` |

Runtimes: Node.js 22+ and Bun.

## Profiles

```ts
createClient(); // newest Chrome
createClient({ profile: 'chrome158' }); // exact version
```

| Browser | Profiles | Platforms |
| --- | --- | --- |
| **Chrome** | `chrome158` `chrome157` | macOS |

`chrome` is an alias for the newest version in the list.

The HTTP version is negotiated like in a browser: ALPN offers `h2` and `http/1.1`, the server
picks, and origins that advertise HTTP/3 (Alt-Svc or a DNS HTTPS record) are reached over QUIC
with Chrome's QUIC and HTTP/3 fingerprint, falling back to TCP if UDP is blocked. Custom
profiles: [docs/profiles.md](docs/profiles.md).

## Proxies

```ts
createClient({ proxy: 'http://user:pass@proxy.example.com:8080' });
createClient({ proxy: 'socks5h://127.0.0.1:1080' });
createClient({ proxy: { https: 'http://corp:3128', noProxy: ['.internal'] } });
createClient({ proxy: 'env' }); // HTTP_PROXY / HTTPS_PROXY / NO_PROXY
```

## Sessions

```ts
const client = createClient();
await client.post('https://example.com/login', { form: [['user', 'ada']] });
await client.get('https://example.com/account'); // cookie sent automatically
await client.close({ graceful: true });
```

## Documentation

- [Usage guide](docs/usage.md): bodies, streaming, timeouts, redirects, HTTP/3, errors, limits
- [Profiles](docs/profiles.md): what a profile controls and how to write one
- [AI agents](docs/ai.md): migrating from other clients, common mistakes, docs for Claude Code,
  Cursor and Copilot ([`llms.txt`](llms.txt), [`llms-full.txt`](llms-full.txt),
  [skill](packages/omreq/skills/omreq/SKILL.md))

## Development

```bash
pnpm check        # lint, types, clippy, Rust + Node + Bun tests
pnpm profile:new  # new Chrome out? capture it and verify byte for byte
pnpm evidence     # full qualification, incl. wire comparison with real Chrome
```

## License

[MIT](LICENSE) · [third-party notices](THIRD_PARTY_NOTICES.md)
