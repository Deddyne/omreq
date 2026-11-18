<div align="center">

# ⚡ omreq

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

## 🚀 Quick start

```ts
import { createClient } from 'omreq';

await using client = createClient(); // 🟢 Chrome 157 by default

const res = await client.get('https://example.com/api/items');
console.log(res.status, res.httpVersion, await res.json()); // 200 '2' {…}
```

## ✨ Features

- 🕵️ **Chrome fingerprint out of the box** — TLS, HTTP/2, HTTP/1 and headers, checked against a real Chrome
- 🎯 **One-word profiles** — `'chrome'`, `'chrome157'` or your own in TS/JSON
- 🚀 **Fast** — one native call per request, small bodies arrive with the headers
- 🌐 **Proxies** — HTTP, HTTPS, SOCKS4/5, auth, `noProxy`, `'env'`
- 🍪 **Sessions** — connection pool, TLS resumption and cookie jar per client
- 🌊 **Streaming** — uploads and downloads with backpressure
- 🗜️ **Decoding** — gzip, deflate, br, zstd
- 🛡️ **Bounded** — queues, connection caps and byte limits enforced in Rust
- 🧩 **DX** — TypeScript types, ESM + CJS, `AbortSignal`, typed errors, `json(schema)`

## 📊 Performance

vs [wreq-js](https://github.com/sqdshguy/wreq-js) 3.2.0 (same `wreq` engine) and built-in `fetch`.
Node 26, Apple M4, requests per second:

| Scenario | ⚡ omreq | wreq-js | `fetch` |
| --- | ---: | ---: | ---: |
| GET 2 B, c=20 | **101.4k** | 94.4k | 36.6k |
| GET 4 KiB, c=20 | **97.3k** | 91.0k | 39.8k |
| POST 32 B, c=20 | **93.6k** | 88.9k | 28.8k |
| TLS HTTP/2 GET 2 B, c=20 | **86.1k** 🔥 | 60.4k | — |
| TLS HTTP/2 GET 4 KiB, c=20 | **61.2k** 🔥 | 46.8k | — |

Harness: [`scripts/compare`](scripts/compare).

## 📦 Install

Not on npm yet — build from source (macOS arm64, Rust 1.100, Node 26, pnpm 11):

```bash
pnpm install --frozen-lockfile && pnpm build
```

## 🎭 Profiles

```ts
createClient(); // newest Chrome
createClient({ profile: 'chrome157' }); // exact version
```

### Available profiles

| Browser | Profiles | Platforms |
| --- | --- | --- |
| <img src="https://cdn.simpleicons.org/googlechrome" width="14"> **Chrome** | `chrome157` | 🍎 macOS |

`chrome` is an alias for the newest version in the list.

HTTP version is negotiated like in a browser: ALPN offers `h2` and `http/1.1`, the server
picks. Custom profiles → [docs/profiles.md](docs/profiles.md).

## 🌐 Proxies

```ts
createClient({ proxy: 'http://user:pass@proxy.example.com:8080' });
createClient({ proxy: 'socks5h://127.0.0.1:1080' });
createClient({ proxy: { https: 'http://corp:3128', noProxy: ['.internal'] } });
createClient({ proxy: 'env' }); // HTTP_PROXY / HTTPS_PROXY / NO_PROXY
```

## 🍪 Sessions

```ts
const client = createClient();
await client.post('https://example.com/login', { form: [['user', 'ada']] });
await client.get('https://example.com/account'); // cookie sent automatically
await client.close({ graceful: true });
```

## 📚 Docs

- 📖 [Usage guide](docs/usage.md) — bodies, streaming, timeouts, redirects, errors, limits
- 🎭 [Profiles](docs/profiles.md) — what a profile controls and how to write one

## 🛠️ Development

```bash
pnpm check     # lint, types, clippy, Rust + Node + Bun tests
pnpm evidence  # full qualification, incl. wire comparison with real Chrome
```

## 📄 License

[MIT](LICENSE) · [third-party notices](THIRD_PARTY_NOTICES.md)
