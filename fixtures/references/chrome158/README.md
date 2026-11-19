# Chrome 158 reference evidence

Captured on macOS arm64 from the installed Chrome 158.0.8127.37
by `pnpm profile:new` (or `pnpm profile:qualify --profile chrome158 --write-references`),
after the profile matched it byte for byte.

- `clienthello.bin`: raw TLS first flight to a loopback TCP listener.
- `tls-capture.json`: parsed Chrome and Omreq first flights with the normalization applied
  (random values, extension permutation, ECH GREASE payload size).
- `http2-capture.json`: two document navigations to a local HTTP/2 fixture; exact bytes from
  the client preface through the second HEADERS frame, plus decoded request headers.
- `resumption-capture.json`: fresh and resumed TLS 1.2/1.3 ClientHellos.
- `http3-capture.json` (profiles with HTTP/3): two document navigations over QUIC, reduced
  by `fixtures/http3-compare.mjs`: the decrypted Initial flight, control stream and the exact
  QPACK field sections.

These are scenario-scoped test vectors used by `pnpm test`, not a claim about all browser
activity.
