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

When no profile is given, the client uses the bundled `omreq/custom-default` profile:
transport defaults plus `user-agent: Omreq/<version>` and `accept: */*`.

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
    httpVersion: 'auto', // 'auto' (ALPN), '1.1' or '2'

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

listProfiles(); // [{ id: 'omreq/custom-default', revision: 1, ... }]
const base = getProfile('omreq/custom-default');
```

Only `omreq/custom-default` is bundled. It is a neutral client profile, not a browser
imitation. `profiles/chrome-157-macos-arm64.candidate.json` shows a full browser-shaped
profile; it is compared byte-for-byte against a real Chrome on the wire by the project's
qualification scripts and is not exported as a bundled profile.
