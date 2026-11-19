//! The `transport.http3` block of a profile: the TLS ClientHello carried in QUIC Initial
//! packets, the QUIC transport parameters and packet layout, and the HTTP/3 SETTINGS and
//! request encoding.

use std::{sync::Arc, time::Duration};

use btls::{
    ssl::{
        CertificateCompressionAlgorithm, CertificateCompressor, SslContextBuilder, SslMethod,
        SslVerifyMode, Tls13Cipher,
    },
    x509::store::X509Store,
};
use quic::crypto::btls::QuicClientConfig;
use quic_proto::{
    TransportParameterConfig, TransportParameterId, TransportParameterKind, VersionEntry,
    VersionInformation,
};
use serde_json::{Value, json};

use super::qpack::Huffman;
use crate::error::{Error, Result};

fn invalid(message: &str) -> Error {
    Error::new("ERR_PROFILE_INVALID", "configuration", message)
}

/// Transport parameters in the order of Chromium's `TransportParameters::SerializeTransportParameters`.
const DEFAULT_PARAMETERS: &[&str] = &[
    "maxIdleTimeout",
    "maxUdpPayloadSize",
    "initialMaxData",
    "initialMaxStreamDataBidiLocal",
    "initialMaxStreamDataBidiRemote",
    "initialMaxStreamDataUni",
    "initialMaxStreamsBidi",
    "initialMaxStreamsUni",
    "initialSourceConnectionId",
    "maxDatagramFrameSize",
    "grease",
];

/// Applies defaults to `transport.http3`. A profile without the block has no HTTP/3.
pub(crate) fn normalize(input: &Value) -> Result<Value> {
    if input.is_null() {
        return Ok(Value::Null);
    }
    let tls = &input["tls"];
    let mut out_tls = json!({
        "alps": tls.get("alps").cloned().unwrap_or(json!([])),
        "certificateCompression": tls.get("certificateCompression").cloned().unwrap_or(json!([])),
    });
    for (key, default) in [
        ("greaseEnabled", false),
        ("permuteExtensions", false),
        ("echGrease", false),
        ("ocspStapling", false),
        ("signedCertificateTimestamps", false),
        ("alpsUseNewCodepoint", false),
    ] {
        out_tls[key] = tls.get(key).cloned().unwrap_or(json!(default));
    }
    for key in [
        "cipherSuites",
        "signatureAlgorithms",
        "supportedGroups",
        "trustAnchorIds",
    ] {
        if let Some(value) = tls.get(key) {
            out_tls[key] = value.clone();
        }
    }

    let quic = &input["quic"];
    let parameters = quic.get("transportParameters").cloned().unwrap_or_else(|| {
        let defaults = json!({
            "maxIdleTimeout": 30000, "maxUdpPayloadSize": 1472, "initialMaxData": 15728640,
            "initialMaxStreamDataBidiLocal": 6291456, "initialMaxStreamDataBidiRemote": 6291456,
            "initialMaxStreamDataUni": 6291456, "initialMaxStreamsBidi": 100,
            "initialMaxStreamsUni": 100,
        });
        Value::Array(
            DEFAULT_PARAMETERS
                .iter()
                .filter(|name| !matches!(**name, "maxDatagramFrameSize" | "grease"))
                .map(|name| match defaults.get(*name) {
                    Some(value) => json!({"name": name, "value": value}),
                    None => json!({"name": name}),
                })
                .collect(),
        )
    });
    let mut seen = std::collections::HashSet::new();
    let mut window = None;
    for parameter in parameters.as_array().expect("schema checked") {
        let name = parameter["name"].as_str().expect("schema checked");
        if name != "custom" && !seen.insert(name.to_owned()) {
            return Err(invalid(
                "/transport/http3/quic/transportParameters: duplicate parameter",
            ));
        }
        let needs_value = !matches!(
            name,
            "initialSourceConnectionId" | "versionInformation" | "grease"
        );
        if needs_value != parameter.get("value").is_some() {
            return Err(invalid(&format!(
                "/transport/http3/quic/transportParameters: {name} {} a value",
                if needs_value { "needs" } else { "takes no" }
            )));
        }
        if name.starts_with("initialMaxStreamData") {
            // One stream receive window serves every kind of stream.
            let value = parameter["value"].as_u64();
            if window.is_some_and(|w| Some(w) != value) {
                return Err(invalid(
                    "/transport/http3/quic/transportParameters: stream data limits must be equal",
                ));
            }
            window = value;
        }
    }
    if !seen.contains("initialSourceConnectionId") {
        return Err(invalid(
            "/transport/http3/quic/transportParameters: initialSourceConnectionId is required",
        ));
    }
    let settings = input.get("settings").cloned().unwrap_or_else(|| {
        json!([
            {"name": "qpackMaxTableCapacity", "value": 0},
            {"name": "maxFieldSectionSize", "value": 262144},
        ])
    });
    let mut seen = std::collections::HashSet::new();
    for setting in settings.as_array().expect("schema checked") {
        if !seen.insert(setting["name"].as_str().expect("schema checked")) {
            return Err(invalid("/transport/http3/settings: duplicate setting"));
        }
    }
    Ok(json!({
        "tls": out_tls,
        "quic": {
            "transportParameters": parameters,
            "shuffleTransportParameters": quic.get("shuffleTransportParameters").cloned().unwrap_or(json!(false)),
            "initialDestinationConnectionIdLength": quic.get("initialDestinationConnectionIdLength").cloned().unwrap_or(json!(8)),
            "connectionIdLength": quic.get("connectionIdLength").cloned().unwrap_or(json!(0)),
            "initialPacketSize": quic.get("initialPacketSize").cloned().unwrap_or(json!(1200)),
            "chaosProtection": quic.get("chaosProtection").cloned().unwrap_or(json!(false)),
            "sharedPacketNumbers": quic.get("sharedPacketNumbers").cloned().unwrap_or(json!(false)),
        },
        "settings": settings,
        "greaseSetting": input.get("greaseSetting").cloned().unwrap_or(json!(false)),
        "greaseFrame": input.get("greaseFrame").cloned().unwrap_or(json!(false)),
        "pseudoHeaderOrder": input.get("pseudoHeaderOrder").cloned().unwrap_or(json!([":method", ":scheme", ":authority", ":path"])),
        "priorityUpdate": input.get("priorityUpdate").cloned().unwrap_or(json!(false)),
        "qpackHuffman": input.get("qpackHuffman").cloned().unwrap_or(json!("smaller-only")),
        "cookieCrumbs": input.get("cookieCrumbs").cloned().unwrap_or(json!(false)),
    }))
}

/// SETTINGS identifiers by profile name (RFC 9114, RFC 9204, RFC 9297, RFC 9220).
fn setting_id(name: &str) -> u64 {
    match name {
        "qpackMaxTableCapacity" => 0x01,
        "maxFieldSectionSize" => 0x06,
        "qpackBlockedStreams" => 0x07,
        "enableConnectProtocol" => 0x08,
        "h3Datagram" => 0x33,
        _ => unreachable!("schema checked"),
    }
}

/// Pseudo-header fields of a request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Pseudo {
    Method,
    Scheme,
    Authority,
    Path,
}

/// A parsed `transport.http3` block, shared by every connection of a client.
pub(crate) struct Http3Profile {
    tls: Value,
    pub(crate) transport: Arc<quic::TransportConfig>,
    pub(crate) max_udp_payload_size: u16,
    pub(crate) initial_dcid_length: usize,
    pub(crate) cid_length: usize,
    pub(crate) settings: Vec<(u64, u64)>,
    pub(crate) grease_setting: bool,
    pub(crate) grease_frame: bool,
    pub(crate) pseudo_order: Vec<Pseudo>,
    pub(crate) priority_update: bool,
    pub(crate) huffman: Huffman,
    pub(crate) cookie_crumbs: bool,
}

impl Http3Profile {
    /// Builds the QUIC and HTTP/3 configuration from a normalized block.
    pub(crate) fn new(http3: &Value) -> Self {
        let quic = &http3["quic"];
        let mut transport = quic::TransportConfig::default();
        let mut entries = Vec::new();
        let mut max_udp_payload_size = 1472;
        for parameter in quic["transportParameters"].as_array().expect("normalized") {
            let value = parameter["value"].as_u64().unwrap_or(0);
            let known = |id| TransportParameterKind::Known(id);
            let entry = match parameter["name"].as_str().expect("normalized") {
                "maxIdleTimeout" => {
                    transport.max_idle_timeout(Some(
                        quic::IdleTimeout::try_from(Duration::from_millis(value))
                            .expect("schema bound"),
                    ));
                    known(TransportParameterId::MaxIdleTimeout)
                }
                "maxUdpPayloadSize" => {
                    max_udp_payload_size = value as u16;
                    known(TransportParameterId::MaxUdpPayloadSize)
                }
                "initialMaxData" => {
                    transport.receive_window(quic::VarInt::from_u64(value).expect("schema bound"));
                    known(TransportParameterId::InitialMaxData)
                }
                name @ ("initialMaxStreamDataBidiLocal"
                | "initialMaxStreamDataBidiRemote"
                | "initialMaxStreamDataUni") => {
                    transport.stream_receive_window(
                        quic::VarInt::from_u64(value).expect("schema bound"),
                    );
                    known(match name {
                        "initialMaxStreamDataBidiLocal" => {
                            TransportParameterId::InitialMaxStreamDataBidiLocal
                        }
                        "initialMaxStreamDataBidiRemote" => {
                            TransportParameterId::InitialMaxStreamDataBidiRemote
                        }
                        _ => TransportParameterId::InitialMaxStreamDataUni,
                    })
                }
                "initialMaxStreamsBidi" => {
                    transport.max_concurrent_bidi_streams(
                        quic::VarInt::from_u64(value).expect("schema bound"),
                    );
                    known(TransportParameterId::InitialMaxStreamsBidi)
                }
                "initialMaxStreamsUni" => {
                    transport.max_concurrent_uni_streams(
                        quic::VarInt::from_u64(value).expect("schema bound"),
                    );
                    known(TransportParameterId::InitialMaxStreamsUni)
                }
                "maxDatagramFrameSize" => {
                    transport.datagram_receive_buffer_size(Some(value as usize));
                    known(TransportParameterId::MaxDatagramFrameSize)
                }
                "initialSourceConnectionId" => {
                    known(TransportParameterId::InitialSourceConnectionId)
                }
                "versionInformation" => {
                    TransportParameterKind::VersionInformation(VersionInformation {
                        chosen_version: 1,
                        available: vec![VersionEntry::Real(1), VersionEntry::Grease],
                    })
                }
                "grease" => TransportParameterKind::Grease,
                "googleConnectionOptions" => TransportParameterKind::Custom {
                    id: 0x3128,
                    value: hex(parameter["value"].as_str().expect("schema checked")),
                },
                "custom" => TransportParameterKind::Custom {
                    id: parameter["id"].as_u64().expect("schema checked"),
                    value: hex(parameter["value"].as_str().expect("schema checked")),
                },
                _ => unreachable!("schema checked"),
            };
            entries.push(entry);
        }
        if !entries.iter().any(|e| {
            matches!(
                e,
                TransportParameterKind::Known(TransportParameterId::MaxDatagramFrameSize)
            )
        }) {
            transport.datagram_receive_buffer_size(None);
        }
        transport.transport_parameter_config(TransportParameterConfig::new(
            entries,
            quic["shuffleTransportParameters"] == true,
        ));
        // Every client Initial datagram is padded to the initial packet size; quinn pads them
        // to the minimum MTU.
        let size = quic["initialPacketSize"].as_u64().expect("normalized") as u16;
        transport.initial_mtu(size);
        transport.min_mtu(size);
        transport.initial_chaos_protection(quic["chaosProtection"] == true);
        transport.shared_packet_numbers(quic["sharedPacketNumbers"] == true);
        // QUICHE's `kInitialRttMs`; it sets the first retransmission and pacing timers.
        transport.initial_rtt(std::time::Duration::from_millis(100));

        let settings = http3["settings"]
            .as_array()
            .expect("normalized")
            .iter()
            .map(|s| {
                (
                    setting_id(s["name"].as_str().expect("normalized")),
                    s["value"].as_u64().expect("normalized"),
                )
            })
            .collect();
        let pseudo_order = http3["pseudoHeaderOrder"]
            .as_array()
            .expect("normalized")
            .iter()
            .map(|p| match p.as_str().expect("normalized") {
                ":method" => Pseudo::Method,
                ":scheme" => Pseudo::Scheme,
                ":authority" => Pseudo::Authority,
                _ => Pseudo::Path,
            })
            .collect();
        Self {
            tls: http3["tls"].clone(),
            transport: Arc::new(transport),
            max_udp_payload_size,
            initial_dcid_length: quic["initialDestinationConnectionIdLength"]
                .as_u64()
                .expect("normalized") as usize,
            cid_length: quic["connectionIdLength"].as_u64().expect("normalized") as usize,
            settings,
            grease_setting: http3["greaseSetting"] == true,
            grease_frame: http3["greaseFrame"] == true,
            pseudo_order,
            priority_update: http3["priorityUpdate"] == true,
            huffman: Huffman::parse(http3["qpackHuffman"].as_str().expect("normalized")),
            cookie_crumbs: http3["cookieCrumbs"] == true,
        }
    }

    /// The value this client advertises for a setting, if it sends it.
    pub(crate) fn setting(&self, id: u64) -> Option<u64> {
        self.settings
            .iter()
            .find(|(i, _)| *i == id)
            .map(|(_, v)| *v)
    }

    /// The TLS configuration of QUIC handshakes: TLS 1.3 only, ALPN `h3`.
    pub(crate) fn tls(&self, roots: &X509Store) -> Result<QuicClientConfig> {
        let tls = &self.tls;
        let failed = |_| {
            Error::new(
                "ERR_PROFILE_UNSUPPORTED",
                "initialization",
                "The native TLS backend rejected the HTTP/3 profile configuration",
            )
        };
        let list = |key: &str| {
            tls.get(key).and_then(Value::as_array).map(|a| {
                a.iter()
                    .map(|s| s.as_str().expect("schema checked").to_owned())
                    .collect::<Vec<_>>()
            })
        };
        let mut builder = SslContextBuilder::new(SslMethod::tls()).map_err(failed)?;
        builder.set_cert_store_ref(roots);
        builder.set_verify(SslVerifyMode::PEER);
        builder.set_alpn_protos(b"\x02h3").map_err(failed)?;
        if let Some(suites) = list("cipherSuites") {
            let suites = suites
                .iter()
                .map(|name| match name.as_str() {
                    "TLS_AES_128_GCM_SHA256" => Tls13Cipher::AES_128_GCM_SHA256,
                    "TLS_AES_256_GCM_SHA384" => Tls13Cipher::AES_256_GCM_SHA384,
                    _ => Tls13Cipher::CHACHA20_POLY1305_SHA256,
                })
                .collect::<Vec<_>>();
            builder.set_tls13_ciphers(&suites).map_err(failed)?;
        }
        if let Some(values) = list("signatureAlgorithms") {
            builder
                .set_sigalgs_list(&values.join(":"))
                .map_err(failed)?;
        }
        if let Some(values) = list("supportedGroups") {
            builder.set_curves_list(&values.join(":")).map_err(failed)?;
        }
        builder.set_grease_enabled(tls["greaseEnabled"] == true);
        builder.set_permute_extensions(tls["permuteExtensions"] == true);
        if tls["ocspStapling"] == true {
            builder.enable_ocsp_stapling();
        }
        if tls["signedCertificateTimestamps"] == true {
            builder.enable_signed_cert_timestamps();
        }
        if let Some(values) = list("trustAnchorIds") {
            builder
                .set_requested_trust_anchors(&crate::profile_tls::encode_trust_anchors(&values))
                .map_err(failed)?;
        }
        if tls["certificateCompression"]
            .as_array()
            .is_some_and(|a| !a.is_empty())
        {
            builder
                .add_certificate_compression_algorithm(Brotli)
                .map_err(failed)?;
        }
        let mut config = QuicClientConfig::try_from(builder).map_err(|_| {
            Error::new(
                "ERR_PROFILE_UNSUPPORTED",
                "initialization",
                "The native TLS backend rejected the HTTP/3 profile configuration",
            )
        })?;
        let alps = tls["alps"].as_array().is_some_and(|a| !a.is_empty());
        let new_codepoint = tls["alpsUseNewCodepoint"] == true;
        let ech_grease = tls["echGrease"] == true;
        config.set_ssl_callback(move |ssl, _server_name| {
            if alps {
                ssl.add_application_settings(b"h3", None)?;
                ssl.set_alps_use_new_codepoint(new_codepoint);
            }
            if ech_grease {
                ssl.set_enable_ech_grease(true);
            }
            Ok(())
        });
        Ok(config)
    }
}

fn hex(value: &str) -> Vec<u8> {
    value
        .as_bytes()
        .chunks(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).expect("hex"), 16).expect("hex"))
        .collect()
}

/// Brotli certificate compression (RFC 8879), shared with the TCP profile.
struct Brotli;
impl CertificateCompressor for Brotli {
    const ALGORITHM: CertificateCompressionAlgorithm = CertificateCompressionAlgorithm::BROTLI;
    const CAN_COMPRESS: bool = false;
    const CAN_DECOMPRESS: bool = true;
    fn decompress<W: std::io::Write>(&self, input: &[u8], output: &mut W) -> std::io::Result<()> {
        crate::profile_tls::brotli_decompress(input, output)
    }
}
