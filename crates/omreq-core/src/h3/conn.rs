//! One HTTP/3 connection (RFC 9114) over QUIC: the client control stream, the peer's
//! control and QPACK streams, and request streams.

use std::{
    future::poll_fn,
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    task::{Context, Poll, ready},
    time::Duration,
};

use bytes::{Buf, Bytes, BytesMut};
use http::{HeaderMap, HeaderName, HeaderValue, StatusCode, Version};
use http_body::{Body, Frame, SizeHint};
use http3::qpack::{Decoder, DecoderError, HeaderField};
use quic::{Connection, ConnectionError, Endpoint, ReadError, RecvStream, SendStream, VarInt};
use tokio::sync::{Notify, mpsc};
use tokio_util::sync::CancellationToken;

use super::{profile::Http3Profile, profile::Pseudo, qpack};
use crate::error::{Error, Result};

const H3_NO_ERROR: u32 = 0x100;
const H3_GENERAL_PROTOCOL_ERROR: u32 = 0x101;
const H3_STREAM_CREATION_ERROR: u32 = 0x103;
const H3_CLOSED_CRITICAL_STREAM: u32 = 0x104;
const H3_FRAME_UNEXPECTED: u32 = 0x105;
const H3_FRAME_ERROR: u32 = 0x106;
const H3_SETTINGS_ERROR: u32 = 0x109;
const H3_MISSING_SETTINGS: u32 = 0x10a;
const H3_REQUEST_REJECTED: u64 = 0x10b;
const H3_REQUEST_CANCELLED: u32 = 0x10c;
const H3_MESSAGE_ERROR: u32 = 0x10e;
const QPACK_DECOMPRESSION_FAILED: u32 = 0x200;
const QPACK_ENCODER_STREAM_ERROR: u32 = 0x201;

const FRAME_DATA: u64 = 0x00;
const FRAME_HEADERS: u64 = 0x01;
const FRAME_SETTINGS: u64 = 0x04;
const FRAME_PUSH_PROMISE: u64 = 0x05;
const FRAME_GOAWAY: u64 = 0x07;
const FRAME_PRIORITY_UPDATE: u64 = 0xf0700;

const STREAM_CONTROL: u64 = 0x00;
const STREAM_PUSH: u64 = 0x01;
const STREAM_QPACK_ENCODER: u64 = 0x02;
const STREAM_QPACK_DECODER: u64 = 0x03;

/// Frame types that are not allowed on a request stream from a server, including the HTTP/2
/// types that HTTP/3 reserves (RFC 9114 section 7.2.8).
fn unexpected_on_request(kind: u64) -> bool {
    matches!(kind, 0x02 | 0x03 | 0x04 | 0x06 | 0x07 | 0x08 | 0x09 | 0x0d)
        || kind == FRAME_PUSH_PROMISE
}

fn code(value: u32) -> VarInt {
    VarInt::from_u32(value)
}

pub(crate) fn put_varint(out: &mut Vec<u8>, value: u64) {
    match value {
        0..0x40 => out.push(value as u8),
        0x40..0x4000 => out.extend_from_slice(&(value as u16 | 0x4000).to_be_bytes()),
        0x4000..0x4000_0000 => out.extend_from_slice(&(value as u32 | 0x8000_0000).to_be_bytes()),
        _ => out.extend_from_slice(&(value | 0xc000_0000_0000_0000).to_be_bytes()),
    }
}

fn get_varint(buf: &[u8]) -> Option<(u64, usize)> {
    let first = *buf.first()?;
    let length = 1usize << (first >> 6);
    if buf.len() < length {
        return None;
    }
    let mut value = u64::from(first & 0x3f);
    for byte in &buf[1..length] {
        value = (value << 8) | u64::from(*byte);
    }
    Some((value, length))
}

fn random_u32() -> u32 {
    let mut bytes = [0; 4];
    btls::rand::rand_bytes(&mut bytes).expect("BoringSSL random bytes");
    u32::from_ne_bytes(bytes)
}

/// A reserved codepoint (RFC 9114 section 7.2.8), derived from 32 random bits as Chromium does.
fn reserved(random: u32) -> u64 {
    0x1f * u64::from(random) + 0x21
}

/// The client control stream preface: stream type, SETTINGS and, with the profile's GREASE,
/// a reserved setting and a reserved frame (QUICHE `QuicSendControlStream`).
fn control_preface(profile: &Http3Profile) -> Vec<u8> {
    let mut settings = Vec::new();
    for (id, value) in &profile.settings {
        put_varint(&mut settings, *id);
        put_varint(&mut settings, *value);
    }
    if profile.grease_setting {
        put_varint(&mut settings, reserved(random_u32()));
        put_varint(&mut settings, u64::from(random_u32()));
    }
    let mut out = Vec::new();
    put_varint(&mut out, STREAM_CONTROL);
    put_varint(&mut out, FRAME_SETTINGS);
    put_varint(&mut out, settings.len() as u64);
    out.extend_from_slice(&settings);
    if profile.grease_frame {
        let random = random_u32();
        let length = (random % 4) as usize;
        let mut payload = vec![0; length];
        btls::rand::rand_bytes(&mut payload).expect("BoringSSL random bytes");
        put_varint(&mut out, reserved(random));
        put_varint(&mut out, length as u64);
        out.extend_from_slice(&payload);
    }
    out
}

/// An HTTP/3 failure, carried through response bodies as the transport error.
#[derive(Debug)]
pub(crate) struct H3Error(pub(crate) String);
impl std::fmt::Display for H3Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for H3Error {}
impl From<ReadError> for H3Error {
    fn from(error: ReadError) -> Self {
        match error {
            ReadError::Reset(code) => H3Error(format!(
                "HTTP/3 stream reset by peer (0x{:x})",
                code.into_inner()
            )),
            other => H3Error(format!("HTTP/3 stream failed: {other}")),
        }
    }
}

fn protocol(message: &str) -> Error {
    Error::new("ERR_HTTP_PROTOCOL", "headers", message)
}

/// Maps a QUIC connection failure to the error of the phase it happened in.
pub(crate) fn connection_error(error: &ConnectionError, phase: &str) -> Error {
    let detail = error.to_string();
    let (code, phase, summary) = match error {
        ConnectionError::TimedOut => ("ERR_TIMEOUT", phase, "QUIC connection timed out"),
        ConnectionError::TransportError(e) if (0x100..0x200).contains(&u64::from(e.code)) => {
            ("ERR_TLS", "tls", "QUIC TLS handshake failed")
        }
        _ if phase == "connect" => ("ERR_CONNECT", "connect", "QUIC connection failed"),
        _ => ("ERR_HTTP_PROTOCOL", phase, "HTTP/3 connection failed"),
    };
    Error::new(code, phase, &format!("{summary}: {detail}"))
}

/// The receiving side of a stream, read in HTTP/3 frames.
struct FrameReader {
    recv: RecvStream,
    buf: BytesMut,
    fin: bool,
    /// For a request stream: the stream ID and decoder stream to announce an abandoned field
    /// section on (Stream Cancellation, RFC 9204 section 4.4.2). QUICHE sends it for every
    /// request stream reset before its FIN while its own table capacity is non-zero.
    cancellation: Option<(u64, mpsc::UnboundedSender<Vec<u8>>)>,
    /// The error code of a RESET_STREAM from the peer.
    reset: Option<u64>,
}

impl FrameReader {
    fn new(recv: RecvStream) -> Self {
        Self {
            recv,
            buf: BytesMut::new(),
            fin: false,
            cancellation: None,
            reset: None,
        }
    }

    fn poll_fill(&mut self, cx: &mut Context<'_>) -> Poll<std::result::Result<(), H3Error>> {
        if self.fin {
            return Poll::Ready(Ok(()));
        }
        let mut chunk = [0u8; 16384];
        let n = match ready!(self.recv.poll_read(cx, &mut chunk)) {
            Ok(n) => n,
            Err(error) => {
                if let ReadError::Reset(code) = &error {
                    self.reset = Some(code.into_inner());
                }
                return Poll::Ready(Err(error.into()));
            }
        };
        if n == 0 {
            self.fin = true;
        } else {
            self.buf.extend_from_slice(&chunk[..n]);
        }
        Poll::Ready(Ok(()))
    }

    /// The next varint, or `None` at the end of the stream.
    fn poll_varint(
        &mut self,
        cx: &mut Context<'_>,
    ) -> Poll<std::result::Result<Option<u64>, H3Error>> {
        loop {
            if let Some((value, used)) = get_varint(&self.buf) {
                self.buf.advance(used);
                return Poll::Ready(Ok(Some(value)));
            }
            if self.fin {
                return Poll::Ready(if self.buf.is_empty() {
                    Ok(None)
                } else {
                    Err(H3Error("HTTP/3 stream ended inside a varint".into()))
                });
            }
            ready!(self.poll_fill(cx))?;
        }
    }

    /// The next frame type and length, or `None` at the end of the stream between frames.
    fn poll_frame_header(
        &mut self,
        cx: &mut Context<'_>,
    ) -> Poll<std::result::Result<Option<(u64, u64)>, H3Error>> {
        loop {
            if let Some((kind, a)) = get_varint(&self.buf)
                && let Some((length, b)) = get_varint(&self.buf[a..])
            {
                self.buf.advance(a + b);
                return Poll::Ready(Ok(Some((kind, length))));
            }
            if self.fin {
                return Poll::Ready(if self.buf.is_empty() {
                    Ok(None)
                } else {
                    Err(H3Error("HTTP/3 stream ended inside a frame header".into()))
                });
            }
            ready!(self.poll_fill(cx))?;
        }
    }

    /// Exactly `n` bytes.
    fn poll_take(
        &mut self,
        cx: &mut Context<'_>,
        n: usize,
    ) -> Poll<std::result::Result<Bytes, H3Error>> {
        while self.buf.len() < n {
            if self.fin {
                return Poll::Ready(Err(H3Error("HTTP/3 stream ended inside a frame".into())));
            }
            ready!(self.poll_fill(cx))?;
        }
        Poll::Ready(Ok(self.buf.split_to(n).freeze()))
    }

    /// Between one and `max` bytes.
    fn poll_some(
        &mut self,
        cx: &mut Context<'_>,
        max: u64,
    ) -> Poll<std::result::Result<Bytes, H3Error>> {
        while self.buf.is_empty() {
            if self.fin {
                return Poll::Ready(Err(H3Error("HTTP/3 stream ended inside a frame".into())));
            }
            ready!(self.poll_fill(cx))?;
        }
        let n = self
            .buf
            .len()
            .min(usize::try_from(max).unwrap_or(usize::MAX));
        Poll::Ready(Ok(self.buf.split_to(n).freeze()))
    }

    fn finished(&self) -> bool {
        self.fin && self.buf.is_empty()
    }
}

impl Drop for FrameReader {
    fn drop(&mut self) {
        if !self.fin {
            let _ = self.recv.stop(code(H3_REQUEST_CANCELLED));
            if let Some((stream_id, instructions)) = self.cancellation.take() {
                let mut out = Vec::new();
                http3::qpack::stream_canceled(stream_id, &mut out);
                let _ = instructions.send(out);
            }
        }
    }
}

/// QPACK decoding state shared by the connection's streams.
struct Qpack {
    decoder: Mutex<Decoder>,
    /// Signalled when the peer's encoder stream inserted entries.
    changed: Notify,
    blocked: AtomicUsize,
    max_blocked: usize,
    /// Decoder-stream instructions, written by the connection's writer task.
    instructions: mpsc::UnboundedSender<Vec<u8>>,
    /// The dynamic table capacity this client advertised.
    table_capacity: u64,
}

impl Qpack {
    fn acknowledge(&self, stream_id: u64) {
        let mut out = Vec::new();
        http3::qpack::ack_header(stream_id, &mut out);
        let _ = self.instructions.send(out);
    }

    /// Decodes a field section without waiting; `None` when it is blocked on the encoder stream.
    fn try_decode(
        &self,
        stream_id: u64,
        block: &mut Bytes,
        max_size: u64,
        prefix: &mut Option<http3::qpack::FieldSectionPrefix>,
    ) -> std::result::Result<Option<Vec<HeaderField<'static>>>, DecoderError> {
        let decoded =
            crate::error::lock(&self.decoder).decode_header_limited(block, max_size, prefix);
        match decoded {
            Ok(decoded) => {
                if decoded.dyn_ref {
                    self.acknowledge(stream_id);
                }
                Ok(Some(decoded.fields))
            }
            Err(DecoderError::MissingRefs(_)) => Ok(None),
            Err(error) => Err(error),
        }
    }
}

/// State shared by the connection handle and its stream tasks.
struct Shared {
    quic: Connection,
    qpack: Qpack,
    settings_received: Notify,
    peer_settings: Mutex<Option<Vec<(u64, u64)>>>,
    goaway: AtomicBool,
    closed: CancellationToken,
}

impl Shared {
    fn fail(&self, error: u32, reason: &str) {
        self.quic.close(code(error), reason.as_bytes());
        self.closed.cancel();
    }
}

/// One HTTP/3 connection. Requests are multiplexed on it until the peer sends GOAWAY or the
/// connection closes.
pub(crate) struct H3Connection {
    shared: Arc<Shared>,
    profile: Arc<Http3Profile>,
    control: Arc<tokio::sync::Mutex<SendStream>>,
    // The endpoint owns the UDP socket; it lives as long as the connection.
    _endpoint: Endpoint,
}

impl H3Connection {
    pub(crate) async fn establish(
        endpoint: Endpoint,
        quic: Connection,
        profile: Arc<Http3Profile>,
    ) -> Result<Arc<Self>> {
        let (instructions, mut pending) = mpsc::unbounded_channel::<Vec<u8>>();
        let capacity = profile.setting(0x01).unwrap_or(0);
        let max_blocked = profile.setting(0x07).unwrap_or(0);
        let mut decoder =
            Decoder::new(capacity, max_blocked).map_err(|_| protocol("Invalid QPACK settings"))?;
        if let Some(size) = profile.setting(0x06) {
            decoder.set_max_encoded_string_size(usize::try_from(size).unwrap_or(usize::MAX));
        }
        let shared = Arc::new(Shared {
            quic: quic.clone(),
            qpack: Qpack {
                decoder: Mutex::new(decoder),
                changed: Notify::new(),
                blocked: AtomicUsize::new(0),
                max_blocked: max_blocked as usize,
                instructions,
                table_capacity: capacity,
            },
            settings_received: Notify::new(),
            peer_settings: Mutex::new(None),
            goaway: AtomicBool::new(false),
            closed: CancellationToken::new(),
        });

        let mut control = quic
            .open_uni()
            .await
            .map_err(|e| connection_error(&e, "connect"))?;
        control
            .write_all(&control_preface(&profile))
            .await
            .map_err(|e| {
                Error::new(
                    "ERR_CONNECT",
                    "connect",
                    &format!("HTTP/3 control stream failed: {e}"),
                )
            })?;

        // The decoder stream is opened with its first instruction, as Chromium does.
        let writer = shared.clone();
        tokio::spawn(async move {
            let mut stream: Option<SendStream> = None;
            loop {
                // `Shared` owns the only sender, so the channel never ends on its own.
                let bytes = tokio::select! {
                    _ = writer.closed.cancelled() => return,
                    bytes = pending.recv() => match bytes {
                        Some(bytes) => bytes,
                        None => return,
                    },
                };
                if stream.is_none() {
                    let Ok(mut opened) = writer.quic.open_uni().await else {
                        return;
                    };
                    let mut preface = Vec::new();
                    put_varint(&mut preface, STREAM_QPACK_DECODER);
                    if opened.write_all(&preface).await.is_err() {
                        return;
                    }
                    stream = Some(opened);
                }
                if let Some(stream) = stream.as_mut()
                    && stream.write_all(&bytes).await.is_err()
                {
                    return;
                }
            }
        });

        let reader = shared.clone();
        tokio::spawn(async move {
            loop {
                let stream = tokio::select! {
                    _ = reader.closed.cancelled() => return,
                    stream = reader.quic.accept_uni() => stream,
                };
                match stream {
                    Ok(stream) => {
                        tokio::spawn(peer_uni_stream(reader.clone(), stream));
                    }
                    Err(_) => {
                        reader.closed.cancel();
                        return;
                    }
                }
            }
        });

        // A server never opens bidirectional streams in HTTP/3.
        let watcher = shared.clone();
        tokio::spawn(async move {
            tokio::select! {
                _ = watcher.closed.cancelled() => {}
                stream = watcher.quic.accept_bi() => {
                    if stream.is_ok() {
                        watcher.fail(H3_STREAM_CREATION_ERROR, "server-initiated bidirectional stream");
                    } else {
                        watcher.closed.cancel();
                    }
                }
            }
        });

        Ok(Arc::new(Self {
            shared,
            profile,
            control: Arc::new(tokio::sync::Mutex::new(control)),
            _endpoint: endpoint,
        }))
    }

    /// Whether new requests may use this connection.
    pub(crate) fn is_usable(&self) -> bool {
        !self.shared.closed.is_cancelled()
            && !self.shared.goaway.load(Ordering::SeqCst)
            && self.shared.quic.close_reason().is_none()
    }

    pub(crate) fn close(&self) {
        self.shared.quic.close(code(H3_NO_ERROR), b"");
        self.shared.closed.cancel();
    }

    /// A response stream read that failed before the response headers. It is retryable when
    /// the connection broke or the server rejected the request unprocessed (RFC 9114 section
    /// 4.1.1), as Chromium resends such requests.
    fn read_failed(&self, reader: &FrameReader, error: &H3Error) -> RequestError {
        if reader.reset == Some(H3_REQUEST_REJECTED) {
            return RequestError {
                error: protocol("HTTP/3 request rejected by the server"),
                retryable: true,
            };
        }
        match self.shared.quic.close_reason() {
            Some(reason) => RequestError {
                error: connection_error(&reason, "headers"),
                retryable: true,
            },
            None => RequestError {
                error: protocol(&error.0),
                retryable: false,
            },
        }
    }

    /// Opens a request stream. Failing here means nothing was sent on this connection.
    pub(crate) async fn open(&self) -> Result<(SendStream, RecvStream)> {
        self.shared.quic.open_bi().await.map_err(|e| {
            if self.shared.goaway.load(Ordering::SeqCst) {
                Error::new("ERR_CONNECT", "connect", "HTTP/3 connection is going away")
            } else {
                connection_error(&e, "connect")
            }
        })
    }

    /// Sends one request on a stream from [`Self::open`] and returns its response once the
    /// final response headers arrived. Each header in `headers` is already in wire order with
    /// a lowercase name.
    pub(crate) async fn send(
        self: &Arc<Self>,
        (send, recv): (SendStream, RecvStream),
        method: &http::Method,
        uri: &http::Uri,
        headers: Vec<(HeaderName, HeaderValue)>,
        body: wreq::Body,
    ) -> std::result::Result<http::Response<H3Body>, RequestError> {
        let stream_id: u64 = send.id().into();
        // Until the request is handed to the upload task, dropping this future resets the
        // request side: a dropped `SendStream` would otherwise end a partial HEADERS frame.
        let mut send = ResetOnDrop(Some(send));
        let mut reader = FrameReader::new(recv);
        if self.shared.qpack.table_capacity > 0 {
            reader.cancellation = Some((stream_id, self.shared.qpack.instructions.clone()));
        }
        let cancel = CancellationToken::new();
        // Resets the request side when the response future is dropped before it completes.
        let guard = cancel.clone().drop_guard();
        let fatal = |error| RequestError {
            error,
            retryable: false,
        };

        let authority = match uri.port_u16() {
            Some(port) if port != 443 => format!("{}:{port}", uri.host().unwrap_or_default()),
            _ => uri.host().unwrap_or_default().to_owned(),
        };
        let path = uri.path_and_query().map_or("/", |p| p.as_str()).to_owned();
        let mut fields: Vec<(Vec<u8>, Vec<u8>)> = Vec::with_capacity(headers.len() + 4);
        for pseudo in &self.profile.pseudo_order {
            fields.push(match pseudo {
                Pseudo::Method => (b":method".to_vec(), method.as_str().as_bytes().to_vec()),
                Pseudo::Scheme => (b":scheme".to_vec(), b"https".to_vec()),
                Pseudo::Authority => (b":authority".to_vec(), authority.as_bytes().to_vec()),
                Pseudo::Path => (b":path".to_vec(), path.as_bytes().to_vec()),
            });
        }
        let mut priority = None;
        for (name, value) in &headers {
            if name == "priority" {
                priority = Some(value.as_bytes().to_vec());
            }
            fields.push((name.as_str().as_bytes().to_vec(), value.as_bytes().to_vec()));
        }
        let block = qpack::encode(
            fields.iter().map(|(n, v)| (n.as_slice(), v.as_slice())),
            self.profile.huffman,
            self.profile.cookie_crumbs,
        );
        if self.profile.priority_update
            && let Some(value) = priority.as_deref().and_then(priority_field_value)
        {
            // QUICHE announces a non-default priority on the control stream before the request.
            let mut frame = Vec::new();
            let mut payload = Vec::new();
            put_varint(&mut payload, stream_id);
            payload.extend_from_slice(value.as_bytes());
            put_varint(&mut frame, FRAME_PRIORITY_UPDATE);
            put_varint(&mut frame, payload.len() as u64);
            frame.extend_from_slice(&payload);
            // A frame cut short would corrupt the control stream, so the write runs to its end
            // in its own task even if this request is abandoned.
            let control = self.control.clone();
            let _ = tokio::spawn(async move {
                let _ = control.lock().await.write_all(&frame).await;
            })
            .await;
        }
        let mut head = Vec::with_capacity(block.len() + 8);
        put_varint(&mut head, FRAME_HEADERS);
        put_varint(&mut head, block.len() as u64);
        head.extend_from_slice(&block);
        let written = match send.0.as_mut() {
            Some(stream) => stream.write_all(&head).await,
            None => unreachable!("request stream taken before it was written"),
        };
        if let Err(error) = written {
            return Err(match error {
                // The connection failed before the server saw the request.
                quic::WriteError::ConnectionLost(e) => RequestError {
                    error: connection_error(&e, "headers"),
                    retryable: true,
                },
                quic::WriteError::Stopped(c) if c.into_inner() == H3_REQUEST_REJECTED => {
                    RequestError {
                        error: protocol("HTTP/3 request rejected by the server"),
                        retryable: true,
                    }
                }
                other => fatal(protocol(&format!("HTTP/3 request stream failed: {other}"))),
            });
        }
        let mut send = send.0.take().expect("request stream");
        if body.is_end_stream() {
            let _ = send.finish();
        } else {
            tokio::spawn(upload(send, body, cancel.clone()));
        }

        // Response: interim (1xx) responses are skipped until the final HEADERS frame.
        let max_size = self.profile.setting(0x06).unwrap_or(u64::MAX);
        let (status, headers) = loop {
            let frame = tokio::select! {
                _ = self.shared.closed.cancelled() => {
                    return Err(RequestError {
                        error: match self.shared.quic.close_reason() {
                            Some(e) => connection_error(&e, "headers"),
                            None => protocol("HTTP/3 connection closed"),
                        },
                        retryable: true,
                    });
                }
                frame = poll_fn(|cx| reader.poll_frame_header(cx)) => frame,
            };
            let (kind, length) = match frame {
                Ok(Some(frame)) => frame,
                Ok(None) => return Err(fatal(protocol("HTTP/3 stream ended before the response"))),
                Err(error) => return Err(self.read_failed(&reader, &error)),
            };
            match kind {
                FRAME_HEADERS => {
                    if length > max_size.saturating_mul(2).max(65536) {
                        return Err(fatal(Error::new(
                            "ERR_RESOURCE_LIMIT",
                            "headers",
                            "Response headers exceeded the limit",
                        )));
                    }
                    let mut block = match poll_fn(|cx| reader.poll_take(cx, length as usize)).await
                    {
                        Ok(block) => block,
                        Err(error) => return Err(self.read_failed(&reader, &error)),
                    };
                    let fields = self.decode(stream_id, &mut block, max_size).await?;
                    let (status, headers) = response_head(fields).map_err(fatal)?;
                    if status.is_informational() {
                        continue;
                    }
                    break (status, headers);
                }
                FRAME_DATA => {
                    return Err(fatal(protocol("HTTP/3 DATA before the response headers")));
                }
                kind if unexpected_on_request(kind) => {
                    self.shared
                        .fail(H3_FRAME_UNEXPECTED, "unexpected frame on a request stream");
                    return Err(fatal(protocol(
                        "Unexpected HTTP/3 frame on a request stream",
                    )));
                }
                _ => {
                    // Unknown and reserved frame types are skipped.
                    let mut left = length;
                    while left > 0 {
                        let skipped = match poll_fn(|cx| reader.poll_some(cx, left)).await {
                            Ok(skipped) => skipped,
                            Err(error) => return Err(self.read_failed(&reader, &error)),
                        };
                        left -= skipped.len() as u64;
                    }
                }
            }
        };
        let no_body = method == http::Method::HEAD
            || status == StatusCode::NO_CONTENT
            || status == StatusCode::NOT_MODIFIED;
        let length = if no_body {
            Some(0)
        } else {
            headers
                .get(http::header::CONTENT_LENGTH)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u64>().ok())
        };
        // The request side keeps running while the response streams; it is reset only if the
        // response is abandoned before its end.
        let body = H3Body {
            reader,
            connection: self.clone(),
            stream_id,
            state: BodyState::Frames,
            length,
            received: 0,
            done: false,
            _upload: guard,
        };
        let mut response = http::Response::new(body);
        *response.status_mut() = status;
        *response.version_mut() = Version::HTTP_3;
        *response.headers_mut() = headers;
        Ok(response)
    }

    async fn decode(
        &self,
        stream_id: u64,
        block: &mut Bytes,
        max_size: u64,
    ) -> std::result::Result<Vec<HeaderField<'static>>, RequestError> {
        let qpack = &self.shared.qpack;
        let mut prefix = None;
        // Counts this stream as blocked until it decodes or the request is abandoned.
        let mut blocked: Option<BlockedStream<'_>> = None;
        loop {
            let changed = qpack.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            match qpack.try_decode(stream_id, block, max_size, &mut prefix) {
                Ok(Some(fields)) => return Ok(fields),
                Ok(None) => {
                    if blocked.is_none() {
                        if qpack.blocked.fetch_add(1, Ordering::SeqCst) >= qpack.max_blocked {
                            qpack.blocked.fetch_sub(1, Ordering::SeqCst);
                            self.shared
                                .fail(QPACK_DECOMPRESSION_FAILED, "too many blocked streams");
                            return Err(RequestError {
                                error: protocol("QPACK blocked streams exceeded"),
                                retryable: false,
                            });
                        }
                        blocked = Some(BlockedStream(&qpack.blocked));
                    }
                    tokio::select! {
                        _ = changed => {}
                        _ = self.shared.closed.cancelled() => {
                            return Err(RequestError {
                                error: match self.shared.quic.close_reason() {
                                    Some(e) => connection_error(&e, "headers"),
                                    None => protocol("HTTP/3 connection closed"),
                                },
                                retryable: true,
                            });
                        }
                    }
                }
                Err(DecoderError::HeaderTooLong(_)) => {
                    return Err(RequestError {
                        error: Error::new(
                            "ERR_RESOURCE_LIMIT",
                            "headers",
                            "Response headers exceeded the limit",
                        ),
                        retryable: false,
                    });
                }
                Err(_) => {
                    self.shared
                        .fail(QPACK_DECOMPRESSION_FAILED, "QPACK decompression failed");
                    return Err(RequestError {
                        error: protocol("QPACK decompression failed"),
                        retryable: false,
                    });
                }
            }
        }
    }
}

impl Drop for H3Connection {
    fn drop(&mut self) {
        // The last handle is gone: no request can use the connection any more.
        self.close();
    }
}

/// A request that failed on an HTTP/3 connection.
pub(crate) struct RequestError {
    pub(crate) error: Error,
    /// The server did not process the request: the connection failed or the stream was
    /// rejected before the response headers, so it may be sent again elsewhere.
    pub(crate) retryable: bool,
}

/// Decrements the blocked-stream count when dropped.
struct BlockedStream<'a>(&'a AtomicUsize);
impl Drop for BlockedStream<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// A request stream that is reset if dropped before it is handed on.
struct ResetOnDrop(Option<SendStream>);
impl Drop for ResetOnDrop {
    fn drop(&mut self) {
        if let Some(stream) = self.0.as_mut() {
            let _ = stream.reset(code(H3_REQUEST_CANCELLED));
        }
    }
}

/// Splits a decoded field section into the status and the response headers.
fn response_head(fields: Vec<HeaderField<'static>>) -> Result<(StatusCode, HeaderMap)> {
    let mut status = None;
    let mut headers = HeaderMap::with_capacity(fields.len());
    let mut regular = false;
    for field in fields {
        let (name, value) = field.into_inner();
        if let Some(pseudo) = name.strip_prefix(b":") {
            if regular || pseudo != b"status" || status.is_some() {
                return Err(protocol("Malformed HTTP/3 response pseudo-header"));
            }
            status = Some(
                StatusCode::from_bytes(&value).map_err(|_| protocol("Invalid HTTP/3 status"))?,
            );
            continue;
        }
        regular = true;
        let name =
            HeaderName::from_bytes(&name).map_err(|_| protocol("Invalid HTTP/3 header name"))?;
        if name.as_str().bytes().any(|b| b.is_ascii_uppercase()) {
            return Err(protocol("Uppercase HTTP/3 header name"));
        }
        let value =
            HeaderValue::from_bytes(&value).map_err(|_| protocol("Invalid HTTP/3 header value"))?;
        headers.append(name, value);
    }
    let status = status.ok_or_else(|| protocol("HTTP/3 response without status"))?;
    Ok((status, headers))
}

/// The PRIORITY_UPDATE value QUICHE sends for a request's `priority` header, or `None` for the
/// default priority (urgency 3, not incremental), which Chromium does not announce.
fn priority_field_value(header: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(header).ok()?;
    let mut urgency = 3u8;
    let mut incremental = false;
    for item in text.split(',').map(str::trim) {
        if let Some(value) = item.strip_prefix("u=") {
            if let Ok(value) = value.parse::<u8>()
                && value <= 7
            {
                urgency = value;
            }
        } else if item == "i" || item == "i=?1" {
            incremental = true;
        } else if item == "i=?0" {
            incremental = false;
        }
    }
    match (urgency, incremental) {
        (3, false) => None,
        (3, true) => Some("i".into()),
        (u, false) => Some(format!("u={u}")),
        (u, true) => Some(format!("u={u}, i")),
    }
}

/// Writes a request body as DATA frames, then ends the stream.
async fn upload(mut send: SendStream, mut body: wreq::Body, cancel: CancellationToken) {
    loop {
        let frame = tokio::select! {
            _ = cancel.cancelled() => {
                let _ = send.reset(code(H3_REQUEST_CANCELLED));
                return;
            }
            frame = poll_fn(|cx| Pin::new(&mut body).poll_frame(cx)) => frame,
        };
        match frame {
            None => break,
            Some(Ok(frame)) => {
                let Ok(data) = frame.into_data() else {
                    continue;
                };
                if data.is_empty() {
                    continue;
                }
                let mut header = Vec::with_capacity(16);
                put_varint(&mut header, FRAME_DATA);
                put_varint(&mut header, data.len() as u64);
                let mut chunks = [Bytes::from(header), data];
                let written = tokio::select! {
                    _ = cancel.cancelled() => Err(()),
                    r = send.write_all_chunks(&mut chunks) => r.map_err(|_| ()),
                };
                if written.is_err() {
                    let _ = send.reset(code(H3_REQUEST_CANCELLED));
                    return;
                }
            }
            Some(Err(_)) => {
                let _ = send.reset(code(H3_REQUEST_CANCELLED));
                return;
            }
        }
    }
    let _ = send.finish();
}

/// Reads one unidirectional stream opened by the peer.
async fn peer_uni_stream(shared: Arc<Shared>, recv: RecvStream) {
    let mut reader = FrameReader::new(recv);
    let kind = match poll_fn(|cx| reader.poll_varint(cx)).await {
        Ok(Some(kind)) => kind,
        _ => return,
    };
    match kind {
        STREAM_CONTROL => control_stream(&shared, &mut reader).await,
        STREAM_QPACK_ENCODER => encoder_stream(&shared, &mut reader).await,
        STREAM_QPACK_DECODER => {
            // This client never inserts into the peer's table; the instructions are discarded.
            while poll_fn(|cx| reader.poll_some(cx, u64::MAX)).await.is_ok() {}
        }
        STREAM_PUSH => {
            // No MAX_PUSH_ID was sent, so a push stream is an error.
            shared.fail(0x108, "push stream without MAX_PUSH_ID");
        }
        _ => {
            // Unknown and reserved stream types are not read (RFC 9114 section 6.2).
            let _ = reader.recv.stop(code(H3_STREAM_CREATION_ERROR));
            reader.fin = true;
        }
    }
}

async fn control_stream(shared: &Arc<Shared>, reader: &mut FrameReader) {
    let mut first = true;
    loop {
        let (kind, length) = match poll_fn(|cx| reader.poll_frame_header(cx)).await {
            Ok(Some(frame)) => frame,
            _ => {
                if !shared.closed.is_cancelled() {
                    shared.fail(H3_CLOSED_CRITICAL_STREAM, "control stream closed");
                }
                return;
            }
        };
        if length > 65536 {
            shared.fail(H3_FRAME_ERROR, "control frame too large");
            return;
        }
        let Ok(payload) = poll_fn(|cx| reader.poll_take(cx, length as usize)).await else {
            shared.fail(H3_CLOSED_CRITICAL_STREAM, "control stream closed");
            return;
        };
        if first && kind != FRAME_SETTINGS {
            shared.fail(H3_MISSING_SETTINGS, "first control frame is not SETTINGS");
            return;
        }
        match kind {
            FRAME_SETTINGS if first => {
                let mut settings = Vec::new();
                let mut rest = &payload[..];
                while !rest.is_empty() {
                    let Some((id, a)) = get_varint(rest) else {
                        shared.fail(H3_FRAME_ERROR, "malformed SETTINGS");
                        return;
                    };
                    let Some((value, b)) = get_varint(&rest[a..]) else {
                        shared.fail(H3_FRAME_ERROR, "malformed SETTINGS");
                        return;
                    };
                    // HTTP/2 setting identifiers are forbidden (RFC 9114 section 7.2.4.1).
                    if matches!(id, 0x00 | 0x02 | 0x03 | 0x04 | 0x05)
                        || settings.iter().any(|(i, _)| *i == id)
                    {
                        shared.fail(H3_SETTINGS_ERROR, "invalid SETTINGS");
                        return;
                    }
                    settings.push((id, value));
                    rest = &rest[a + b..];
                }
                *crate::error::lock(&shared.peer_settings) = Some(settings);
                shared.settings_received.notify_waiters();
            }
            FRAME_GOAWAY => shared.goaway.store(true, Ordering::SeqCst),
            FRAME_SETTINGS | FRAME_DATA | FRAME_HEADERS | FRAME_PUSH_PROMISE | 0x02 | 0x06
            | 0x08 | 0x09 | 0x0d => {
                shared.fail(
                    H3_FRAME_UNEXPECTED,
                    "unexpected frame on the control stream",
                );
                return;
            }
            // CANCEL_PUSH, PRIORITY_UPDATE from a server, unknown and reserved frames.
            _ => {}
        }
        first = false;
    }
}

async fn encoder_stream(shared: &Arc<Shared>, reader: &mut FrameReader) {
    loop {
        // Instructions often arrive together with the stream type, so what is buffered is
        // applied before waiting for more.
        if !reader.buf.is_empty() {
            let mut cursor = std::io::Cursor::new(&reader.buf[..]);
            let mut out = Vec::new();
            let result = crate::error::lock(&shared.qpack.decoder)
                .on_encoder_recv_buffered(&mut cursor, &mut out);
            let consumed = cursor.position() as usize;
            reader.buf.advance(consumed);
            if result.is_err() {
                shared.fail(QPACK_ENCODER_STREAM_ERROR, "QPACK encoder stream error");
                return;
            }
            if !out.is_empty() {
                let _ = shared.qpack.instructions.send(out);
            }
            if consumed > 0 {
                shared.qpack.changed.notify_waiters();
            }
        }
        if reader.fin {
            if !shared.closed.is_cancelled() {
                shared.fail(H3_CLOSED_CRITICAL_STREAM, "QPACK encoder stream closed");
            }
            return;
        }
        if poll_fn(|cx| reader.poll_fill(cx)).await.is_err() {
            if !shared.closed.is_cancelled() {
                shared.fail(H3_CLOSED_CRITICAL_STREAM, "QPACK encoder stream closed");
            }
            return;
        }
    }
}

enum BodyState {
    Frames,
    Data(u64),
    Skip(u64),
    Trailers(usize),
}

/// A response body: the DATA frames of a request stream.
pub(crate) struct H3Body {
    reader: FrameReader,
    connection: Arc<H3Connection>,
    stream_id: u64,
    state: BodyState,
    length: Option<u64>,
    received: u64,
    done: bool,
    _upload: tokio_util::sync::DropGuard,
}

impl Body for H3Body {
    type Data = Bytes;
    type Error = H3Error;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<std::result::Result<Frame<Bytes>, H3Error>>> {
        let this = self.get_mut();
        loop {
            if this.done {
                return Poll::Ready(None);
            }
            match this.state {
                BodyState::Data(0) | BodyState::Skip(0) => this.state = BodyState::Frames,
                BodyState::Data(left) => {
                    let data = match ready!(this.reader.poll_some(cx, left)) {
                        Ok(data) => data,
                        Err(error) => {
                            this.done = true;
                            return Poll::Ready(Some(Err(error)));
                        }
                    };
                    this.state = BodyState::Data(left - data.len() as u64);
                    this.received += data.len() as u64;
                    if this.length.is_some_and(|n| this.received > n) {
                        this.done = true;
                        return Poll::Ready(Some(Err(H3Error(
                            "HTTP/3 body exceeds its content-length".into(),
                        ))));
                    }
                    return Poll::Ready(Some(Ok(Frame::data(data))));
                }
                BodyState::Skip(left) => match ready!(this.reader.poll_some(cx, left)) {
                    Ok(skipped) => this.state = BodyState::Skip(left - skipped.len() as u64),
                    Err(error) => {
                        this.done = true;
                        return Poll::Ready(Some(Err(error)));
                    }
                },
                BodyState::Trailers(length) => {
                    let mut block = match ready!(this.reader.poll_take(cx, length)) {
                        Ok(block) => block,
                        Err(error) => {
                            this.done = true;
                            return Poll::Ready(Some(Err(error)));
                        }
                    };
                    // Trailers are not exposed; they are decoded so the encoder learns of
                    // dynamic references, and skipped if they wait on the encoder stream.
                    let decoded = this.connection.shared.qpack.try_decode(
                        this.stream_id,
                        &mut block,
                        u64::MAX,
                        &mut None,
                    );
                    if matches!(decoded, Ok(None))
                        && let Some((stream_id, instructions)) = this.reader.cancellation.take()
                    {
                        // The encoder still counts the section as blocked: it is abandoned
                        // (RFC 9204 section 2.2.2.2).
                        let mut out = Vec::new();
                        http3::qpack::stream_canceled(stream_id, &mut out);
                        let _ = instructions.send(out);
                    }
                    this.state = BodyState::Frames;
                }
                BodyState::Frames => match ready!(this.reader.poll_frame_header(cx)) {
                    Ok(None) => {
                        this.done = true;
                        if this.length.is_some_and(|n| n != this.received) {
                            return Poll::Ready(Some(Err(H3Error(
                                "HTTP/3 body ended before its content-length".into(),
                            ))));
                        }
                        return Poll::Ready(None);
                    }
                    Ok(Some((FRAME_DATA, length))) => this.state = BodyState::Data(length),
                    Ok(Some((FRAME_HEADERS, length))) => {
                        if length > 1 << 20 {
                            this.done = true;
                            return Poll::Ready(Some(Err(H3Error(
                                "HTTP/3 trailers too large".into(),
                            ))));
                        }
                        this.state = BodyState::Trailers(length as usize);
                    }
                    Ok(Some((kind, _))) if unexpected_on_request(kind) => {
                        this.done = true;
                        this.connection
                            .shared
                            .fail(H3_FRAME_UNEXPECTED, "unexpected frame on a request stream");
                        return Poll::Ready(Some(Err(H3Error(
                            "Unexpected HTTP/3 frame on a request stream".into(),
                        ))));
                    }
                    Ok(Some((_, length))) => this.state = BodyState::Skip(length),
                    Err(error) => {
                        this.done = true;
                        return Poll::Ready(Some(Err(error)));
                    }
                },
            }
        }
    }

    fn is_end_stream(&self) -> bool {
        self.done || (self.length == Some(0) && self.reader.finished())
    }

    fn size_hint(&self) -> SizeHint {
        match self.length {
            Some(n) => SizeHint::with_exact(n.saturating_sub(self.received)),
            None => SizeHint::default(),
        }
    }
}

/// How long a new QUIC connection may take before the request falls back to TCP.
pub(crate) fn handshake_timeout(connect_ms: u64) -> Duration {
    Duration::from_millis(connect_ms)
}

#[allow(dead_code)]
const _: (u32, u32) = (H3_GENERAL_PROTOCOL_ERROR, H3_MESSAGE_ERROR);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn priority_update_values_follow_quiche() {
        assert_eq!(priority_field_value(b"u=0, i").as_deref(), Some("u=0, i"));
        assert_eq!(priority_field_value(b"u=1").as_deref(), Some("u=1"));
        assert_eq!(priority_field_value(b"u=3"), None);
        assert_eq!(priority_field_value(b"i").as_deref(), Some("i"));
        assert_eq!(priority_field_value(b"u=9, i").as_deref(), Some("i"));
    }

    #[test]
    fn reserved_codepoints_are_greasy() {
        for random in [0, 1, u32::MAX, 1_569_328_592] {
            assert_eq!((reserved(random) - 0x21) % 0x1f, 0);
        }
        // The GREASE frame type Chrome 158 sent in a capture.
        assert_eq!(reserved(1_569_328_592), 0xb53b7ac51);
    }

    #[test]
    fn varints_round_trip() {
        for value in [
            0,
            63,
            64,
            16383,
            16384,
            (1 << 30) - 1,
            1 << 30,
            (1 << 62) - 1,
        ] {
            let mut out = Vec::new();
            put_varint(&mut out, value);
            assert_eq!(get_varint(&out), Some((value, out.len())));
        }
    }
}
