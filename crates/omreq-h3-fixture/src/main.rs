//! A minimal HTTP/3 server that records what a client sends on each QUIC stream.
//!
//! Profile qualification uses it to compare omreq with real Chrome: every client stream is
//! logged as hex chunks on stdout, one JSON object per line, so the caller can parse SETTINGS,
//! QPACK and request HEADERS byte for byte. Each request gets a small HTML response.
//!
//! usage: omreq-h3-fixture --cert cert.pem --key key.pem [--port 0] [--settings hex]

use std::{
    io::Write,
    net::{Ipv4Addr, SocketAddr},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

use btls::{
    pkey::PKey,
    ssl::{SslContextBuilder, SslMethod},
    x509::X509,
};
use quic::{Endpoint, RecvStream, ServerConfig, crypto::btls::QuicServerConfig};
use serde_json::{Value, json};

static SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn emit(mut event: Value) {
    event["seq"] = json!(SEQUENCE.fetch_add(1, Ordering::SeqCst));
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{event}");
    let _ = out.flush();
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).expect("hex"))
        .collect()
}

fn varint(value: u64, out: &mut Vec<u8>) {
    match value {
        0..0x40 => out.push(value as u8),
        0x40..0x4000 => out.extend_from_slice(&(value as u16 | 0x4000).to_be_bytes()),
        0x4000..0x4000_0000 => out.extend_from_slice(&(value as u32 | 0x8000_0000).to_be_bytes()),
        _ => out.extend_from_slice(&(value | 0xc000_0000_0000_0000).to_be_bytes()),
    }
}

/// The QPACK encoder stream of `--qpack-dynamic`, written in one piece with its stream type:
/// Set Dynamic Table Capacity 4096, then Insert With Literal Name `x-dynamic: yes`.
const ENCODER_STREAM: &[u8] = b"\x02\x3f\xe1\x1f\x49x-dynamic\x03yes";

/// HEADERS and DATA frames of a 200 response. QPACK uses the static table only, or with
/// `dynamic` also references the entry inserted by [`ENCODER_STREAM`] (Required Insert Count
/// 1, encoded as 2 for the client's 65536-byte table).
fn response(body: &[u8], dynamic: bool) -> Vec<u8> {
    let length = body.len().to_string();
    let mut block = if dynamic {
        vec![0x02, 0x00]
    } else {
        vec![0x00, 0x00]
    };
    block.extend_from_slice(&[0xd9, 0xf4, 0xe8, 0x54]);
    // content-length: literal value with a 7-bit length prefix, no Huffman.
    block.push(length.len() as u8);
    block.extend_from_slice(length.as_bytes());
    if dynamic {
        // Indexed field line, dynamic table, relative index 0: `x-dynamic: yes`.
        block.push(0x80);
    }
    let mut out = Vec::new();
    varint(0x01, &mut out);
    varint(block.len() as u64, &mut out);
    out.extend_from_slice(&block);
    varint(0x00, &mut out);
    varint(body.len() as u64, &mut out);
    out.extend_from_slice(body);
    out
}

async fn record(connection: u64, kind: &'static str, mut stream: RecvStream) -> Vec<u8> {
    let id = stream.id().index();
    let mut all = Vec::new();
    let mut buf = vec![0; 65536];
    loop {
        match stream.read(&mut buf).await {
            Ok(Some(n)) => {
                all.extend_from_slice(&buf[..n]);
                emit(json!({
                    "event": kind, "connection": connection, "stream": id,
                    "data": hex(&buf[..n]),
                }));
            }
            Ok(None) => {
                emit(json!({"event": "fin", "connection": connection, "kind": kind, "stream": id}));
                return all;
            }
            Err(error) => {
                emit(json!({
                    "event": "reset", "connection": connection, "kind": kind, "stream": id,
                    "error": error.to_string(),
                }));
                return all;
            }
        }
    }
}

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .map(|i| args[i + 1].clone())
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let cert = std::fs::read(arg(&args, "--cert").expect("--cert")).expect("cert");
    let key = std::fs::read(arg(&args, "--key").expect("--key")).expect("key");
    let port: u16 = arg(&args, "--port").map_or(0, |p| p.parse().expect("port"));
    let settings = unhex(&arg(&args, "--settings").unwrap_or_default());
    // Holds every response back, so a client can abandon requests that are in flight.
    let dynamic = args.iter().any(|a| a == "--qpack-dynamic");
    let delay = std::time::Duration::from_millis(
        arg(&args, "--delay-ms").map_or(0, |d| d.parse().expect("delay")),
    );
    // Refuses every request: `stream` resets it with H3_REQUEST_REJECTED, `connection` closes
    // the connection with H3_INTERNAL_ERROR.
    let reject = arg(&args, "--reject").filter(|r| !r.is_empty());

    let mut tls = SslContextBuilder::new(SslMethod::tls()).expect("ssl");
    tls.set_certificate(&X509::from_pem(&cert).expect("cert pem"))
        .expect("cert");
    tls.set_private_key(&PKey::private_key_from_pem(&key).expect("key pem"))
        .expect("key");
    tls.set_alpn_select_callback(|_, client| {
        btls::ssl::select_next_proto(b"\x02h3", client).ok_or(btls::ssl::AlpnError::NOACK)
    });
    let crypto = QuicServerConfig::try_from(tls).expect("quic tls");
    let config = ServerConfig::with_crypto(Arc::new(crypto));
    let endpoint =
        Endpoint::server(config, SocketAddr::from((Ipv4Addr::LOCALHOST, port))).expect("bind");
    emit(json!({"event": "listening", "port": endpoint.local_addr().expect("addr").port()}));

    let connections = AtomicU64::new(0);
    while let Some(incoming) = endpoint.accept().await {
        let index = connections.fetch_add(1, Ordering::SeqCst);
        let settings = settings.clone();
        let reject = reject.clone();
        tokio::spawn(async move {
            let connection = match incoming.await {
                Ok(connection) => connection,
                Err(error) => {
                    emit(
                        json!({"event": "error", "connection": index, "error": error.to_string()}),
                    );
                    return;
                }
            };
            emit(json!({
                "event": "connection", "connection": index,
                "remote": connection.remote_address().to_string(),
            }));
            // Server control stream: type 0x00, then SETTINGS.
            if let Ok(mut control) = connection.open_uni().await {
                let mut bytes = vec![0x00, 0x04];
                varint(settings.len() as u64, &mut bytes);
                bytes.extend_from_slice(&settings);
                let _ = control.write_all(&bytes).await;
                // Keep the control stream open for the connection's lifetime.
                std::mem::forget(control);
            }
            if dynamic && let Ok(mut encoder) = connection.open_uni().await {
                let _ = encoder.write_all(ENCODER_STREAM).await;
                std::mem::forget(encoder);
            }
            let uni = connection.clone();
            tokio::spawn(async move {
                while let Ok(stream) = uni.accept_uni().await {
                    tokio::spawn(record(index, "uni", stream));
                }
            });
            loop {
                let (mut send, recv) = match connection.accept_bi().await {
                    Ok(pair) => pair,
                    Err(error) => {
                        emit(
                            json!({"event": "closed", "connection": index, "reason": error.to_string()}),
                        );
                        return;
                    }
                };
                let reject = reject.clone();
                let rejecting = connection.clone();
                tokio::spawn(async move {
                    record(index, "request", recv).await;
                    match reject.as_deref() {
                        Some("stream") => {
                            let _ = send.reset(quic::VarInt::from_u32(0x10b));
                            return;
                        }
                        Some(_) => {
                            rejecting.close(quic::VarInt::from_u32(0x102), b"rejected");
                            return;
                        }
                        None => {}
                    }
                    tokio::time::sleep(delay).await;
                    let body = b"<!doctype html><title>omreq h3 fixture</title>ok";
                    let _ = send.write_all(&response(body, dynamic)).await;
                    let _ = send.finish();
                    // Wait for the peer to read everything before the stream is dropped.
                    let _ = send.stopped().await;
                });
            }
        });
    }
}
