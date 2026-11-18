# Using omreq

All examples are TypeScript (ESM). CommonJS works the same way through
`require('omreq')`.

- [Client lifecycle](#client-lifecycle)
- [Making requests](#making-requests)
- [Reading responses](#reading-responses)
- [Request bodies](#request-bodies)
- [Streaming](#streaming)
- [Timeouts and cancellation](#timeouts-and-cancellation)
- [Redirects](#redirects)
- [Cookies](#cookies)
- [Errors](#errors)
- [Limits and statistics](#limits-and-statistics)
- [TLS and certificates](#tls-and-certificates)
- [Profiles](#profiles)

## Client lifecycle

`createClient()` is synchronous and lazy: the native module loads and the transport
starts on the first request. One client owns its connection pool, cookie jar and
admission queues, so create one per configuration and reuse it.

```ts
import { createClient } from 'omreq';

const client = createClient({
  baseUrl: 'https://api.example.com/v1/',
  headers: { 'user-agent': 'my-app/1.0', accept: 'application/json' },
});

try {
  // ... requests ...
} finally {
  await client.close(); // cancels active and queued work, waits for native cleanup
}
```

`await using` closes the client automatically:

```ts
await using client = createClient();
```

## Making requests

```ts
const res = await client.get('users/42'); // resolved against baseUrl
const created = await client.post('users', { json: { name: 'Ada' } });
await client.put('users/42', { json: { name: 'Ada Lovelace' } });
await client.patch('users/42', { json: { active: false } });
await client.delete('users/42');
await client.head('users/42');
await client.options('users');

// Arbitrary methods
await client.request('https://example.com/resource', { method: 'PROPFIND' });
```

Query parameters replace only the named keys and keep the rest of the URL query:

```ts
await client.get('search?lang=en', {
  searchParams: [
    ['q', 'rust http'],
    ['page', '2'],
  ],
});
```

Headers can be a plain object, name/value pairs, `Headers` or `Map`. Request headers
override client headers; `null` removes an inherited header:

```ts
await client.get('report.csv', {
  headers: { accept: 'text/csv', 'user-agent': null },
});
```

## Reading responses

HTTP error statuses do not throw. Check `ok` or `status`:

```ts
const res = await client.get('users/42');
if (!res.ok) {
  await res.dispose();
  throw new Error(`HTTP ${res.status}`);
}
console.log(res.httpVersion, res.url, res.headers.get('content-type'));
const user = await res.json(); // unknown
```

Every response body has exactly one owner and must be consumed or disposed. A response
holds its operation slot until the body ends, so an unread body blocks capacity.

```ts
await using res = await client.get('large.bin'); // disposed at the end of the scope
const bytes = await res.bytes({ maxBytes: 10 * 1024 * 1024 });
```

| Method | Result |
| --- | --- |
| `res.text()` | `string` (UTF-8) |
| `res.bytes({ maxBytes })` | `Uint8Array` |
| `res.json()` | `unknown` |
| `res.json(schema)` | the schema's output type |
| `for await (const chunk of res.body)` | `Uint8Array` chunks |
| `res.body.toWebStream()` | `ReadableStream<Uint8Array>` |
| `res.dispose()` | releases an unread body |

`res.json(schema)` accepts any [Standard Schema v1](https://standardschema.dev)
validator (Zod, Valibot, ArkType, …):

```ts
import { z } from 'zod';

const User = z.object({ id: z.number(), name: z.string() });
const user = await (await client.get('users/42')).json(User); // { id: number; name: string }
```

Headers:

```ts
res.headers.get('cache-control'); // repeated fields joined with ", "
res.headers.getSetCookie(); // every Set-Cookie value
res.headers.getAll('link');
for (const [name, value] of res.headers) console.log(name, value);
```

Compressed bodies (gzip, deflate, br, zstd) are decoded automatically. Then
`res.decoded` is `true`, `res.headers` omits `content-encoding`/`content-length`, and
`res.originalHeaders` keeps them. Disable with `decompress: false`, or by sending
your own `accept-encoding`.

## Request bodies

```ts
// JSON (sets content-type: application/json)
await client.post('items', { json: { id: 1, tags: ['a', 'b'] } });

// URL-encoded form
await client.post('login', {
  form: [
    ['user', 'ada'],
    ['remember', '1'],
  ],
});

// Strings, bytes, Blob
await client.post('raw', { body: 'plain text' });
await client.post('raw', { body: new Uint8Array([1, 2, 3]) });
await client.post('upload', { body: new Blob([fileBytes], { type: 'image/png' }) });

// Multipart
const form = new FormData();
form.append('title', 'Report');
form.append('file', new Blob([pdfBytes], { type: 'application/pdf' }), 'report.pdf');
await client.post('documents', { body: form });
```

Strings, bytes, JSON, forms, Blob and FormData can be replayed when a redirect keeps
the body. Remove the automatic content type with `headers: { 'content-type': null }`.

## Streaming

Upload from an async iterable or a web `ReadableStream`. The producer is pulled on
demand, so memory stays bounded:

```ts
import { createReadStream } from 'node:fs';

await client.put('backups/db.dump', {
  body: createReadStream('./db.dump'), // AsyncIterable<Uint8Array>
  headers: { 'content-type': 'application/octet-stream' },
});

async function* lines() {
  for (let i = 0; i < 1000; i++) yield new TextEncoder().encode(`line ${i}\n`);
}
await client.post('ingest', { body: lines() });
```

Do not mutate a chunk after yielding it. A streamed (one-shot) body cannot be replayed
on a redirect that keeps the body; that fails with `ERR_BODY_NOT_REPLAYABLE`.

Download incrementally:

```ts
import { createWriteStream } from 'node:fs';
import { Writable } from 'node:stream';

await using res = await client.get('https://example.com/video.mp4');
await res.body.toWebStream().pipeTo(Writable.toWeb(createWriteStream('./video.mp4')));
```

```ts
await using res = await client.get('events.ndjson');
let total = 0;
for await (const chunk of res.body) total += chunk.byteLength;
```

## Timeouts and cancellation

Timeouts are set per client and overridden per request. Values are milliseconds.

| Timeout | Default | Bounds |
| --- | ---: | --- |
| `connectMs` (client) | 10 000 | TCP connect and TLS handshake |
| `timeouts.queueMs` | 10 000 | waiting for an admission slot |
| `timeouts.headersMs` | 30 000 | until response headers arrive |
| `timeouts.uploadIdleMs` | 30 000 | between upload chunks |
| `timeouts.bodyIdleMs` | 30 000 | between response body chunks |
| `timeouts.consumerIdleMs` | 60 000 | your code not reading an open body (`null` disables) |
| `timeouts.totalMs` | `null` | the whole operation, including the body |

```ts
const client = createClient({ connectMs: 5_000, timeouts: { headersMs: 10_000 } });
await client.get('slow', { timeouts: { totalMs: 2_000 } });
```

Any `AbortSignal` cancels a request at any stage, including while the body is read:

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(), 1_000);
await client.get('stream', { signal: controller.signal });

await client.get('report', { signal: AbortSignal.timeout(5_000) });
```

## Redirects

```ts
createClient({ redirect: 'follow', maxRedirects: 5 }); // default: follow, 10 hops
await client.get('old-url', { redirect: 'manual' }); // returns the 3xx response
await client.get('old-url', { redirect: 'error' }); // rejects on a redirect

const res = await client.get('http://example.com/');
for (const hop of res.redirects)
  console.log(hop.status, hop.fromUrl, '→', hop.toUrl, hop.methodBefore, hop.methodAfter);
```

- HTTPS → HTTP downgrades are refused unless `allowInsecureRedirects: true`.
- A cross-origin hop removes `authorization`, an explicit `cookie`, `referer` and any
  names in `sensitiveHeaders` for the rest of the chain.
- 301/302 after POST and 303 switch to GET and drop the body, as browsers do.

## Cookies

Each client has an isolated, in-memory RFC 6265bis cookie jar with public-suffix rules.
Disable it with `cookies: false`.

```ts
const client = createClient();
await client.post('https://example.com/login', { form: [['user', 'ada']] });
await client.get('https://example.com/account'); // sends the session cookie

await client.cookies.setCookie('theme=dark; Path=/; Secure', 'https://example.com');
const cookies = await client.cookies.getCookies('https://example.com/');
await client.cookies.clear();
```

An explicit `cookie` request header overrides jar values for that request.

## Errors

Network, protocol, limit and usage failures reject with an `OmreqError`:

```ts
import { isOmreqError } from 'omreq';

try {
  await client.get('https://unreachable.invalid/');
} catch (error) {
  if (isOmreqError(error)) console.log(error.code, error.phase, error.message);
  else throw error;
}
```

`phase` is one of `configuration`, `native-load`, `initialization`, `queue`,
`connect`, `proxy`, `tls`, `upload`, `headers`, `body`, `decode`, `schema`,
`shutdown`. Common codes:

| Code | Meaning |
| --- | --- |
| `ERR_TIMEOUT` | a timeout fired (`phase` says which stage) |
| `ERR_ABORTED` | the request's `AbortSignal` fired |
| `ERR_DNS`, `ERR_CONNECT`, `ERR_TLS` | name resolution, TCP or TLS failure |
| `ERR_HTTP_PROTOCOL` | malformed or reset HTTP exchange |
| `ERR_QUEUE_FULL` | `maxQueuedOperations` reached |
| `ERR_RESOURCE_LIMIT` | a byte or header limit was exceeded |
| `ERR_REDIRECT_LIMIT`, `ERR_REDIRECT_DISALLOWED` | redirect policy |
| `ERR_BODY_USED`, `ERR_BODY_DISPOSED` | the body already has an owner |
| `ERR_BODY_NOT_REPLAYABLE` | a one-shot upload cannot follow a redirect |
| `ERR_DECODE` | corrupt compressed body |
| `ERR_JSON_PARSE`, `ERR_SCHEMA_VALIDATION` | `json()` / `json(schema)` failed |
| `ERR_CLIENT_CLOSED` | the client was closed |
| `ERR_INVALID_ARGUMENT` | a bad option or input |

## Limits and statistics

All limits are enforced natively and can be tuned per client:

```ts
const client = createClient({
  maxActiveOperations: 64, // in-flight requests
  maxQueuedOperations: 256, // waiting for a slot
  maxActivePerOrigin: 32,
  maxConnections: 256, // TCP sockets
  maxConnectionsPerOrigin: 32,
  maxBufferedResponseBytes: 64 * 1024 * 1024, // one full read
  maxAggregateBufferedResponseBytes: 128 * 1024 * 1024, // all full reads together
});

await client.get('huge', { maxResponseBytes: 100 * 1024 * 1024 }); // bounds streaming too
```

Admission is fair across origins (round-robin) and FIFO within one origin.

```ts
const stats = client.getStats();
console.log(stats.activeOperations, stats.queuedOperations, stats.connections);
console.log(stats.origins); // per-origin active and waiting counts
console.log(client.getInfo()); // profile, engine build, state
```

## TLS and certificates

Certificates and hostnames are always verified. Trust an extra CA (for example a
private or test CA) with `ca`, a PEM string:

```ts
import { readFileSync } from 'node:fs';

const client = createClient({ ca: readFileSync('./internal-ca.pem', 'utf8') });
```

`trustStore: 'bundled'` (default) uses the bundled Mozilla roots; `'chromium'` uses the
Chromium root store.

## Profiles

A profile describes how the client looks on the wire: TLS versions, cipher suites,
groups and extensions, HTTP/2 settings and pseudo-header order, HTTP/1 header casing and
default headers. See [profiles.md](profiles.md).

```ts
import { createClient, defineProfile } from 'omreq';

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

const client = createClient({ profile });
```
