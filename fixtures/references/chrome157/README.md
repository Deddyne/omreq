# Chrome 157 reference evidence

Captured on macOS arm64 from an independently launched installed Chrome
157.0.8103.79. `clienthello.bin` is the raw TLS first flight to a controlled
loopback TCP listener. `tls-capture.json` records the raw parsed fields and
normalization rules/results from the paired candidate probe.

`http2-capture.json` uses two sequential headed Chrome navigations in a separate
temporary profile, explicit en-US language and a local TLS fixture. Only the
fixture certificate's SPKI is exempted in the reference browser; the Omreq
client validates the fixture through its explicitly added CA. Chrome's normal
User-Agent is observed directly, without a headless User-Agent override.

The HTTP2 comparison includes exact raw bytes from the client preface through
the second HEADERS frame, plus decoded field order. It intentionally separates
connection shutdown policy from this prefix. These are scenario-scoped test
vectors, not a claim about all browser activity, proxies, cache, navigation or
certificate-verifier behavior. Random TLS fields, extension permutation and
bounded random ECH GREASE payload sizes are normalized explicitly in the parser.

`resumption-capture.json` contains independently observed fresh and server-
accepted resumed TLS 1.2/1.3 ClientHellos. Reproduce with
`pnpm test:profile:resumption`; updating vectors explicitly requires
`node scripts/profile-resumption-reference.mjs --write-reference` after a match.
The peer selects ECDHE-RSA-AES128-GCM-SHA256 / TLS_AES_128_GCM_SHA256 and HTTP1,
closing every response to force a new TCP connection. Node and Bun regression
clients both use a Node/OpenSSL fixture process: Bun's TLS server issues opaque
tickets of different lengths. Live paired Chrome/Omreq comparisons retain those
lengths, PSK binder sizes/counts and PSK-last position; only opaque ticket/age/
binder values are normalized. Server resumption flags prove accepted tickets.
Browser preconnections are observed separately from requested navigations.
