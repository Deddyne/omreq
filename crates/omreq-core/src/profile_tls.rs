use crate::error::{Error, Result};
use serde_json::{Value, json};
use std::{
    io::{self, Read, Write},
    sync::OnceLock,
};
use wreq::tls::{
    AlpnProtocol, AlpsProtocol, TlsOptions, TlsVersion,
    compress::{CertificateCompressionAlgorithm, CertificateCompressor, Codec},
    trust::CertStore,
};

fn invalid(message: &str) -> Error {
    Error::new("ERR_PROFILE_INVALID", "configuration", message)
}
/// TLS 1.3 suites are negotiated only by TLS 1.3; every other listed suite
/// (ECDHE/RSA key exchange) only by TLS 1.2.
fn is_tls13_suite(name: &str) -> bool {
    matches!(
        name,
        "TLS_AES_128_GCM_SHA256" | "TLS_AES_256_GCM_SHA384" | "TLS_CHACHA20_POLY1305_SHA256"
    )
}
/// Reject cipher lists that cannot negotiate within the version range, which
/// would otherwise pass validation and fail only at the first handshake.
fn validate_ciphers(input: &Value) -> Result<()> {
    let Some(suites) = input.get("cipherSuites").and_then(Value::as_array) else {
        return Ok(());
    };
    let min = input["minVersion"].as_str().unwrap_or("1.2");
    let names = suites.iter().filter_map(Value::as_str);
    let tls13 = names.clone().any(is_tls13_suite);
    let tls12 = names.clone().any(|name| !is_tls13_suite(name));
    if !tls12 {
        // BoringSSL configures TLS 1.3 suites only as an order: a list without
        // a TLS 1.2 suite fails with "no cipher match" when the client is built
        // and could offer nothing to a TLS 1.2 server.
        return Err(invalid(
            "/transport/tls/cipherSuites: at least one TLS 1.2 cipher suite is required",
        ));
    }
    if min == "1.3" && !tls13 {
        return Err(invalid(
            "/transport/tls/cipherSuites: only TLS 1.3 is enabled but no TLS 1.3 cipher suite is listed",
        ));
    }
    Ok(())
}
/// Parsed bundled trust roots, shared by every client in the process. Parsing a
/// bundle costs more than a millisecond, and clients are created on the
/// JavaScript thread. `None` for an unknown store name.
pub fn bundled_roots(name: &str) -> Option<Result<CertStore>> {
    static BUNDLED: OnceLock<std::result::Result<CertStore, String>> = OnceLock::new();
    static CHROMIUM: OnceLock<std::result::Result<CertStore, String>> = OnceLock::new();
    let (cell, certs) = match name {
        "bundled" => (&BUNDLED, webpki_root_certs::TLS_SERVER_ROOT_CERTS),
        "chromium" => (&CHROMIUM, chromium_roots::TLS_SERVER_ROOT_CERTS),
        _ => return None,
    };
    let store = cell.get_or_init(|| {
        CertStore::from_der_certs(certs.iter().map(|c| c.as_ref())).map_err(|e| e.to_string())
    });
    Some(store.clone().map_err(|_| {
        Error::new(
            "ERR_TLS",
            "configuration",
            "Bundled trust roots could not be loaded",
        )
    }))
}

/// Bundled roots plus extra PEM CAs, parsed for one client. `None` for an
/// unknown store name.
pub fn trust_roots(name: &str, ca: &str) -> Option<Result<CertStore>> {
    let certs = match name {
        "bundled" => webpki_root_certs::TLS_SERVER_ROOT_CERTS,
        "chromium" => chromium_roots::TLS_SERVER_ROOT_CERTS,
        _ => return None,
    };
    Some(
        CertStore::builder()
            .add_der_certs(certs.iter().map(|c| c.as_ref()))
            .add_stack_pem_certs(ca)
            .build()
            .map_err(Error::from),
    )
}

pub fn normalize(input: &Value, version: &str) -> Result<Value> {
    validate_ciphers(input)?;
    let mut value = json!({
        "minVersion": input["minVersion"].as_str().unwrap_or("1.2"),
        "maxVersion": input["maxVersion"].as_str().unwrap_or("1.3"),
        "alpn": input.get("alpn").cloned().unwrap_or_else(|| match version {
            "1.1" => json!(["http/1.1"]), "2" => json!(["h2"]), _ => json!(["h2","http/1.1"])
        }),
        "alps": input.get("alps").cloned().unwrap_or(json!([])),
        "certificateCompression": input.get("certificateCompression").cloned().unwrap_or(json!([]))
    });
    for (key, default) in [
        ("greaseEnabled", false),
        ("greaseSignatureAlgorithms", false),
        ("permuteExtensions", false),
        ("echGrease", false),
        ("ocspStapling", false),
        ("signedCertificateTimestamps", false),
        ("sessionTickets", true),
        ("preSharedKey", false),
        ("renegotiation", true),
        ("alpsUseNewCodepoint", false),
    ] {
        value[key] = input.get(key).cloned().unwrap_or(json!(default));
    }
    for key in [
        "cipherSuites",
        "signatureAlgorithms",
        "supportedGroups",
        "trustAnchorIds",
    ] {
        if let Some(input) = input.get(key) {
            value[key] = input.clone();
        }
    }
    Ok(value)
}
fn flag(v: &Value, name: &str) -> bool {
    v[name].as_bool().expect("normalized boolean")
}
fn list(v: &Value, name: &str) -> Option<Vec<String>> {
    v.get(name).and_then(Value::as_array).map(|a| {
        a.iter()
            .map(|s| s.as_str().expect("validated string").to_owned())
            .collect()
    })
}
pub fn build(tls: &Value) -> Result<TlsOptions> {
    let mut options = TlsOptions::builder()
        .min_tls_version(if tls["minVersion"] == "1.3" {
            TlsVersion::TLS_1_3
        } else {
            TlsVersion::TLS_1_2
        })
        .max_tls_version(if tls["maxVersion"] == "1.2" {
            TlsVersion::TLS_1_2
        } else {
            TlsVersion::TLS_1_3
        })
        .alpn_protocols(tls["alpn"].as_array().expect("normalized").iter().map(|s| {
            if s == "h2" {
                AlpnProtocol::HTTP2
            } else {
                AlpnProtocol::HTTP1
            }
        }))
        .alps_protocols(
            tls["alps"]
                .as_array()
                .expect("normalized")
                .iter()
                .map(|_| AlpsProtocol::HTTP2),
        )
        .grease_enabled(flag(tls, "greaseEnabled"))
        .permute_extensions(flag(tls, "permuteExtensions"))
        .enable_ech_grease(flag(tls, "echGrease"))
        .enable_ocsp_stapling(flag(tls, "ocspStapling"))
        .enable_signed_cert_timestamps(flag(tls, "signedCertificateTimestamps"))
        .session_ticket(flag(tls, "sessionTickets"))
        .pre_shared_key(flag(tls, "preSharedKey"))
        .renegotiation(flag(tls, "renegotiation"))
        .alps_use_new_codepoint(flag(tls, "alpsUseNewCodepoint"))
        .build();
    options.grease_sigalgs_enabled = Some(flag(tls, "greaseSignatureAlgorithms"));
    if let Some(values) = list(tls, "cipherSuites") {
        options.cipher_list = Some(values.join(":").into());
    }
    if let Some(values) = list(tls, "signatureAlgorithms") {
        options.sigalgs_list = Some(values.join(":").into());
    }
    if let Some(values) = list(tls, "supportedGroups") {
        options.curves_list = Some(values.join(":").into());
    }
    if let Some(values) = list(tls, "trustAnchorIds") {
        let mut encoded = Vec::new();
        for id in values {
            encoded.push((id.len() / 2) as u8);
            for pair in id.as_bytes().as_chunks::<2>().0 {
                // Schema validates even, lowercase hex strings and the one-byte length bound.
                let digit = |b: u8| {
                    if b.is_ascii_digit() {
                        b - b'0'
                    } else {
                        b - b'a' + 10
                    }
                };
                encoded.push((digit(pair[0]) << 4) | digit(pair[1]));
            }
        }
        options.trust_anchors = Some(encoded.into());
    }
    if !tls["certificateCompression"]
        .as_array()
        .expect("normalized")
        .is_empty()
    {
        options.certificate_compressors = Some(std::borrow::Cow::Owned(vec![
            &BROTLI as &dyn CertificateCompressor,
        ]));
    }
    Ok(options)
}
#[derive(Debug)]
struct BrotliCertificate;
static BROTLI: BrotliCertificate = BrotliCertificate;
impl CertificateCompressor for BrotliCertificate {
    fn algorithm(&self) -> CertificateCompressionAlgorithm {
        CertificateCompressionAlgorithm::BROTLI
    }
    fn compress(&self) -> Codec {
        Codec::Pointer(|input, output| {
            let mut encoder = brotli::CompressorWriter::new(output, 4096, 5, 22);
            encoder.write_all(input)?;
            encoder.flush()
        })
    }
    fn decompress(&self) -> Codec {
        Codec::Pointer(|input, output| {
            // Limit output independently of certificate-chain limits in the TLS engine.
            // The decoder writes incrementally into BoringSSL's length-checked writer.
            let first = *input.first().ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidData, "Empty Brotli certificate")
            })?;
            // RFC 7932 WBITS is encoded in the first seven low-order bits.
            let n = (first >> 1) & 7;
            let bits = if first & 1 == 0 {
                16
            } else if n != 0 {
                17 + n
            } else {
                let tail = (first >> 4) & 7;
                if tail == 1 {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "Large-window Brotli is unsupported",
                    ));
                }
                if tail == 0 { 17 } else { 8 + tail }
            };
            if bits > 22 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "Brotli certificate window exceeds 4 MiB",
                ));
            }
            let mut decoder = brotli::Decompressor::new(input, 4096).take(4 * 1024 * 1024 + 1);
            let written = io::copy(&mut decoder, output)?;
            if written > 4 * 1024 * 1024 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "TLS certificate decompression exceeds 4 MiB",
                ));
            }
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn certificate_brotli_is_incremental_and_rejects_invalid_windows() {
        let input = b"a controlled certificate compression roundtrip".repeat(100);
        let mut encoded = Vec::new();
        if let Codec::Pointer(encode) = BROTLI.compress() {
            encode(&input, &mut encoded).unwrap();
        }
        let mut decoded = Vec::new();
        if let Codec::Pointer(decode) = BROTLI.decompress() {
            decode(&encoded, &mut decoded).unwrap();
            assert!(decode(&[], &mut Vec::new()).is_err());
            assert!(decode(&[0x11], &mut Vec::new()).is_err());
            assert!(decode(&[0x0f], &mut Vec::new()).is_err());
            assert!(decode(&encoded[..encoded.len() / 2], &mut Vec::new()).is_err());
        }
        assert_eq!(input, decoded);
    }
    #[test]
    fn candidate_ids_are_in_the_pinned_chromium_root_set() {
        let input: Value = serde_json::from_str(include_str!(
            "../../../profiles/chrome-157-macos-arm64.candidate.json"
        ))
        .unwrap();
        let tls = build(&normalize(&input["transport"]["tls"], "auto").unwrap()).unwrap();
        let mut ids = tls.trust_anchors.unwrap().into_owned();
        while !ids.is_empty() {
            let length = usize::from(ids[0]);
            assert!(chromium_roots::trust_anchor_ids().contains(&&ids[1..=length]));
            ids.drain(..=length);
        }
    }
    #[test]
    fn cipher_suites_must_match_the_version_range() {
        let check = |tls: Value| normalize(&tls, "auto").map(|_| ());
        let only13 = json!(["TLS_AES_128_GCM_SHA256", "TLS_CHACHA20_POLY1305_SHA256"]);
        let only12 = json!(["TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256"]);
        assert!(check(json!({"cipherSuites": only13})).is_err());
        assert!(check(json!({"cipherSuites": only13, "maxVersion": "1.2"})).is_err());
        assert!(check(json!({"cipherSuites": only13, "minVersion": "1.3"})).is_err());
        assert!(check(json!({"cipherSuites": only12})).is_ok());
        assert!(check(json!({"cipherSuites": only12, "maxVersion": "1.2"})).is_ok());
        assert!(check(json!({"cipherSuites": only12, "minVersion": "1.3"})).is_err());
        let mixed = json!([
            "TLS_AES_128_GCM_SHA256",
            "TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256"
        ]);
        for (min, max) in [("1.2", "1.2"), ("1.2", "1.3"), ("1.3", "1.3")] {
            assert!(
                check(json!({"cipherSuites": mixed, "minVersion": min, "maxVersion": max})).is_ok()
            );
        }
        assert!(check(json!({})).is_ok());
    }
    #[test]
    fn bundled_roots_are_parsed_once_and_shared() {
        assert!(bundled_roots("bundled").unwrap().is_ok());
        let started = std::time::Instant::now();
        for _ in 0..100 {
            assert!(bundled_roots("bundled").unwrap().is_ok());
        }
        // A cached clone is an Arc increment; a parse takes about a millisecond.
        assert!(started.elapsed() < std::time::Duration::from_millis(50));
        assert!(bundled_roots("chromium").unwrap().is_ok());
        assert!(bundled_roots("other").is_none());
    }
}
