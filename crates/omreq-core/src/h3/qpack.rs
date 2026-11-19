//! QPACK field-section encoding without the dynamic table, the way Chromium (QUICHE) encodes
//! a request for a peer whose dynamic table it does not use: an exact static match is an
//! indexed field line, a static name match a literal with a name reference, anything else a
//! literal with a literal name. Strings are Huffman-coded by policy.

/// When string literals are Huffman-coded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Huffman {
    /// Only when the coded form is strictly shorter (Chromium).
    SmallerOnly,
    Always,
}

impl Huffman {
    pub(crate) fn parse(value: &str) -> Self {
        match value {
            "always" => Self::Always,
            _ => Self::SmallerOnly,
        }
    }
}

fn prefix_int(out: &mut Vec<u8>, bits: u8, flags: u8, mut value: u64) {
    let max = (1u64 << bits) - 1;
    if value < max {
        out.push(flags | value as u8);
        return;
    }
    out.push(flags | max as u8);
    value -= max;
    while value >= 0x80 {
        out.push((value as u8 & 0x7f) | 0x80);
        value >>= 7;
    }
    out.push(value as u8);
}

fn huffman_len(value: &[u8]) -> usize {
    let bits: usize = value.iter().map(|b| HUFFMAN[*b as usize].1 as usize).sum();
    bits.div_ceil(8)
}

fn huffman_encode(value: &[u8], out: &mut Vec<u8>) {
    let mut acc = 0u64;
    let mut used = 0u32;
    for byte in value {
        let (code, len) = HUFFMAN[*byte as usize];
        acc = (acc << len) | u64::from(code);
        used += u32::from(len);
        while used >= 8 {
            used -= 8;
            out.push((acc >> used) as u8);
        }
    }
    if used > 0 {
        // Pad with the most significant bits of EOS, all ones.
        out.push(((acc << (8 - used)) | ((1 << (8 - used)) - 1)) as u8);
    }
}

/// A string literal with a `bits`-bit length prefix after the H flag; `flags` carries the
/// representation bits above the H flag.
fn string(out: &mut Vec<u8>, bits: u8, flags: u8, value: &[u8], policy: Huffman) {
    let coded = huffman_len(value);
    let huffman = match policy {
        Huffman::SmallerOnly => coded < value.len(),
        Huffman::Always => true,
    };
    if huffman {
        prefix_int(out, bits, flags | (1 << bits), coded as u64);
        huffman_encode(value, out);
    } else {
        prefix_int(out, bits, flags, value.len() as u64);
        out.extend_from_slice(value);
    }
}

fn static_lookup(name: &[u8], value: &[u8]) -> (Option<usize>, Option<usize>) {
    let mut name_index = None;
    for (index, (n, v)) in STATIC.iter().enumerate() {
        if *n == name {
            if *v == value {
                return (Some(index), Some(index));
            }
            name_index.get_or_insert(index);
        }
    }
    (None, name_index)
}

/// Appends one field line.
fn field(out: &mut Vec<u8>, name: &[u8], value: &[u8], policy: Huffman) {
    match static_lookup(name, value) {
        // Indexed field line, static table: 0b11 + 6-bit index.
        (Some(index), _) => prefix_int(out, 6, 0xc0, index as u64),
        // Literal with name reference, static table: 0b01 N=0 T=1 + 4-bit index.
        (None, Some(index)) => {
            prefix_int(out, 4, 0x50, index as u64);
            string(out, 7, 0, value, policy);
        }
        // Literal with literal name: 0b001 N=0 + H + 3-bit name length.
        (None, None) => {
            string(out, 3, 0x20, name, policy);
            string(out, 7, 0, value, policy);
        }
    }
}

/// Encodes a field section. `fields` are lowercase names with their values, in wire order.
/// With `cookie_crumbs`, a cookie is split into one field line per cookie, as Chromium does
/// (RFC 9114 section 4.2.1).
pub(crate) fn encode<'a>(
    fields: impl IntoIterator<Item = (&'a [u8], &'a [u8])>,
    policy: Huffman,
    cookie_crumbs: bool,
) -> Vec<u8> {
    // Required Insert Count 0 and Base 0: no dynamic table references.
    let mut out = vec![0x00, 0x00];
    for (name, value) in fields {
        if cookie_crumbs && name == b"cookie" {
            for crumb in crumbs(value) {
                field(&mut out, name, crumb, policy);
            }
        } else {
            field(&mut out, name, value, policy);
        }
    }
    out
}

/// QUICHE's `ValueSplittingHeaderList`: split at each `;` and drop one space after it.
fn crumbs(value: &[u8]) -> Vec<&[u8]> {
    let mut out = Vec::new();
    let mut start = 0;
    loop {
        match value[start..].iter().position(|b| *b == b';') {
            Some(at) => {
                out.push(&value[start..start + at]);
                start += at + 1;
                if value.get(start) == Some(&b' ') {
                    start += 1;
                }
            }
            None => {
                out.push(&value[start..]);
                return out;
            }
        }
    }
}

/// HPACK Huffman codes (RFC 7541 Appendix B), shared by QPACK: (code, bit length) per byte.
#[rustfmt::skip]
const HUFFMAN: [(u32, u8); 256] = [
    (0x1ff8, 13),
    (0x7fffd8, 23),
    (0xfffffe2, 28),
    (0xfffffe3, 28),
    (0xfffffe4, 28),
    (0xfffffe5, 28),
    (0xfffffe6, 28),
    (0xfffffe7, 28),
    (0xfffffe8, 28),
    (0xffffea, 24),
    (0x3ffffffc, 30),
    (0xfffffe9, 28),
    (0xfffffea, 28),
    (0x3ffffffd, 30),
    (0xfffffeb, 28),
    (0xfffffec, 28),
    (0xfffffed, 28),
    (0xfffffee, 28),
    (0xfffffef, 28),
    (0xffffff0, 28),
    (0xffffff1, 28),
    (0xffffff2, 28),
    (0x3ffffffe, 30),
    (0xffffff3, 28),
    (0xffffff4, 28),
    (0xffffff5, 28),
    (0xffffff6, 28),
    (0xffffff7, 28),
    (0xffffff8, 28),
    (0xffffff9, 28),
    (0xffffffa, 28),
    (0xffffffb, 28),
    (0x14, 6),
    (0x3f8, 10),
    (0x3f9, 10),
    (0xffa, 12),
    (0x1ff9, 13),
    (0x15, 6),
    (0xf8, 8),
    (0x7fa, 11),
    (0x3fa, 10),
    (0x3fb, 10),
    (0xf9, 8),
    (0x7fb, 11),
    (0xfa, 8),
    (0x16, 6),
    (0x17, 6),
    (0x18, 6),
    (0x0, 5),
    (0x1, 5),
    (0x2, 5),
    (0x19, 6),
    (0x1a, 6),
    (0x1b, 6),
    (0x1c, 6),
    (0x1d, 6),
    (0x1e, 6),
    (0x1f, 6),
    (0x5c, 7),
    (0xfb, 8),
    (0x7ffc, 15),
    (0x20, 6),
    (0xffb, 12),
    (0x3fc, 10),
    (0x1ffa, 13),
    (0x21, 6),
    (0x5d, 7),
    (0x5e, 7),
    (0x5f, 7),
    (0x60, 7),
    (0x61, 7),
    (0x62, 7),
    (0x63, 7),
    (0x64, 7),
    (0x65, 7),
    (0x66, 7),
    (0x67, 7),
    (0x68, 7),
    (0x69, 7),
    (0x6a, 7),
    (0x6b, 7),
    (0x6c, 7),
    (0x6d, 7),
    (0x6e, 7),
    (0x6f, 7),
    (0x70, 7),
    (0x71, 7),
    (0x72, 7),
    (0xfc, 8),
    (0x73, 7),
    (0xfd, 8),
    (0x1ffb, 13),
    (0x7fff0, 19),
    (0x1ffc, 13),
    (0x3ffc, 14),
    (0x22, 6),
    (0x7ffd, 15),
    (0x3, 5),
    (0x23, 6),
    (0x4, 5),
    (0x24, 6),
    (0x5, 5),
    (0x25, 6),
    (0x26, 6),
    (0x27, 6),
    (0x6, 5),
    (0x74, 7),
    (0x75, 7),
    (0x28, 6),
    (0x29, 6),
    (0x2a, 6),
    (0x7, 5),
    (0x2b, 6),
    (0x76, 7),
    (0x2c, 6),
    (0x8, 5),
    (0x9, 5),
    (0x2d, 6),
    (0x77, 7),
    (0x78, 7),
    (0x79, 7),
    (0x7a, 7),
    (0x7b, 7),
    (0x7ffe, 15),
    (0x7fc, 11),
    (0x3ffd, 14),
    (0x1ffd, 13),
    (0xffffffc, 28),
    (0xfffe6, 20),
    (0x3fffd2, 22),
    (0xfffe7, 20),
    (0xfffe8, 20),
    (0x3fffd3, 22),
    (0x3fffd4, 22),
    (0x3fffd5, 22),
    (0x7fffd9, 23),
    (0x3fffd6, 22),
    (0x7fffda, 23),
    (0x7fffdb, 23),
    (0x7fffdc, 23),
    (0x7fffdd, 23),
    (0x7fffde, 23),
    (0xffffeb, 24),
    (0x7fffdf, 23),
    (0xffffec, 24),
    (0xffffed, 24),
    (0x3fffd7, 22),
    (0x7fffe0, 23),
    (0xffffee, 24),
    (0x7fffe1, 23),
    (0x7fffe2, 23),
    (0x7fffe3, 23),
    (0x7fffe4, 23),
    (0x1fffdc, 21),
    (0x3fffd8, 22),
    (0x7fffe5, 23),
    (0x3fffd9, 22),
    (0x7fffe6, 23),
    (0x7fffe7, 23),
    (0xffffef, 24),
    (0x3fffda, 22),
    (0x1fffdd, 21),
    (0xfffe9, 20),
    (0x3fffdb, 22),
    (0x3fffdc, 22),
    (0x7fffe8, 23),
    (0x7fffe9, 23),
    (0x1fffde, 21),
    (0x7fffea, 23),
    (0x3fffdd, 22),
    (0x3fffde, 22),
    (0xfffff0, 24),
    (0x1fffdf, 21),
    (0x3fffdf, 22),
    (0x7fffeb, 23),
    (0x7fffec, 23),
    (0x1fffe0, 21),
    (0x1fffe1, 21),
    (0x3fffe0, 22),
    (0x1fffe2, 21),
    (0x7fffed, 23),
    (0x3fffe1, 22),
    (0x7fffee, 23),
    (0x7fffef, 23),
    (0xfffea, 20),
    (0x3fffe2, 22),
    (0x3fffe3, 22),
    (0x3fffe4, 22),
    (0x7ffff0, 23),
    (0x3fffe5, 22),
    (0x3fffe6, 22),
    (0x7ffff1, 23),
    (0x3ffffe0, 26),
    (0x3ffffe1, 26),
    (0xfffeb, 20),
    (0x7fff1, 19),
    (0x3fffe7, 22),
    (0x7ffff2, 23),
    (0x3fffe8, 22),
    (0x1ffffec, 25),
    (0x3ffffe2, 26),
    (0x3ffffe3, 26),
    (0x3ffffe4, 26),
    (0x7ffffde, 27),
    (0x7ffffdf, 27),
    (0x3ffffe5, 26),
    (0xfffff1, 24),
    (0x1ffffed, 25),
    (0x7fff2, 19),
    (0x1fffe3, 21),
    (0x3ffffe6, 26),
    (0x7ffffe0, 27),
    (0x7ffffe1, 27),
    (0x3ffffe7, 26),
    (0x7ffffe2, 27),
    (0xfffff2, 24),
    (0x1fffe4, 21),
    (0x1fffe5, 21),
    (0x3ffffe8, 26),
    (0x3ffffe9, 26),
    (0xffffffd, 28),
    (0x7ffffe3, 27),
    (0x7ffffe4, 27),
    (0x7ffffe5, 27),
    (0xfffec, 20),
    (0xfffff3, 24),
    (0xfffed, 20),
    (0x1fffe6, 21),
    (0x3fffe9, 22),
    (0x1fffe7, 21),
    (0x1fffe8, 21),
    (0x7ffff3, 23),
    (0x3fffea, 22),
    (0x3fffeb, 22),
    (0x1ffffee, 25),
    (0x1ffffef, 25),
    (0xfffff4, 24),
    (0xfffff5, 24),
    (0x3ffffea, 26),
    (0x7ffff4, 23),
    (0x3ffffeb, 26),
    (0x7ffffe6, 27),
    (0x3ffffec, 26),
    (0x3ffffed, 26),
    (0x7ffffe7, 27),
    (0x7ffffe8, 27),
    (0x7ffffe9, 27),
    (0x7ffffea, 27),
    (0x7ffffeb, 27),
    (0xffffffe, 28),
    (0x7ffffec, 27),
    (0x7ffffed, 27),
    (0x7ffffee, 27),
    (0x7ffffef, 27),
    (0x7fffff0, 27),
    (0x3ffffee, 26),
];

/// The QPACK static table (RFC 9204 Appendix A).
#[rustfmt::skip]
const STATIC: [(&[u8], &[u8]); 99] = [
    (b":authority", b""),
    (b":path", b"/"),
    (b"age", b"0"),
    (b"content-disposition", b""),
    (b"content-length", b"0"),
    (b"cookie", b""),
    (b"date", b""),
    (b"etag", b""),
    (b"if-modified-since", b""),
    (b"if-none-match", b""),
    (b"last-modified", b""),
    (b"link", b""),
    (b"location", b""),
    (b"referer", b""),
    (b"set-cookie", b""),
    (b":method", b"CONNECT"),
    (b":method", b"DELETE"),
    (b":method", b"GET"),
    (b":method", b"HEAD"),
    (b":method", b"OPTIONS"),
    (b":method", b"POST"),
    (b":method", b"PUT"),
    (b":scheme", b"http"),
    (b":scheme", b"https"),
    (b":status", b"103"),
    (b":status", b"200"),
    (b":status", b"304"),
    (b":status", b"404"),
    (b":status", b"503"),
    (b"accept", b"*/*"),
    (b"accept", b"application/dns-message"),
    (b"accept-encoding", b"gzip, deflate, br"),
    (b"accept-ranges", b"bytes"),
    (b"access-control-allow-headers", b"cache-control"),
    (b"access-control-allow-headers", b"content-type"),
    (b"access-control-allow-origin", b"*"),
    (b"cache-control", b"max-age=0"),
    (b"cache-control", b"max-age=2592000"),
    (b"cache-control", b"max-age=604800"),
    (b"cache-control", b"no-cache"),
    (b"cache-control", b"no-store"),
    (b"cache-control", b"public, max-age=31536000"),
    (b"content-encoding", b"br"),
    (b"content-encoding", b"gzip"),
    (b"content-type", b"application/dns-message"),
    (b"content-type", b"application/javascript"),
    (b"content-type", b"application/json"),
    (b"content-type", b"application/x-www-form-urlencoded"),
    (b"content-type", b"image/gif"),
    (b"content-type", b"image/jpeg"),
    (b"content-type", b"image/png"),
    (b"content-type", b"text/css"),
    (b"content-type", b"text/html; charset=utf-8"),
    (b"content-type", b"text/plain"),
    (b"content-type", b"text/plain;charset=utf-8"),
    (b"range", b"bytes=0-"),
    (b"strict-transport-security", b"max-age=31536000"),
    (b"strict-transport-security", b"max-age=31536000; includesubdomains"),
    (b"strict-transport-security", b"max-age=31536000; includesubdomains; preload"),
    (b"vary", b"accept-encoding"),
    (b"vary", b"origin"),
    (b"x-content-type-options", b"nosniff"),
    (b"x-xss-protection", b"1; mode=block"),
    (b":status", b"100"),
    (b":status", b"204"),
    (b":status", b"206"),
    (b":status", b"302"),
    (b":status", b"400"),
    (b":status", b"403"),
    (b":status", b"421"),
    (b":status", b"425"),
    (b":status", b"500"),
    (b"accept-language", b""),
    (b"access-control-allow-credentials", b"FALSE"),
    (b"access-control-allow-credentials", b"TRUE"),
    (b"access-control-allow-headers", b"*"),
    (b"access-control-allow-methods", b"get"),
    (b"access-control-allow-methods", b"get, post, options"),
    (b"access-control-allow-methods", b"options"),
    (b"access-control-expose-headers", b"content-length"),
    (b"access-control-request-headers", b"content-type"),
    (b"access-control-request-method", b"get"),
    (b"access-control-request-method", b"post"),
    (b"alt-svc", b"clear"),
    (b"authorization", b""),
    (b"content-security-policy", b"script-src 'none'; object-src 'none'; base-uri 'none'"),
    (b"early-data", b"1"),
    (b"expect-ct", b""),
    (b"forwarded", b""),
    (b"if-range", b""),
    (b"origin", b""),
    (b"purpose", b"prefetch"),
    (b"server", b""),
    (b"timing-allow-origin", b"*"),
    (b"upgrade-insecure-requests", b"1"),
    (b"user-agent", b""),
    (b"x-forwarded-for", b""),
    (b"x-frame-options", b"deny"),
    (b"x-frame-options", b"sameorigin"),
];

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    #[test]
    fn encodes_like_chromium() {
        // A Chrome 158 subresource request captured from the wire (fixtures/http3-wire.mjs).
        let block = encode(
            [
(&b":method"[..], &b"GET"[..]),
                (&b":authority"[..], &b"localhost:63794"[..]),
                (&b":scheme"[..], &b"https"[..]),
                (&b":path"[..], &b"/favicon.ico"[..]),
                (&b"sec-ch-ua-platform"[..], &b"\"macOS\""[..]),
                (&b"user-agent"[..], &b"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/158.0.0.0 Safari/537.36"[..]),
                (&b"sec-ch-ua"[..], &b"\"Chromium\";v=\"158\", \"Not.A/Brand\";v=\"24\", \"Google Chrome\";v=\"158\""[..]),
                (&b"sec-ch-ua-mobile"[..], &b"?0"[..]),
                (&b"accept"[..], &b"image/jxl,image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"[..]),
                (&b"sec-fetch-site"[..], &b"same-origin"[..]),
                (&b"sec-fetch-mode"[..], &b"no-cors"[..]),
                (&b"sec-fetch-dest"[..], &b"image"[..]),
                (&b"referer"[..], &b"https://localhost:63794/probe"[..]),
                (&b"accept-encoding"[..], &b"gzip, deflate, br, zstd"[..]),
                (&b"accept-language"[..], &b"en-US,en;q=0.9"[..]),
                (&b"priority"[..], &b"u=1, i"[..]),
            ],
            Huffman::SmallerOnly,
            true,
        );
        assert_eq!(
            hex(&block),
            concat!(
                "0000d1508ba0e41d139d09b8e32ebed7d751896251f7310f52e621ff2f064148",
                "b1275ad1ad5d034ca7b29f07226d61634f53225f50ded07f66a281b0dae053fa",
                "d0321aa49d13fda992a49685340c8a6adca7e28104416e277fb521aeba0bc8b1",
                "e632586d975765c53facd8f7e8cff4a506ea5531149d4ffda98ca39282a117a7",
                "b0f49580b6f2e05c0b814dc394761986d975765c2f004148b1275ad1ffb8fe6f",
                "4f61e935b4ff3f7de0fe42dbdfcfd29fce93a57858bb60ea93f9fbef07f226bf",
                "9fa53f9c473cd4154bd3d87a4bfcfdf783f90b6f7f3f2f044148b1275ad1ad49",
                "e33505023f305f0eb9352398ac74f347d1a91cc5607dcd2fd1a91cc563c163af",
                "e8d48e62b03aea9be8d48e62b08ef37fbf34d1f46a473158f9faf963e7efb400",
                "5def2f034148b4a549275906497f8840e92ac7b0d31aaf2f034148b4a549275a",
                "93c85f85a8eb10f6232f034148b4a549275a42a13f84352398bf5d959d29ad17",
                "18628390744e7426e38cbafb4c5761e32f5f10929bd9abfa5242cb40d25fa523",
                "b3e94f684c9f5f398b2d4b70ddf45abefb4005df2eaec31ec327d785b600fd28",
                "6f",
            )
        );
    }

    #[test]
    fn cookie_crumbs_follow_quiche() {
        assert_eq!(crumbs(b"a=1; b=2;c=3"), [&b"a=1"[..], b"b=2", b"c=3"]);
        assert_eq!(crumbs(b"a=1;"), [&b"a=1"[..], b""]);
        assert_eq!(crumbs(b"a=1;  b"), [&b"a=1"[..], b" b"]);
    }

    #[test]
    fn huffman_is_used_only_when_shorter() {
        let mut out = Vec::new();
        string(&mut out, 7, 0, b"?0", Huffman::SmallerOnly);
        assert_eq!(out, b"\x02?0");
        out.clear();
        string(&mut out, 7, 0, b"none", Huffman::SmallerOnly);
        assert_eq!(out[0] & 0x80, 0x80);
    }
}
