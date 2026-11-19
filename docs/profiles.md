# Profiles

A profile describes how an omreq client presents itself on the wire: the TLS
ClientHello, HTTP/2 connection settings and header framing, HTTP/1 header layout and
the default request headers. Profiles are plain data, written in TypeScript or JSON,
validated against [`profiles/profile-v1.schema.json`](../profiles/profile-v1.schema.json)
and applied by the native engine without rebuilding it.

```ts
import { createClient, defineProfile } from 'omreq';

const client = createClient({ profile: defineProfile({ /* ... */ }) });
```

Most code only picks a bundled profile by name:

| Name | Profile |
| --- | --- |
| `chrome` | the newest bundled Chrome — the default |
| `chrome158` | Chrome 158.0.8127.37 on macOS ([`profiles/chrome-158-macos.json`](../profiles/chrome-158-macos.json)) |
| `chrome157` | Chrome 157.0.8103.79 on macOS ([`profiles/chrome-157-macos.json`](../profiles/chrome-157-macos.json)) |
| `neutral` | transport defaults, `user-agent: Omreq/<version>`, `accept: */*` |

```ts
createClient(); // same as { profile: 'chrome' }
createClient({ profile: 'neutral' });
```

The rest of this page is about writing your own profile.

## Why profiles

Servers and CDNs often look at more than the URL and headers. TLS extension order,
cipher suites, key-share groups, HTTP/2 SETTINGS and pseudo-header order form a
fingerprint of the client. A profile makes every one of these choices explicit and
reproducible, so two clients built from the same profile are byte-for-byte identical
on the wire, and you can describe a new client shape without waiting for a library
release.

A profile only selects behavior the engine already supports. If a field is valid but
the engine cannot apply it, the client fails with `ERR_PROFILE_UNSUPPORTED` before
any connection is made; nothing is silently ignored.

## Structure

```ts
import { defineProfile } from 'omreq';

export const profile = defineProfile({
  schemaVersion: 1,
  id: 'acme/api-client', // any "namespace/name"
  revision: 3, // bump when the profile changes
  target: { family: 'custom', platform: 'generic' },
  defaults: 'omreq-transport-v1', // base every unset field falls back to
  requires: [], // engine capabilities the profile needs

  transport: {
    httpVersion: 'auto', // 'auto' (ALPN, plus HTTP/3 when offered), '1.1', '2' or '3'

    tls: {
      minVersion: '1.2',
      maxVersion: '1.3',
      alpn: ['h2', 'http/1.1'],
      cipherSuites: [
        'TLS_AES_128_GCM_SHA256',
        'TLS_AES_256_GCM_SHA384',
        'TLS_CHACHA20_POLY1305_SHA256',
        'TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256',
        'TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256',
      ],
      supportedGroups: ['X25519MLKEM768', 'X25519', 'P-256', 'P-384'],
      signatureAlgorithms: [
        'ecdsa_secp256r1_sha256',
        'rsa_pss_rsae_sha256',
        'rsa_pkcs1_sha256',
      ],
      greaseEnabled: true,
      permuteExtensions: true,
      sessionTickets: true,
      certificateCompression: ['brotli'],
    },

    http2: {
      initialConnectionWindowSize: 15_728_640,
      settings: [
        { name: 'headerTableSize', value: 65_536 },
        { name: 'enablePush', value: 0 },
        { name: 'initialWindowSize', value: 6_291_456 },
        { name: 'maxHeaderListSize', value: 262_144 },
      ],
      pseudoHeaderOrder: [':method', ':authority', ':scheme', ':path'],
      headersPriority: { dependency: 0, weight: 256, exclusive: true },
      hpackHuffman: 'smaller-only',
    },

    http1: {
      headerOrder: ['Host', 'Connection', 'User-Agent', 'Accept', 'Accept-Encoding'],
      keepAliveHeader: true,
    },
  },

  headers: [
    ['user-agent', 'AcmeClient/3.0'],
    ['accept', 'application/json'],
    ['accept-language', 'en-US,en;q=0.9'],
  ],
});
```

### TLS (`transport.tls`)

| Field | Meaning |
| --- | --- |
| `minVersion`, `maxVersion` | `'1.2'` or `'1.3'` |
| `alpn` | protocols offered, in order |
| `cipherSuites` | offered suites, in order |
| `supportedGroups` | key-exchange groups, including post-quantum `X25519MLKEM768` |
| `signatureAlgorithms` | offered signature schemes, in order |
| `greaseEnabled`, `greaseSignatureAlgorithms` | GREASE values (RFC 8701) |
| `permuteExtensions` | randomize extension order per connection |
| `echGrease` | send a GREASE Encrypted Client Hello |
| `ocspStapling`, `signedCertificateTimestamps` | request OCSP and SCTs |
| `sessionTickets`, `preSharedKey` | session resumption |
| `alps`, `alpsUseNewCodepoint` | ALPS for `h2` and its codepoint |
| `certificateCompression` | `['brotli']` or `[]` |
| `renegotiation` | allow TLS 1.2 renegotiation |

### HTTP/2 (`transport.http2`)

| Field | Meaning |
| --- | --- |
| `settings` | SETTINGS frame entries, sent in this exact order |
| `initialWindowSize`, `initialConnectionWindowSize`, `maxFrameSize` | flow control |
| `pseudoHeaderOrder` | order of `:method`, `:authority`, `:scheme`, `:path` |
| `headersPriority` | priority carried on HEADERS frames |
| `hpackHuffman` | `'always'` or `'smaller-only'` Huffman coding |

### HTTP/3 (`transport.http3`)

Optional. Without it a profile never uses HTTP/3; with it and `httpVersion: 'auto'`, origins
that advertise `h3` are reached over QUIC (see [usage.md#http3](usage.md#http3)), and
`httpVersion: '3'` uses it for every HTTPS request.

| Field | Meaning |
| --- | --- |
| `tls` | the ClientHello inside the QUIC Initial packets: `cipherSuites`, `supportedGroups`, `signatureAlgorithms`, `greaseEnabled`, `permuteExtensions`, `echGrease`, `ocspStapling`, `signedCertificateTimestamps`, `alps` (`['h3']`), `alpsUseNewCodepoint`, `certificateCompression`, `trustAnchorIds`; ALPN is always `h3` |
| `quic.transportParameters` | QUIC transport parameters in wire order: `{ name, value }` for known ones, `googleConnectionOptions` (hex), `versionInformation`, `grease`, `initialSourceConnectionId`, or `{ name: 'custom', id, value }` |
| `quic.shuffleTransportParameters` | send them in a random order per connection, as Chrome does |
| `quic.initialDestinationConnectionIdLength`, `quic.connectionIdLength` | connection ID lengths (Chrome: 8 and 0) |
| `quic.initialPacketSize` | size every Initial datagram is padded to (Chrome: 1250) |
| `quic.chaosProtection` | Chrome's randomized layout of the ClientHello across Initial packets |
| `quic.sharedPacketNumbers` | one packet number sequence across all packet number spaces, starting at 1 |
| `settings` | HTTP/3 SETTINGS in wire order: `qpackMaxTableCapacity`, `maxFieldSectionSize`, `qpackBlockedStreams`, `enableConnectProtocol`, `h3Datagram` |
| `greaseSetting`, `greaseFrame` | a reserved SETTINGS entry and a reserved frame on the control stream |
| `pseudoHeaderOrder` | order of `:method`, `:authority`, `:scheme`, `:path` |
| `priorityUpdate` | send a PRIORITY_UPDATE frame for requests with a non-default `priority` header |
| `qpackHuffman` | `'always'` or `'smaller-only'` Huffman coding |
| `cookieCrumbs` | split `cookie` into one field per pair, as Chrome does |

### HTTP/1 (`transport.http1`)

| Field | Meaning |
| --- | --- |
| `headerOrder` | header order and spelling (case is preserved) |
| `keepAliveHeader` | send `Connection: keep-alive` |
| `omitDefaultPriority` | drop the profile's `priority` header on HTTP/1 unless a client or request sets it |

### Headers

`headers` are name/value pairs applied to every request before client and request
headers. Transport-owned headers (`host`, `connection`, `content-length`,
`transfer-encoding`, …) and credentials (`cookie`, `authorization`) are rejected in a
profile.

## JSON profiles

The same object can live in a `.json` file:

```ts
import { readFileSync } from 'node:fs';
import { createClient, parseProfile, serializeProfile } from 'omreq';

const profile = parseProfile(readFileSync('./acme.profile.json', 'utf8'));
const client = createClient({ profile });

// Canonical JSON with sorted keys, suitable for diffs and hashing
const text = serializeProfile(profile);
```

## Checking a profile

`checkProfile` validates a profile against the installed engine without any network
access and returns the normalized configuration the engine will use:

```ts
import { checkProfile } from 'omreq';

const report = await checkProfile(profile);
if (!report.compatible) {
  for (const issue of report.issues) console.error(issue.path, issue.message);
}
console.log(report.profileDigest, report.engineBuildId);
```

`defineProfile` and `parseProfile` throw `ERR_PROFILE_INVALID` for schema errors.
`createClient` defers native validation to the first request, which then fails with
`ERR_PROFILE_UNSUPPORTED` if the engine rejects the profile.

## Bundled profiles

```ts
import { getProfile, listProfiles } from 'omreq';

listProfiles();
// [{ name: 'chrome157', aliases: […], default: false, … },
//  { name: 'chrome158', aliases: ['chrome', …], default: true, … },
//  { name: 'neutral', aliases: ['omreq/custom-default'], default: false, … }]

// Start from a bundled profile and change one thing
const base = getProfile('chrome');
const custom = defineProfile({
  ...structuredClone(base),
  id: 'acme/chrome-de',
  headers: base.headers.map(([name, value]) =>
    name === 'accept-language' ? [name, 'de-DE,de;q=0.9'] : [name, value],
  ),
});
```

Bundled Chrome profiles are compared byte-for-byte with a real Chrome of the same version:
the TLS ClientHello (GREASE values and permuted extensions normalized), the HTTP/1 request,
the HTTP/2 connection preface, SETTINGS, WINDOW_UPDATE and first HEADERS frame, and for
HTTP/3 the decrypted QUIC Initial packets, the control stream and the QPACK field sections. A
`checkProfile` report and `client.getInfo()` say `verification: 'bundled-verified'` for an
unmodified bundled profile and `'custom-unverified'` otherwise.

## Adding a new Chrome version

When Chrome updates, install it on a Mac and run:

```bash
pnpm profile:new
```

The script drives the installed Chrome against local fixtures (no network), takes
its request headers, HTTP/2 SETTINGS, window, priority and header order, and writes
`profiles/chrome-<major>-macos.json` starting from the previous version. It then
compares the new profile with that Chrome byte for byte: 16 TLS first flights,
HTTP/2, HTTP/3 and HTTP/1 on Node and Bun, and TLS 1.2/1.3 resumption. On a match the
captures are saved to `fixtures/references/chrome<major>/` and become regression
tests, `pnpm generate` registers the name, and `chrome` points to the new version.

If TLS changed, the script stops and names the report to look at. Update
`transport.tls` by hand, then rerun only the check:

```bash
pnpm profile:qualify --profile chrome159 --write-references
```
