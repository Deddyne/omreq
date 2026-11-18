# omreq

An HTTP client for Node.js and Bun that looks like Chrome on the wire — TLS ClientHello,
HTTP/2 framing and header order included. The transport is a Rust core (wreq + BoringSSL)
loaded in-process as a Node-API module.

```ts
import { createClient } from 'omreq';

await using client = createClient(); // newest bundled Chrome by default

const res = await client.get('https://example.com/api/items');
console.log(res.status, res.httpVersion, await res.json());
```

```ts
createClient({ profile: 'chrome157' }); // exact version; 'neutral' disables emulation
createClient({ proxy: 'socks5h://127.0.0.1:1080' }); // http, https, socks4/4a/5/5h, 'env'
createClient({ resolve: { 'api.example.com': '203.0.113.10' } });
await client.close({ graceful: true, timeoutMs: 10_000 });
```

- HTTP/1.1 and HTTP/2 over ALPN, pooling, TLS session resumption.
- Cookie jar per client, redirects with cross-origin secret stripping,
  gzip/deflate/br/zstd decoding.
- Streaming uploads and downloads with backpressure; every body must be read or disposed.
- HTTP error statuses resolve with `ok: false`; failures reject with a typed `OmreqError`.
- `json(schema)` validates with any Standard Schema v1 library.

Supported: macOS arm64, Node 26, Bun 1.4. The native module ships as the optional
`omreq-darwin-arm64` package; installing runs no compiler and downloads nothing.

Documentation: [usage guide](https://github.com/Deddyne/omreq/blob/main/docs/usage.md),
[profiles](https://github.com/Deddyne/omreq/blob/main/docs/profiles.md).
