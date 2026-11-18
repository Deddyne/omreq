use crate::{
    admission::{Scheduler, Ticket},
    budget::{BufferBudget, BytePool},
    connections::Connections,
    cookies::CookieJar,
    error::{Error, Result, lock},
    profile::Profile,
    redirect::{self, Hop, Mode as RedirectMode},
};
use bytes::Bytes;
use futures_util::{Stream, StreamExt, stream};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    pin::Pin,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, AtomicU8, AtomicU64, AtomicUsize, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{Notify, mpsc};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use url::Url;
use wreq::{
    Body, Client, Method, Version,
    header::{HeaderMap, HeaderName, HeaderValue, OrigHeaderMap},
};

pub const CHUNK_BYTES: usize = 64 * 1024;
pub const BRIDGE_BYTES: usize = 256 * 1024;
/// Bodies of known length up to this size cross the bridge with the headers.
pub const INLINE_BYTES: usize = 64 * 1024;
type ByteStream = Pin<Box<dyn Stream<Item = std::result::Result<Bytes, wreq::Error>> + Send>>;
type UploadMessage = Result<Option<Bytes>>;
type UploadDemand = (mpsc::Sender<u32>, Mutex<Option<mpsc::Receiver<u32>>>);
/// Origin of an already WHATWG-normalized absolute URL, without a full parse.
/// Returns None for anything unusual; the caller then parses the URL. execute()
/// re-parses the URL and rejects an operation whose origin differs from this.
fn normalized_origin(input: &str) -> Option<&str> {
    let (start, default_port) = if input.starts_with("https://") {
        (8, "443")
    } else if input.starts_with("http://") {
        (7, "80")
    } else {
        return None;
    };
    let end = input[start..]
        .find(['/', '?', '#'])
        .map_or(input.len(), |i| i + start);
    let authority = &input[start..end];
    let plain = authority.bytes().all(|b| {
        b.is_ascii_lowercase()
            || b.is_ascii_digit()
            || matches!(b, b'.' | b'-' | b':' | b'[' | b']')
    });
    if authority.is_empty() || !plain {
        return None;
    }
    let (host, port) = if let Some(rest) = authority.strip_prefix('[') {
        // Only an IPv6 literal already in its canonical serialization (which
        // the URL parser would produce unchanged) skips the parser.
        let (inner, after) = rest.split_once(']')?;
        if inner.contains('.') || inner.parse::<std::net::Ipv6Addr>().ok()?.to_string() != inner {
            return None;
        }
        let port = match after {
            "" => None,
            after => Some(after.strip_prefix(':')?),
        };
        (&authority[..inner.len() + 2], port)
    } else if authority.contains(['[', ']']) {
        return None;
    } else {
        match authority.split_once(':') {
            Some((host, port)) => (host, Some(port)),
            None => (authority, None),
        }
    };
    // A port must already be canonical: digits without leading zeros, in
    // range, and not the scheme default (which the parser removes).
    if let Some(port) = port
        && (port.is_empty()
            || port.starts_with('0')
            || !port.bytes().all(|b| b.is_ascii_digit())
            || port.parse::<u16>().is_err()
            || port == default_port)
    {
        return None;
    }
    if host.is_empty() {
        return None;
    }
    // Numeric-looking hosts can be IPv4 shorthand (0x7f.1, 127.1); leave
    // those to the parser unless they are four plain decimal octets.
    // WHATWG treats a host whose last label is a number (decimal or 0x hex) as
    // IPv4 and normalizes it; only canonical dotted quads skip the parser.
    let last = host.trim_end_matches('.').rsplit('.').next().unwrap_or("");
    let numeric = !host.starts_with('[')
        && (last.starts_with("0x")
            || (!last.is_empty() && last.bytes().all(|b| b.is_ascii_digit())));
    let dotted_quad = host.split('.').count() == 4
        && host.split('.').all(|o| {
            !o.is_empty()
                && o.len() <= 3
                && (o == "0" || !o.starts_with('0'))
                && o.parse::<u8>().is_ok()
        });
    if numeric && !dotted_quad {
        return None;
    }
    Some(&input[..end])
}
fn request_origin(input: &str, http2_only: bool) -> Result<String> {
    if let Some(origin) = normalized_origin(input)
        && (!http2_only || origin.starts_with("https://"))
    {
        return Ok(origin.to_owned());
    }
    let url = Url::parse(input).map_err(|_| {
        Error::new(
            "ERR_INVALID_ARGUMENT",
            "configuration",
            "Invalid request URL",
        )
    })?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none()
        || (http2_only && url.scheme() != "https")
    {
        return Err(Error::new(
            "ERR_INVALID_ARGUMENT",
            "configuration",
            "Only supported HTTP(S) origins without credentials are allowed",
        ));
    }
    Ok(url.origin().ascii_serialization())
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientConfig {
    pub max_active_operations: usize,
    pub max_queued_operations: usize,
    pub max_active_per_origin: usize,
    pub max_connections: usize,
    pub max_connections_per_origin: usize,
    pub max_aggregate_buffered_response_bytes: usize,
    pub connect_ms: u64,
    pub ca: Option<String>,
    pub trust_store: Option<String>,
    #[serde(default = "enabled")]
    pub cookies: bool,
    /// Proxies in match order; the first one whose scope and no-proxy list
    /// accept a target carries it. Empty means direct connections only.
    #[serde(default)]
    pub proxies: Vec<ProxyConfig>,
    /// Fixed addresses per lowercase host name, bypassing DNS (like curl
    /// --resolve). The port always comes from the URL.
    #[serde(default)]
    pub resolve: std::collections::BTreeMap<String, Vec<std::net::IpAddr>>,
}
/// One proxy route. `scope` selects target schemes (`all`, `http`, `https`);
/// `url` is `http`, `https`, `socks4`, `socks4a`, `socks5` or `socks5h`,
/// optionally with `user:password@` credentials.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProxyConfig {
    pub scope: String,
    pub url: String,
    #[serde(default)]
    pub no_proxy: Option<String>,
}
impl ProxyConfig {
    fn build(&self) -> Result<wreq::Proxy> {
        let invalid = || {
            Error::new(
                "ERR_INVALID_ARGUMENT",
                "configuration",
                "proxy: expected an http, https, socks4, socks4a, socks5 or socks5h URL",
            )
        };
        let parsed = url::Url::parse(&self.url).map_err(|_| invalid())?;
        if !matches!(
            parsed.scheme(),
            "http" | "https" | "socks4" | "socks4a" | "socks5" | "socks5h"
        ) || parsed.host_str().is_none_or(str::is_empty)
        {
            return Err(invalid());
        }
        let proxy = match self.scope.as_str() {
            "all" => wreq::Proxy::all(self.url.as_str()),
            "http" => wreq::Proxy::http(self.url.as_str()),
            "https" => wreq::Proxy::https(self.url.as_str()),
            _ => return Err(invalid()),
        }
        .map_err(|_| invalid())?;
        Ok(proxy.no_proxy(
            self.no_proxy
                .as_deref()
                .and_then(wreq::NoProxy::from_string),
        ))
    }
}
fn enabled() -> bool {
    true
}
fn cookie_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .min(i64::MAX as u64) as i64
}
impl ClientConfig {
    fn validate(&self) -> Result<()> {
        if self.max_active_operations == 0
            || self.max_active_operations > 1024
            || self.max_queued_operations > 4096
            || self.max_active_per_origin == 0
            || self.max_active_per_origin > 1024
            || self.max_connections == 0
            || self.max_connections > 4096
            || self.max_connections_per_origin == 0
            || self.max_connections_per_origin > 1024
            || self.max_aggregate_buffered_response_bytes == 0
            || self.max_aggregate_buffered_response_bytes > 2147483647
            || self.connect_ms == 0
            || self.connect_ms > 2147483647
        {
            return Err(Error::new(
                "ERR_INVALID_ARGUMENT",
                "configuration",
                "Invalid client limits",
            ));
        }
        Ok(())
    }
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestConfig {
    pub url: String,
    pub method: String,
    pub headers: Vec<(String, String)>,
    #[serde(default)]
    pub header_overrides: Vec<String>,
    pub streaming: bool,
    #[serde(default)]
    pub replayable: bool,
    #[serde(default)]
    pub body_length: Option<u64>,
    pub queue_ms: u64,
    pub hop_queue_ms: u64,
    pub headers_ms: u64,
    pub upload_idle_ms: u64,
    pub body_idle_ms: u64,
    pub consumer_idle_ms: Option<u64>,
    pub total_ms: Option<u64>,
    pub max_response_bytes: Option<u64>,
    #[serde(default)]
    pub redirect: RedirectMode,
    #[serde(default = "redirect::default_limit")]
    pub max_redirects: usize,
    #[serde(default)]
    pub allow_insecure_redirects: bool,
    #[serde(default)]
    pub sensitive_headers: Vec<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseMeta {
    pub status: u16,
    pub url: String,
    pub http_version: String,
    pub headers: Vec<(String, String)>,
    pub redirects: Vec<Hop>,
}
#[derive(Default)]
struct Counters {
    tasks: AtomicUsize,
    completed: AtomicU64,
    aborted: AtomicU64,
    timed_out: AtomicU64,
}
struct ClientInner {
    http1_profile: Arc<crate::profile_headers::Http1Profile>,
    http2_only: bool,
    transport: Mutex<Option<Client>>,
    operations: Mutex<HashMap<u64, Arc<Operation>>>,
    scheduler: Arc<Scheduler>,
    buffered: Arc<BytePool>,
    connections: Connections,
    cookies: Mutex<Option<CookieJar>>,
    closed: AtomicBool,
    next_id: AtomicU64,
    config: ClientConfig,
    counters: Counters,
    // Woken whenever a native task ends; close() waits on it instead of polling.
    drained: Notify,
}
pub struct CoreClient {
    inner: Arc<ClientInner>,
}
#[derive(Default)]
struct Lifecycle {
    tasks: usize,
    stop_prepared: bool,
    cleaned: bool,
}
struct Activity {
    owner: Arc<ClientInner>,
    operation: Arc<Operation>,
}
impl Activity {
    fn new(inner: &Arc<ClientInner>, operation: &Arc<Operation>) -> Result<Self> {
        let mut lifecycle = lock(&operation.lifecycle);
        if operation.terminal.load(Ordering::SeqCst) {
            drop(lifecycle);
            return Err(operation.error());
        }
        lifecycle.tasks += 1;
        inner.counters.tasks.fetch_add(1, Ordering::SeqCst);
        Ok(Self {
            owner: inner.clone(),
            operation: operation.clone(),
        })
    }
}
impl Drop for Activity {
    fn drop(&mut self) {
        {
            let mut lifecycle = lock(&self.operation.lifecycle);
            lifecycle.tasks = lifecycle.tasks.saturating_sub(1);
        }
        self.operation.try_cleanup();
        if self.owner.counters.tasks.fetch_sub(1, Ordering::SeqCst) == 1 {
            self.owner.drained.notify_waiters();
        }
    }
}
struct Download {
    stream: ByteStream,
    pending: Bytes,
    received: u64,
    // Exact body length announced by the transport, if any.
    length: Option<u64>,
    // Error observed while collecting an inline body; reported after `pending`.
    deferred: Option<Error>,
}
/// Response headers plus, for small bodies of known length, the whole body.
/// `body` is `Some` only when the operation already reached EOF and finished.
pub struct Executed {
    pub meta: ResponseMeta,
    pub body: Option<Vec<u8>>,
}
/// How far the transport has taken a request body. The send deadline in
/// `execute_inner` reads it from the request task, so it keeps running even
/// when the transport stops polling the body (blocked HTTP/1 write, exhausted
/// HTTP/2 window, a stream waiting for MAX_CONCURRENT_STREAMS).
struct SendProgress {
    base: Instant,
    // Milliseconds after `base` of the first poll or the latest frame handed
    // to the transport; NEVER_POLLED until the transport first asks for data.
    last: AtomicU64,
    // Cancelled once the whole body was handed to the transport (or the hop
    // ended); the headers timer starts then.
    done: CancellationToken,
}
const NEVER_POLLED: u64 = u64::MAX;
impl SendProgress {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            base: Instant::now(),
            last: AtomicU64::new(NEVER_POLLED),
            done: CancellationToken::new(),
        })
    }
    fn now(&self) -> u64 {
        self.base
            .elapsed()
            .as_millis()
            .min(u128::from(NEVER_POLLED - 1)) as u64
    }
    /// The transport asked for body data. Only the first poll counts: a
    /// connection task also re-polls the body on unrelated wakeups.
    fn polled(&self) {
        let _ = self.last.compare_exchange(
            NEVER_POLLED,
            self.now(),
            Ordering::SeqCst,
            Ordering::SeqCst,
        );
    }
    /// The transport accepted a frame.
    fn advanced(&self) {
        self.last.store(self.now(), Ordering::SeqCst);
    }
    /// Until the transport polls the body the request is still connecting or
    /// waiting for a stream, bounded like header waiting; afterwards each gap
    /// between frames is bounded by the upload idle timeout.
    fn deadline(&self, headers_ms: u64, idle_ms: u64) -> (Instant, &'static str) {
        match self.last.load(Ordering::SeqCst) {
            NEVER_POLLED => (self.base + Duration::from_millis(headers_ms), "headers"),
            last => (
                self.base + Duration::from_millis(last.saturating_add(idle_ms)),
                "upload",
            ),
        }
    }
}
/// Resolves with the timeout phase once the request must fail: the send
/// watchdog while the body is in flight, then `headers_ms` after the body was
/// fully handed to the transport.
async fn send_deadline(
    progress: Option<Arc<SendProgress>>,
    headers_ms: u64,
    idle_ms: u64,
) -> &'static str {
    if let Some(progress) = progress {
        loop {
            let (deadline, _) = progress.deadline(headers_ms, idle_ms);
            tokio::select! { biased;
                _ = progress.done.cancelled() => break,
                _ = tokio::time::sleep_until(deadline) => {}
            }
            if progress.done.is_cancelled() {
                break;
            }
            // Progress may have moved the deadline while this task slept.
            let (deadline, phase) = progress.deadline(headers_ms, idle_ms);
            if Instant::now() >= deadline {
                return phase;
            }
        }
    }
    tokio::time::sleep(Duration::from_millis(headers_ms)).await;
    "headers"
}
struct UploadHop {
    epoch: u32,
    stop: CancellationToken,
    progress: Arc<SendProgress>,
    // The JavaScript source delivered its end of stream.
    eof: AtomicBool,
    // The transport received the whole body.
    complete: AtomicBool,
    // A body cut short by an early response fails its transport frame (HTTP/1
    // close, HTTP/2 RST_STREAM) instead of ending cleanly, so the server never
    // mistakes a truncated body for a complete one. It waits for this token
    // first, letting the early response itself still be read in full. It is a
    // child of the operation token, so finishing the operation releases it.
    abort: CancellationToken,
    sender: mpsc::Sender<UploadMessage>,
    bytes: AtomicUsize,
}
impl UploadHop {
    fn is_complete(&self) -> bool {
        self.complete.load(Ordering::SeqCst)
    }
}
// Transport receives an exact byte hint for immutable Blob/multipart sources.
// The wrapper enforces that hint and owns its transport-side upload task until
// the body is dropped, including after an early response or request cancellation.
struct UploadBody {
    inner: Body,
    remaining: Option<u64>,
    hop: Arc<UploadHop>,
    truncated: bool,
    abort: Pin<Box<tokio_util::sync::WaitForCancellationFutureOwned>>,
    activity: Activity,
}
impl UploadBody {
    fn complete(&self) {
        self.hop.complete.store(true, Ordering::SeqCst);
        self.hop.progress.done.cancel();
    }
    fn accept(
        &mut self,
        frame: http_body::Frame<Bytes>,
    ) -> std::task::Poll<Option<Result<http_body::Frame<Bytes>>>> {
        if let (Some(remaining), Some(bytes)) = (self.remaining, frame.data_ref()) {
            let Some(left) = remaining.checked_sub(bytes.len() as u64) else {
                let error = Error::new(
                    "ERR_UPLOAD_SOURCE",
                    "upload",
                    "Upload exceeds its declared length",
                );
                self.activity.operation.finish(Some(error.clone()));
                return std::task::Poll::Ready(Some(Err(error)));
            };
            self.remaining = Some(left);
            if left == 0 {
                self.complete();
            }
        }
        self.hop.progress.advanced();
        std::task::Poll::Ready(Some(Ok(frame)))
    }
}
impl http_body::Body for UploadBody {
    type Data = Bytes;
    type Error = Error;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Result<http_body::Frame<Bytes>>>> {
        use std::future::Future;
        use std::task::Poll;
        let this = &mut *self;
        this.hop.progress.polled();
        if !this.truncated {
            match Pin::new(&mut this.inner).poll_frame(cx) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(Some(Ok(frame))) => return this.accept(frame),
                Poll::Ready(Some(Err(error))) => {
                    return Poll::Ready(Some(Err(Error::transport(error, "upload"))));
                }
                Poll::Ready(None) if this.hop.eof.load(Ordering::SeqCst) => {
                    if this.remaining.is_some_and(|n| n != 0) {
                        let error = Error::new(
                            "ERR_UPLOAD_SOURCE",
                            "upload",
                            "Upload ended before its declared length",
                        );
                        this.activity.operation.finish(Some(error.clone()));
                        return Poll::Ready(Some(Err(error)));
                    }
                    this.complete();
                    return Poll::Ready(None);
                }
                // The hop stopped before its source ended.
                Poll::Ready(None) => {
                    this.truncated = true;
                    this.hop.progress.done.cancel();
                }
            }
        }
        match this.abort.as_mut().poll(cx) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(()) => Poll::Ready(Some(Err(Error::new(
                "ERR_ABORTED",
                "upload",
                "Request body was cut short before its end",
            )))),
        }
    }
    fn size_hint(&self) -> http_body::SizeHint {
        self.remaining
            .map(http_body::SizeHint::with_exact)
            .unwrap_or_default()
    }
    fn is_end_stream(&self) -> bool {
        self.remaining == Some(0)
    }
}
impl Drop for UploadBody {
    fn drop(&mut self) {
        self.hop.stop.cancel();
    }
}
/// A materialized request body handed to the transport in 64 KiB frames, so
/// the headers timer starts only after the transport accepted the last frame
/// rather than as soon as the whole buffer is queued. Frames share the native
/// snapshot without copying.
struct ReplayBody {
    bytes: Bytes,
    progress: Arc<SendProgress>,
}
impl http_body::Body for ReplayBody {
    type Data = Bytes;
    type Error = std::convert::Infallible;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<std::result::Result<http_body::Frame<Bytes>, Self::Error>>> {
        let this = &mut *self;
        this.progress.polled();
        if this.bytes.is_empty() {
            this.progress.done.cancel();
            return std::task::Poll::Ready(None);
        }
        let frame = this.bytes.split_to(this.bytes.len().min(CHUNK_BYTES));
        this.progress.advanced();
        if this.bytes.is_empty() {
            this.progress.done.cancel();
        }
        std::task::Poll::Ready(Some(Ok(http_body::Frame::data(frame))))
    }
    fn size_hint(&self) -> http_body::SizeHint {
        http_body::SizeHint::with_exact(self.bytes.len() as u64)
    }
    fn is_end_stream(&self) -> bool {
        self.bytes.is_empty()
    }
}
/// One header policy shared by every hop of an operation.
struct SharedHeaderPolicy(Arc<crate::profile_headers::HeaderPolicy>);
impl wreq_proto::ext::OnPreserveHeaderCallback for SharedHeaderPolicy {
    fn call(&self, headers: &mut HeaderMap) {
        self.0.call(headers);
    }
    fn call_visit(
        &self,
        headers: &mut HeaderMap,
        dst: &mut dyn FnMut(&dyn AsRef<[u8]>, &HeaderValue),
    ) {
        self.0.call_visit(headers, dst);
    }
}
#[derive(Clone, Copy)]
struct ReadLimits {
    body_idle_ms: u64,
    max_response_bytes: Option<u64>,
}
const PHASE_QUEUE: u8 = 0;
const PHASE_HEADERS: u8 = 1;
const PHASE_BODY: u8 = 2;
/// Small intermediate redirect bodies are read to their end so an HTTP/1
/// connection can return to the pool.
const REDIRECT_DRAIN_BYTES: u64 = 64 * 1024;
const REDIRECT_DRAIN_MS: u64 = 250;
pub struct Operation {
    pub id: u64,
    opened_at: Instant,
    owner: Weak<ClientInner>,
    token: CancellationToken,
    cleaned: CancellationToken,
    lifecycle: Mutex<Lifecycle>,
    upload_stop: CancellationToken,
    terminal: AtomicBool,
    reason: Mutex<Option<Error>>,
    ticket: Ticket,
    initial_origin: String,
    download: Mutex<Option<Download>>,
    reading: AtomicBool,
    consumer_epoch: AtomicU64,
    consumer_notify: Notify,
    headers_ready: AtomicBool,
    upload_hop: Mutex<Option<Arc<UploadHop>>>,
    // Upload demand channel, created on first use: most requests never upload.
    demand: std::sync::OnceLock<UploadDemand>,
    credit: AtomicU64,
    download_bytes: AtomicUsize,
    // Only the fields reads need; the request config itself is not retained.
    limits: std::sync::OnceLock<ReadLimits>,
    started: AtomicBool,
    // PHASE_*: where the operation is, for the total deadline's error phase.
    phase: AtomicU8,
    // Set when the final response arrived before a streaming upload ended.
    upload_error: std::sync::OnceLock<Error>,
}
impl CoreClient {
    pub fn new(profile: &Profile, config: ClientConfig) -> Result<Self> {
        config.validate()?;
        let store = config.trust_store.as_deref().unwrap_or("bundled");
        // Without extra CAs the parsed bundle is shared process-wide (L-10).
        let roots = match &config.ca {
            None => crate::profile_tls::bundled_roots(store),
            Some(ca) => crate::profile_tls::trust_roots(store, ca),
        }
        .ok_or_else(|| {
            Error::new(
                "ERR_INVALID_ARGUMENT",
                "configuration",
                "Unknown trust store",
            )
        })??;
        let mut emulation = profile.emulation()?;
        // Header layers are normalized in TypeScript; no transport defaults may restore a removed group.
        emulation.headers.clear();
        // Bound the HTTP/1 parser/read buffer before transport frames reach the
        // bridge. An ordinary large response must not fail merely because the
        // adaptive upstream buffer grew beyond the bridge's retained-byte cap.
        let http1 = emulation.http1_options.get_or_insert_default();
        http1.h1_max_buf_size = Some(BRIDGE_BYTES);
        http1.h1_read_buf_exact_size = None;
        let scheduler = Scheduler::new(
            config.max_active_operations,
            config.max_queued_operations,
            config.max_active_per_origin,
        );
        let connections = Connections::new(
            config.max_connections,
            config.max_connections_per_origin,
            config.max_active_operations,
            Some(scheduler.clone()),
        );
        let mut builder = Client::builder()
            .emulation(emulation)
            .socket_observer(Arc::new(connections.clone()))
            // Environment and system proxies are never applied implicitly.
            .no_proxy()
            .retry(wreq::retry::Policy::never())
            .retry_canceled_requests(false)
            .redirect(wreq::redirect::Policy::none())
            .tls_cert_store(roots)
            .tls_cert_verification(true)
            .tls_verify_hostname(true)
            .connect_timeout(Duration::from_millis(config.connect_ms))
            // Keep every per-origin connection reusable. A smaller idle cap
            // closes sockets between back-to-back requests whenever more than
            // that many run in parallel, forcing fresh TCP/TLS handshakes and
            // exhausting ephemeral ports under sustained load. Idle sockets
            // still hold TCP capacity; Connections evicts them on demand.
            .pool_max_idle_per_host(config.max_connections_per_origin)
            .pool_max_size(config.max_connections)
            .pool_idle_timeout(Duration::from_secs(30));
        for proxy in &config.proxies {
            builder = builder.proxy(proxy.build()?);
        }
        for (host, addrs) in &config.resolve {
            if host.is_empty() || addrs.is_empty() || addrs.len() > 32 {
                return Err(Error::new(
                    "ERR_INVALID_ARGUMENT",
                    "configuration",
                    "resolve: expected 1 to 32 addresses per host",
                ));
            }
            builder = builder.resolve_to_addrs(
                host.clone(),
                addrs.iter().map(|ip| std::net::SocketAddr::new(*ip, 0)),
            );
        }
        match profile.effective["transport"]["httpVersion"].as_str() {
            Some("1.1") => builder = builder.http1_only(),
            // HTTP/2 prior knowledge is forbidden for plain HTTP; execute checks the URL.
            Some("2") => builder = builder.http2_only(),
            _ => {}
        }
        // Profiles are validated before this point; a build failure means the
        // TLS backend rejected the profile's configuration.
        let transport = builder.build().map_err(|_| {
            Error::new(
                "ERR_PROFILE_UNSUPPORTED",
                "initialization",
                "The native TLS backend rejected the profile configuration",
            )
        })?;
        Ok(Self {
            inner: Arc::new(ClientInner {
                http1_profile: Arc::new(crate::profile_headers::Http1Profile::new(
                    &profile.effective["transport"]["http1"],
                )),
                http2_only: profile.effective["transport"]["httpVersion"] == "2",
                transport: Mutex::new(Some(transport)),
                operations: Mutex::new(HashMap::new()),
                scheduler,
                buffered: BytePool::new(config.max_aggregate_buffered_response_bytes),
                connections,
                cookies: Mutex::new(config.cookies.then(CookieJar::new)),
                closed: AtomicBool::new(false),
                next_id: AtomicU64::new(1),
                config,
                counters: Counters::default(),
                drained: Notify::new(),
            }),
        })
    }
    pub fn open(&self, url: &str) -> Result<Arc<Operation>> {
        let id = self.inner.next_id.fetch_add(1, Ordering::SeqCst);
        self.open_with_id(id, url)
    }
    /// Registers an operation under an identifier chosen by the caller, which
    /// must be unique for this client.
    pub fn open_with_id(&self, id: u64, url: &str) -> Result<Arc<Operation>> {
        let initial_origin = request_origin(url, self.inner.http2_only)?;
        let mut operations = lock(&self.inner.operations);
        if self.inner.closed.load(Ordering::SeqCst) {
            return Err(Error::new("ERR_CLIENT_CLOSED", "queue", "Client is closed"));
        }
        if operations.len()
            >= self.inner.config.max_active_operations + self.inner.config.max_queued_operations
        {
            return Err(Error::new(
                "ERR_QUEUE_FULL",
                "queue",
                "Operation queue is full",
            ));
        }
        if id == 0 || id > 9007199254740991 {
            return Err(Error::new(
                "ERR_RESOURCE_LIMIT",
                "queue",
                "Operation identifier exhausted",
            ));
        }
        if operations.contains_key(&id) {
            return Err(Error::new(
                "ERR_INVALID_ARGUMENT",
                "queue",
                "Duplicate operation identifier",
            ));
        }
        let ticket = self.inner.scheduler.register(id, initial_origin.clone())?;
        let op = Arc::new(Operation {
            id,
            opened_at: Instant::now(),
            owner: Arc::downgrade(&self.inner),
            token: CancellationToken::new(),
            cleaned: CancellationToken::new(),
            lifecycle: Mutex::new(Lifecycle::default()),
            upload_stop: CancellationToken::new(),
            terminal: AtomicBool::new(false),
            reason: Mutex::new(None),
            ticket,
            initial_origin,
            download: Mutex::new(None),
            reading: AtomicBool::new(false),
            consumer_epoch: AtomicU64::new(0),
            consumer_notify: Notify::new(),
            headers_ready: AtomicBool::new(false),
            upload_hop: Mutex::new(None),
            demand: std::sync::OnceLock::new(),
            credit: AtomicU64::new(0),
            download_bytes: AtomicUsize::new(0),
            limits: std::sync::OnceLock::new(),
            started: AtomicBool::new(false),
            phase: AtomicU8::new(PHASE_QUEUE),
            upload_error: std::sync::OnceLock::new(),
        });
        operations.insert(id, op.clone());
        Ok(op)
    }
    /// A live operation by identifier; None once it has been cleaned up.
    pub fn operation(&self, id: u64) -> Option<Arc<Operation>> {
        lock(&self.inner.operations).get(&id).cloned()
    }
    pub fn stats(&self) -> Value {
        let operations = lock(&self.inner.operations);
        let admission = self.inner.scheduler.stats();
        let connections = self.inner.connections.stats();
        let cookies = lock(&self.inner.cookies)
            .as_mut()
            .map(|jar| jar.stats(cookie_now()))
            .unwrap_or_default();
        json!({"activeOperations":admission["activeOperations"], "queuedOperations":admission["queuedOperations"],
            "bufferedResponseBytes":self.inner.buffered.used(),
            "bufferedResponseLimitBytes":self.inner.config.max_aggregate_buffered_response_bytes,
            "originWaitOperations":admission["originWaitOperations"], "origins":admission["origins"],
            "admissionLimits":{"maxActiveOperations":self.inner.config.max_active_operations,
                "maxQueuedOperations":self.inner.config.max_queued_operations,"maxActivePerOrigin":self.inner.config.max_active_per_origin},
            "openBodies":operations.values().filter(|o| o.headers_ready.load(Ordering::SeqCst)).count(),
            "uploadBridgeBytes":operations.values().map(|o| lock(&o.upload_hop).as_ref().map_or(0, |h| h.bytes.load(Ordering::SeqCst))).sum::<usize>(),
            "downloadBridgeBytes":operations.values().map(|o| o.download_bytes.load(Ordering::SeqCst)).sum::<usize>(),
            "nativeTasks":self.inner.counters.tasks.load(Ordering::SeqCst),
            "completed":self.inner.counters.completed.load(Ordering::SeqCst),
            "aborted":self.inner.counters.aborted.load(Ordering::SeqCst),
            "timedOut":self.inner.counters.timed_out.load(Ordering::SeqCst),
            "cookieCount":cookies.cookie_count,"cookieBytes":cookies.cookie_bytes,
            "discardedCookies":cookies.discarded_cookies,"partitionedCookies":cookies.partitioned_cookies,
            "evictedCookies":cookies.evicted_cookies,
            "connections":connections["connections"],"creatingConnections":connections["creatingConnections"],
            "waitingConnections":connections["waitingConnections"],"connectionOrigins":connections["connectionOrigins"],
            "connectionLimits":{"maxConnections":self.inner.config.max_connections,"maxConnectionsPerOrigin":self.inner.config.max_connections_per_origin},
            "idleConnections":if connections["connections"] == 0 { json!(0) } else { Value::Null },
            "connectionAccounting":"physical TCP sockets/attempts bounded; idle lifecycle unavailable"})
    }
    pub fn buffer_budget(&self) -> Result<BufferBudget> {
        if self.inner.closed.load(Ordering::SeqCst) {
            return Err(Error::new("ERR_CLIENT_CLOSED", "body", "Client is closed"));
        }
        Ok(self.inner.buffered.lease())
    }
    fn cookie_access(&self, f: impl FnOnce(&mut CookieJar) -> Result<Value>) -> Result<Value> {
        let mut cookies = lock(&self.inner.cookies);
        if self.inner.closed.load(Ordering::SeqCst) {
            return Err(Error::new(
                "ERR_CLIENT_CLOSED",
                "configuration",
                "Client is closed",
            ));
        }
        let jar = cookies.as_mut().ok_or_else(|| {
            Error::new(
                "ERR_INVALID_ARGUMENT",
                "configuration",
                "Cookies are disabled for this client",
            )
        })?;
        f(jar)
    }
    pub fn set_cookie(&self, value: &str, url: &str) -> Result<()> {
        request_origin(url, false)?;
        let url = Url::parse(url).map_err(|_| {
            Error::new(
                "ERR_INVALID_ARGUMENT",
                "configuration",
                "Invalid cookie URL",
            )
        })?;
        self.cookie_access(|jar| {
            jar.set_cookie(value, &url, cookie_now())?;
            Ok(Value::Null)
        })
        .map(|_| ())
    }
    pub fn get_cookies(&self, url: &str) -> Result<Value> {
        request_origin(url, false)?;
        let url = Url::parse(url).map_err(|_| {
            Error::new(
                "ERR_INVALID_ARGUMENT",
                "configuration",
                "Invalid cookie URL",
            )
        })?;
        self.cookie_access(|jar| Ok(json!(jar.get_cookies(&url, cookie_now())?)))
    }
    pub fn clear_cookies(&self) -> Result<()> {
        self.cookie_access(|jar| {
            jar.clear();
            Ok(Value::Null)
        })
        .map(|_| ())
    }
    pub async fn close(&self) -> Result<()> {
        let operations = {
            let operations = lock(&self.inner.operations);
            self.inner.closed.store(true, Ordering::SeqCst);
            operations.values().cloned().collect::<Vec<_>>()
        };
        self.inner.scheduler.stop();
        if let Some(jar) = lock(&self.inner.cookies).as_mut() {
            jar.clear();
        }
        for op in operations {
            op.cancel("ERR_CLIENT_CLOSED");
        }
        self.inner.connections.close();
        lock(&self.inner.transport).take();
        // Every counter below signals its own Notify when it drops, so close()
        // completes as soon as the last task, buffer or socket is gone.
        let wait = async {
            loop {
                let tasks = self.inner.drained.notified();
                let buffers = self.inner.buffered.drained();
                let sockets = self.inner.connections.drained();
                tokio::pin!(tasks, buffers, sockets);
                tasks.as_mut().enable();
                buffers.as_mut().enable();
                sockets.as_mut().enable();
                if self.inner.counters.tasks.load(Ordering::SeqCst) == 0
                    && self.inner.buffered.used() == 0
                    && self.inner.connections.is_empty()
                {
                    break;
                }
                // Queued socket reservations release capacity without a
                // record; a short tick covers them.
                tokio::select! {
                    _ = tasks => {}, _ = buffers => {}, _ = sockets => {},
                    _ = tokio::time::sleep(Duration::from_millis(5)) => {}
                }
            }
        };
        tokio::time::timeout(Duration::from_secs(5), wait)
            .await
            .map_err(|_| {
                Error::new(
                    "ERR_SHUTDOWN_TIMEOUT",
                    "shutdown",
                    "Native tasks did not stop before the cleanup deadline",
                )
            })
    }
}
impl Drop for CoreClient {
    fn drop(&mut self) {
        // CoreClient clones are not used as per-operation owners. Last public owner closes synchronously.
        {
            self.inner.closed.store(true, Ordering::SeqCst);
            self.inner.scheduler.stop();
            if let Some(jar) = lock(&self.inner.cookies).as_mut() {
                jar.clear();
            }
            let ops = lock(&self.inner.operations)
                .values()
                .cloned()
                .collect::<Vec<_>>();
            for op in ops {
                op.cancel("ERR_CLIENT_CLOSED");
            }
            self.inner.connections.close();
        }
    }
}
impl Operation {
    fn error(&self) -> Error {
        lock(&self.reason).clone().unwrap_or_else(|| {
            Error::new(
                "ERR_BODY_DISPOSED",
                "body",
                "Operation is no longer available",
            )
        })
    }
    fn finish(&self, error: Option<Error>) {
        self.finish_scoped(error, None);
    }
    fn finish_scoped(&self, error: Option<Error>, upload_epoch: Option<u32>) -> bool {
        let mut reason = lock(&self.reason);
        let upload = upload_epoch.map(|_| lock(&self.upload_hop));
        if let Some(epoch) = upload_epoch
            && !upload
                .as_ref()
                .and_then(|h| h.as_ref())
                .is_some_and(|h| h.epoch == epoch && !h.stop.is_cancelled())
        {
            return false;
        }
        if self.terminal.swap(true, Ordering::SeqCst) {
            return false;
        }
        *reason = error.clone();
        drop(upload);
        drop(reason);
        self.token.cancel();
        self.stop_upload();
        lock(&self.download).take();
        self.download_bytes.store(0, Ordering::SeqCst);
        if let Some(owner) = self.owner.upgrade() {
            if let Some(e) = error {
                if e.code == "ERR_ABORTED" {
                    owner.counters.aborted.fetch_add(1, Ordering::SeqCst);
                }
                if e.code == "ERR_TIMEOUT" {
                    owner.counters.timed_out.fetch_add(1, Ordering::SeqCst);
                }
            } else {
                owner.counters.completed.fetch_add(1, Ordering::SeqCst);
            }
        }
        lock(&self.lifecycle).stop_prepared = true;
        self.try_cleanup();
        true
    }
    fn try_cleanup(&self) {
        {
            let mut lifecycle = lock(&self.lifecycle);
            if !lifecycle.stop_prepared || lifecycle.tasks != 0 || lifecycle.cleaned {
                return;
            }
            lifecycle.cleaned = true;
        }
        self.ticket.cancel();
        if let Some(owner) = self.owner.upgrade() {
            lock(&owner.operations).remove(&self.id);
        }
        self.cleaned.cancel();
    }
    pub fn cancel(&self, code: &str) {
        let (code, phase) = match code {
            "ERR_ABORTED" => ("ERR_ABORTED", "body"),
            "ERR_CLIENT_CLOSED" => ("ERR_CLIENT_CLOSED", "body"),
            "ERR_UPLOAD_SOURCE" => ("ERR_UPLOAD_SOURCE", "upload"),
            "ERR_RESOURCE_LIMIT" => ("ERR_RESOURCE_LIMIT", "upload"),
            _ => ("ERR_BODY_DISPOSED", "body"),
        };
        self.finish(Some(Error::new(code, phase, "Operation was cancelled")));
    }
    fn timeout(&self, phase: &str) -> Error {
        let error = Error::new("ERR_TIMEOUT", phase, "Operation deadline expired");
        self.finish(Some(error));
        self.error()
    }
    fn phase_name(&self) -> &'static str {
        match self.phase.load(Ordering::SeqCst) {
            PHASE_QUEUE => "queue",
            PHASE_HEADERS => "headers",
            _ => "body",
        }
    }
    #[cfg(test)]
    async fn execute(
        self: &Arc<Self>,
        config: RequestConfig,
        body: Option<Vec<u8>>,
    ) -> Result<Executed> {
        self.execute_prepared(|| Ok((config, body))).await
    }
    fn demand(&self) -> &UploadDemand {
        self.demand.get_or_init(|| {
            let (sender, receiver) = mpsc::channel(1);
            (sender, Mutex::new(Some(receiver)))
        })
    }
    /// True once the operation released its admission slot and all native work.
    pub fn is_cleaned(&self) -> bool {
        self.cleaned.is_cancelled()
    }
    pub async fn execute_prepared<F>(self: &Arc<Self>, prepare: F) -> Result<Executed>
    where
        F: FnOnce() -> Result<(RequestConfig, Option<Vec<u8>>)>,
    {
        let owner = self.owner.upgrade().ok_or_else(|| self.error())?;
        let _activity = Activity::new(&owner, self)?;
        if self.started.swap(true, Ordering::SeqCst) {
            return Err(Error::new(
                "ERR_INVALID_ARGUMENT",
                "configuration",
                "Operation already started",
            ));
        }
        let result = match prepare() {
            Ok((config, body)) => self.execute_inner(owner, config, body).await,
            Err(error) => Err(error),
        };
        if let Err(e) = &result {
            self.finish(Some(e.clone()));
            return Err(self.error());
        }
        result
    }
    async fn execute_inner(
        self: &Arc<Self>,
        owner: Arc<ClientInner>,
        config: RequestConfig,
        body: Option<Vec<u8>>,
    ) -> Result<Executed> {
        if self.terminal.load(Ordering::SeqCst) {
            return Err(self.error());
        }
        if config
            .body_length
            .is_some_and(|n| n > 9_007_199_254_740_991)
            || (!config.streaming && (config.body_length.is_some() || config.replayable))
        {
            return Err(Error::new(
                "ERR_INVALID_ARGUMENT",
                "configuration",
                "Invalid streaming body length or replay policy",
            ));
        }
        for value in [
            config.queue_ms,
            config.hop_queue_ms,
            config.headers_ms,
            config.upload_idle_ms,
            config.body_idle_ms,
        ] {
            if value == 0 || value > 2147483647 {
                return Err(Error::new(
                    "ERR_INVALID_ARGUMENT",
                    "configuration",
                    "Invalid request timeout",
                ));
            }
        }
        for v in [config.consumer_idle_ms, config.total_ms]
            .into_iter()
            .flatten()
        {
            if v == 0 || v > 2147483647 {
                return Err(Error::new(
                    "ERR_INVALID_ARGUMENT",
                    "configuration",
                    "Invalid optional timeout",
                ));
            }
        }
        if config.max_redirects > 10
            || config.sensitive_headers.len() > 200
            || config
                .sensitive_headers
                .iter()
                .any(|name| name.len() > 256 || HeaderName::from_bytes(name.as_bytes()).is_err())
        {
            return Err(Error::new(
                "ERR_INVALID_ARGUMENT",
                "configuration",
                "Invalid redirect policy",
            ));
        }
        let mut current = Url::parse(&config.url).map_err(|_| {
            Error::new(
                "ERR_INVALID_ARGUMENT",
                "configuration",
                "Invalid request URL",
            )
        })?;
        if !matches!(current.scheme(), "http" | "https")
            || !current.username().is_empty()
            || current.password().is_some()
            || current.host_str().is_none()
            || (owner.http2_only && current.scheme() != "https")
        {
            return Err(Error::new(
                "ERR_INVALID_ARGUMENT",
                "configuration",
                "Only HTTP(S) URLs without credentials are supported",
            ));
        }
        current.set_fragment(None);
        if current.origin().ascii_serialization() != self.initial_origin {
            return Err(Error::new(
                "ERR_INVALID_ARGUMENT",
                "configuration",
                "Request origin differs from its admission ticket",
            ));
        }
        let mut method = Method::from_bytes(config.method.as_bytes())
            .map_err(|_| Error::new("ERR_INVALID_ARGUMENT", "configuration", "Invalid method"))?;
        if method == Method::CONNECT
            || ((method == Method::GET || method == Method::HEAD)
                && (config.streaming || body.is_some()))
        {
            return Err(Error::new(
                "ERR_INVALID_ARGUMENT",
                "configuration",
                "Unsupported method or body",
            ));
        }
        let mut headers = HeaderMap::new();
        let mut original_order = OrigHeaderMap::new();
        for (name, value) in &config.headers {
            let name = HeaderName::from_bytes(name.as_bytes()).map_err(|_| {
                Error::new(
                    "ERR_INVALID_ARGUMENT",
                    "configuration",
                    "Invalid header name",
                )
            })?;
            if crate::profile_headers::is_transport_header(name.as_str(), value) {
                return Err(Error::new(
                    "ERR_INVALID_ARGUMENT",
                    "configuration",
                    "Transport-managed header cannot be set",
                ));
            }
            let bytes = value
                .chars()
                .map(|c| u8::try_from(c as u32))
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(|_| {
                    Error::new(
                        "ERR_INVALID_ARGUMENT",
                        "configuration",
                        "Header is not a byte string",
                    )
                })?;
            original_order.insert(name.clone());
            headers.append(
                name,
                HeaderValue::from_bytes(&bytes).map_err(|_| {
                    Error::new(
                        "ERR_INVALID_ARGUMENT",
                        "configuration",
                        "Invalid header value",
                    )
                })?,
            );
        }
        let _ = self.limits.set(ReadLimits {
            body_idle_ms: config.body_idle_ms,
            max_response_bytes: config.max_response_bytes,
        });
        if config
            .total_ms
            .is_some_and(|ms| Instant::now() >= self.opened_at + Duration::from_millis(ms))
        {
            return Err(self.timeout("queue"));
        }
        if let Some(ms) = config.total_ms {
            // The timer holds no Activity: after the operation finishes it only
            // observes the cancelled token, so it must not delay cleanup.
            let weak = Arc::downgrade(self);
            let token = self.token.clone();
            let deadline = self.opened_at + Duration::from_millis(ms);
            tokio::spawn(async move {
                tokio::select! { biased; _ = token.cancelled() => {}, _ = tokio::time::sleep_until(deadline) => { if let Some(op) = weak.upgrade() { op.timeout(op.phase_name()); } } }
            });
        }
        let queue_deadline = self.opened_at + Duration::from_millis(config.queue_ms);
        self.wait_for_admission(queue_deadline).await?;
        let transport = lock(&owner.transport).clone().ok_or_else(|| self.error())?;
        // Bytes clones share the immutable native snapshot across hops.
        let mut replay_body = body.map(Bytes::from);
        let mut streaming = config.streaming;
        let mut redirects = Vec::new();
        // The original header order is fixed for the whole chain; build the
        // policy once instead of on every hop.
        let policy = Arc::new(crate::profile_headers::HeaderPolicy::new(
            original_order,
            &owner.http1_profile,
            &config.header_overrides,
        ));
        let (response, final_hop) = loop {
            if self.terminal.load(Ordering::SeqCst) {
                return Err(self.error());
            }
            if owner.closed.load(Ordering::SeqCst) {
                return Err(Error::new("ERR_CLIENT_CLOSED", "queue", "Client is closed"));
            }
            let uri = current.as_str().parse::<wreq::Uri>().map_err(|_| {
                Error::new(
                    "ERR_REDIRECT_URL",
                    "headers",
                    "Invalid HTTP redirect destination",
                )
            })?;
            let mut request_headers = headers.clone();
            if !request_headers.contains_key(wreq::header::COOKIE) {
                let automatic = lock(&owner.cookies)
                    .as_mut()
                    .map(|jar| jar.header_bytes(&current, cookie_now()))
                    .transpose()?
                    .flatten();
                if let Some(cookie) = automatic {
                    request_headers.insert(
                        wreq::header::COOKIE,
                        HeaderValue::from_bytes(&cookie).map_err(|_| {
                            Error::new(
                                "ERR_INVALID_COOKIE",
                                "configuration",
                                "Invalid automatic Cookie header",
                            )
                        })?,
                    );
                }
            }
            if request_headers.len() > crate::profile_headers::MAX_HEADER_PAIRS
                || request_headers
                    .iter()
                    .map(|(name, value)| name.as_str().len() + value.as_bytes().len())
                    .sum::<usize>()
                    > crate::profile_headers::MAX_HEADER_BYTES
            {
                return Err(Error::new(
                    "ERR_RESOURCE_LIMIT",
                    "configuration",
                    "Request headers including automatic cookies exceed the limit",
                ));
            }
            let mut request = transport
                .request(method.clone(), uri)
                .headers(request_headers);
            let progress = if streaming {
                let (body, hop) =
                    self.start_upload_hop(redirects.len() as u32 + 1, config.body_length)?;
                request = request.body(body);
                Some(hop.progress.clone())
            } else if let Some(bytes) = replay_body.clone() {
                let progress = SendProgress::new();
                if bytes.is_empty() {
                    progress.done.cancel();
                }
                request = request.body(Body::wrap(ReplayBody {
                    bytes,
                    progress: progress.clone(),
                }));
                Some(progress)
            } else {
                None
            };
            let mut raw: http::Request<Body> = request.build().map_err(Error::from)?.into();
            wreq_proto::ext::on_preserve_header(&mut raw, SharedHeaderPolicy(policy.clone()));
            let request = wreq::Request::from(raw);
            let deadline = send_deadline(progress, config.headers_ms, config.upload_idle_ms);
            let response = tokio::select! { biased;
                _ = self.token.cancelled() => return Err(self.error()),
                phase = deadline => return Err(self.timeout(phase)),
                r = transport.execute(request) => r.map_err(Error::from)?
            };
            // An upload hop that did not finish when headers arrived was cut
            // short; its transport frame fails once `abort` is cancelled.
            let hop = self.stop_upload_hop().filter(|hop| !hop.is_complete());
            if response.headers().len() > 200
                || response
                    .headers()
                    .iter()
                    .map(|(k, v)| k.as_str().len() + v.as_bytes().len())
                    .sum::<usize>()
                    > 65536
            {
                return Err(Error::new(
                    "ERR_RESOURCE_LIMIT",
                    "headers",
                    "Response headers exceeded the limit",
                ));
            }
            if let Some(jar) = lock(&owner.cookies).as_mut()
                && !owner.closed.load(Ordering::SeqCst)
            {
                let now = cookie_now();
                for value in response.headers().get_all(wreq::header::SET_COOKIE) {
                    jar.receive_cookie_bytes(value.as_bytes(), &current, now);
                }
            }
            if config.redirect == RedirectMode::Manual {
                break (response, hop);
            }
            let Some(next) =
                redirect::destination(response.status().as_u16(), response.headers(), &current)?
            else {
                break (response, hop);
            };
            if config.redirect == RedirectMode::Error {
                return Err(Error::new(
                    "ERR_REDIRECT_DISALLOWED",
                    "headers",
                    "Redirects are disabled by request policy",
                ));
            }
            if redirects.len() >= config.max_redirects {
                return Err(Error::new(
                    "ERR_REDIRECT_LIMIT",
                    "headers",
                    "Redirect limit exceeded",
                ));
            }
            let downgrade = current.scheme() == "https" && next.scheme() == "http";
            if downgrade && !config.allow_insecure_redirects {
                return Err(Error::new(
                    "ERR_REDIRECT_DISALLOWED",
                    "headers",
                    "HTTPS downgrade is disabled",
                ));
            }
            if owner.http2_only && next.scheme() != "https" {
                return Err(Error::new(
                    "ERR_REDIRECT_URL",
                    "headers",
                    "Strict HTTP2 requires HTTPS",
                ));
            }
            let drop_body = redirect::drops_body(response.status().as_u16(), &method);
            if streaming && !config.replayable && !drop_body {
                return Err(Error::new(
                    "ERR_BODY_NOT_REPLAYABLE",
                    "headers",
                    "Redirect requires a replayable request body",
                ));
            }
            let next_method = if drop_body {
                Method::GET
            } else {
                method.clone()
            };
            redirect::strip_headers(
                &mut headers,
                &config.sensitive_headers,
                current.origin() != next.origin(),
                drop_body,
            );
            redirects.push(Hop {
                status: response.status().as_u16(),
                from_url: current.to_string(),
                to_url: next.to_string(),
                method_before: method.to_string(),
                method_after: next_method.to_string(),
            });
            // A truncated request leaves the connection unusable: fail it at
            // once. Otherwise drain a small body so HTTP/1 can reuse the
            // connection; dropping a large or slow one cancels it instead.
            // The operation and its total timer remain live.
            match hop {
                Some(hop) => {
                    drop(response);
                    hop.abort.cancel();
                }
                None => self.drain_redirect(response, config.body_idle_ms).await?,
            }
            if current.origin() != next.origin() {
                self.ticket.move_to(next.origin().ascii_serialization())?;
                self.wait_for_admission(
                    Instant::now() + Duration::from_millis(config.hop_queue_ms),
                )
                .await?;
            }
            if drop_body {
                replay_body = None;
                if streaming {
                    // No later hop sends a body: release the JS pump now
                    // rather than after the final response.
                    streaming = false;
                    self.stop_upload();
                }
            }
            method = next_method;
            current = next;
        };
        if final_hop.is_some() {
            let _ = self.upload_error.set(Error::new(
                "ERR_ABORTED",
                "upload",
                "Upload stopped: the server sent its final response before the request body ended",
            ));
        }
        self.stop_upload();
        self.phase.store(PHASE_BODY, Ordering::SeqCst);
        let version = match response.version() {
            Version::HTTP_2 => "2",
            Version::HTTP_11 => "1.1",
            // Still common from embedded devices and simple servers (Python
            // http.server); hyper applies HTTP/1.0 framing and keep-alive.
            Version::HTTP_10 => "1.0",
            _ => {
                return Err(Error::new(
                    "ERR_HTTP_PROTOCOL",
                    "headers",
                    "Unsupported HTTP version",
                ));
            }
        };
        let headers = response
            .headers()
            .iter()
            .map(|(k, v)| {
                (
                    k.as_str().to_string(),
                    v.as_bytes()
                        .iter()
                        .map(|b| char::from(*b))
                        .collect::<String>(),
                )
            })
            .collect::<Vec<_>>();
        // The limit was already checked on the raw bytes above. Re-measuring
        // the Latin-1 strings would count every byte >= 0x80 twice.
        let meta = ResponseMeta {
            status: response.status().as_u16(),
            url: current.to_string(),
            http_version: version.into(),
            headers,
            redirects,
        };
        let length = response.content_length();
        let mut download = Download {
            stream: Box::pin(response.bytes_stream()),
            pending: Bytes::new(),
            received: 0,
            length,
            deferred: None,
        };
        // A small body of known length (including bodiless HEAD/204/304
        // responses) is collected here and returned with the headers. That is
        // one bridge crossing instead of several, and the admission slot and
        // pooled connection are released before JavaScript sees the response.
        if let Some(n) = length.filter(|n| {
            *n <= INLINE_BYTES as u64 && config.max_response_bytes.is_none_or(|max| *n <= max)
        }) {
            let mut collected = Vec::with_capacity(n as usize);
            let complete = loop {
                let next = tokio::select! { biased;
                    _ = self.token.cancelled() => return Err(self.error()),
                    n = tokio::time::timeout(Duration::from_millis(config.body_idle_ms), download.stream.next()) => n
                };
                match next {
                    Ok(None) => break true,
                    Ok(Some(Ok(bytes))) => {
                        download.received += bytes.len() as u64;
                        collected.extend_from_slice(&bytes);
                    }
                    // The consumer gets the headers and the bytes received so
                    // far; the failure surfaces from the body read, as it would
                    // for a streamed response.
                    Ok(Some(Err(error))) => {
                        download.deferred = Some(Error::transport(error, "body"));
                        break false;
                    }
                    Err(_) => {
                        download.deferred = Some(Error::new(
                            "ERR_TIMEOUT",
                            "body",
                            "Operation deadline expired",
                        ));
                        break false;
                    }
                }
            };
            if complete {
                drop(download);
                self.finish(None);
                return Ok(Executed {
                    meta,
                    body: Some(collected),
                });
            }
            download.pending = Bytes::from(collected);
        }
        {
            let mut slot = lock(&self.download);
            if self.terminal.load(Ordering::SeqCst) {
                return Err(self.error());
            }
            self.download_bytes
                .store(download.pending.len(), Ordering::SeqCst);
            *slot = Some(download);
            self.headers_ready.store(true, Ordering::SeqCst);
        }
        self.arm_consumer_timer(config.consumer_idle_ms);
        Ok(Executed { meta, body: None })
    }
    async fn wait_for_admission(&self, deadline: Instant) -> Result<()> {
        self.phase.store(PHASE_QUEUE, Ordering::SeqCst);
        if self.terminal.load(Ordering::SeqCst) {
            return Err(self.error());
        }
        if Instant::now() >= deadline {
            return Err(self.timeout("queue"));
        }
        tokio::select! { biased;
            _ = self.token.cancelled() => return Err(self.error()),
            result = tokio::time::timeout_at(deadline, self.ticket.wait()) => {
                result.map_err(|_| self.timeout("queue"))??;
            }
        }
        if self.terminal.load(Ordering::SeqCst) {
            return Err(self.error());
        }
        if Instant::now() >= deadline {
            return Err(self.timeout("queue"));
        }
        self.phase.store(PHASE_HEADERS, Ordering::SeqCst);
        Ok(())
    }
    /// Reads a small intermediate HTTP/1 redirect body to its end so the
    /// connection returns to the pool. Bodies that are large, slow or not over
    /// HTTP/1 are dropped instead (closing the connection or resetting the
    /// stream); a drain failure never fails the redirect.
    async fn drain_redirect(&self, response: wreq::Response, idle_ms: u64) -> Result<()> {
        if response.version() == Version::HTTP_2
            || response
                .content_length()
                .is_some_and(|n| n > REDIRECT_DRAIN_BYTES)
        {
            return Ok(());
        }
        let deadline = Instant::now() + Duration::from_millis(REDIRECT_DRAIN_MS.min(idle_ms));
        let mut stream = response.bytes_stream();
        let mut drained = 0u64;
        loop {
            let next = tokio::select! { biased;
                _ = self.token.cancelled() => return Err(self.error()),
                n = tokio::time::timeout_at(deadline, stream.next()) => n,
            };
            match next {
                Ok(Some(Ok(bytes))) => {
                    drained += bytes.len() as u64;
                    if drained > REDIRECT_DRAIN_BYTES {
                        return Ok(());
                    }
                }
                _ => return Ok(()),
            }
        }
    }
    fn arm_consumer_timer(self: &Arc<Self>, ms: Option<u64>) {
        // Like the total timer, the watchdog holds no Activity: it exits on the
        // cancelled token and never delays cleanup of a finished operation.
        if let Some(ms) = ms
            && !self.terminal.load(Ordering::SeqCst)
        {
            let weak = Arc::downgrade(self);
            let token = self.token.clone();
            tokio::spawn(async move {
                loop {
                    let Some(op) = weak.upgrade() else {
                        break;
                    };
                    let epoch = op.consumer_epoch.load(Ordering::SeqCst);
                    let reading = op.reading.load(Ordering::SeqCst);
                    // One watchdog per operation; a slow consumer cannot accumulate timer tasks.
                    if reading {
                        tokio::select! { biased; _ = token.cancelled() => break, _ = op.consumer_notify.notified() => {} }
                    } else {
                        tokio::select! { biased;
                            _ = token.cancelled() => break,
                            _ = op.consumer_notify.notified() => {},
                            _ = tokio::time::sleep(Duration::from_millis(ms)) => {
                                if op.consumer_epoch.load(Ordering::SeqCst) == epoch && !op.reading.load(Ordering::SeqCst) {
                                    op.timeout("body"); break;
                                }
                            }
                        }
                    }
                }
            });
        }
    }
    pub async fn wait_terminal(&self) -> Option<String> {
        self.token.cancelled().await;
        lock(&self.reason).as_ref().map(Error::wire)
    }
    pub async fn wait_cleanup(&self) {
        self.cleaned.cancelled().await;
    }
    pub async fn wait_upload_stopped(&self) {
        self.upload_stop.cancelled().await;
    }
    pub fn upload_fail(&self, epoch: u32, code: &str) -> bool {
        let code = if code == "ERR_RESOURCE_LIMIT" {
            code
        } else {
            "ERR_UPLOAD_SOURCE"
        };
        self.finish_scoped(
            Some(Error::new(
                code,
                "upload",
                "JavaScript upload source failed",
            )),
            Some(epoch),
        )
    }
    /// Ends the current upload hop and returns it.
    fn stop_upload_hop(&self) -> Option<Arc<UploadHop>> {
        let hop = lock(&self.upload_hop).take()?;
        hop.stop.cancel();
        hop.progress.done.cancel();
        hop.bytes.store(0, Ordering::SeqCst);
        let _ = self.credit.compare_exchange(
            u64::from(hop.epoch),
            0,
            Ordering::SeqCst,
            Ordering::SeqCst,
        );
        Some(hop)
    }
    fn stop_upload(&self) {
        self.upload_stop.cancel();
        self.stop_upload_hop();
    }
    /// Why the upload stopped before its source ended, as a wire error: set
    /// when the final response arrived while a streaming body was unfinished.
    /// The response itself is still delivered.
    pub fn upload_error(&self) -> Option<String> {
        self.upload_error.get().map(Error::wire)
    }
    fn start_upload_hop(
        self: &Arc<Self>,
        epoch: u32,
        length: Option<u64>,
    ) -> Result<(Body, Arc<UploadHop>)> {
        let owner = self.owner.upgrade().ok_or_else(|| self.error())?;
        let activity = Activity::new(&owner, self)?;
        let (sender, rx) = mpsc::channel(1);
        let hop = Arc::new(UploadHop {
            epoch,
            stop: CancellationToken::new(),
            progress: SendProgress::new(),
            eof: AtomicBool::new(false),
            complete: AtomicBool::new(length == Some(0)),
            abort: self.token.child_token(),
            sender,
            bytes: AtomicUsize::new(0),
        });
        {
            let mut current = lock(&self.upload_hop);
            if self.upload_stop.is_cancelled() {
                hop.stop.cancel();
                hop.progress.done.cancel();
            }
            *current = Some(hop.clone());
        }
        let weak = Arc::downgrade(self);
        let demand = self.demand().0.clone();
        // Idle time is enforced by the send deadline in execute_inner, which
        // keeps running when the transport stops polling this stream.
        let source = stream::unfold(
            (rx, hop.clone(), demand, weak),
            move |(mut rx, hop, demand, weak)| async move {
                let op = weak.upgrade()?;
                let next = async {
                    demand.send(hop.epoch).await.ok()?;
                    rx.recv().await
                };
                let msg = tokio::select! { biased;
                    _ = hop.stop.cancelled() => return None,
                    m = next => m,
                };
                hop.bytes.store(0, Ordering::SeqCst);
                match msg {
                    Some(Ok(Some(bytes))) => Some((Ok(bytes), (rx, hop, demand, weak))),
                    Some(Err(e)) => {
                        op.finish(Some(e.clone()));
                        Some((Err(e), (rx, hop, demand, weak)))
                    }
                    Some(Ok(None)) => {
                        hop.eof.store(true, Ordering::SeqCst);
                        None
                    }
                    None => None,
                }
            },
        );
        if length == Some(0) {
            hop.progress.done.cancel();
        }
        let abort = Box::pin(hop.abort.clone().cancelled_owned());
        let body = UploadBody {
            inner: Body::wrap_stream(source),
            remaining: length,
            hop: hop.clone(),
            truncated: false,
            abort,
            activity,
        };
        Ok((Body::wrap(body), hop))
    }
    pub async fn wait_upload_epoch_ended(&self, epoch: u32) {
        let hop = lock(&self.upload_hop)
            .as_ref()
            .filter(|h| h.epoch == epoch)
            .cloned();
        if let Some(hop) = hop {
            hop.stop.cancelled().await;
        }
    }
    pub async fn upload_demand(self: &Arc<Self>) -> Result<u32> {
        let owner = self.owner.upgrade().ok_or_else(|| self.error())?;
        if self.upload_stop.is_cancelled() {
            return Ok(0);
        }
        let _activity = Activity::new(&owner, self)?;
        let mut receiver = lock(&self.demand().1).take().ok_or_else(|| {
            Error::new(
                "ERR_INVALID_ARGUMENT",
                "upload",
                "Only one upload demand may be pending",
            )
        })?;
        let epoch = loop {
            let next = tokio::select! { biased; _ = self.upload_stop.cancelled() => None, m = receiver.recv() => m };
            let Some(epoch) = next else {
                break 0;
            };
            let current = lock(&self.upload_hop);
            if current
                .as_ref()
                .is_some_and(|h| h.epoch == epoch && !h.stop.is_cancelled())
            {
                self.credit.store(u64::from(epoch), Ordering::SeqCst);
                break epoch;
            }
        };
        *lock(&self.demand().1) = Some(receiver);
        Ok(epoch)
    }
    pub async fn upload_write(
        self: &Arc<Self>,
        epoch: u32,
        bytes: Option<Vec<u8>>,
        source_error: bool,
    ) -> Result<bool> {
        if self.upload_stop.is_cancelled() {
            // An early final response truncated the body: say so instead of
            // reporting an ordinary end of the hop.
            return match self.upload_error.get() {
                Some(error) => Err(error.clone()),
                None => Ok(false),
            };
        }
        let owner = self.owner.upgrade().ok_or_else(|| self.error())?;
        let _activity = Activity::new(&owner, self)?;
        let oversized = bytes.as_ref().is_some_and(|b| b.len() > CHUNK_BYTES);
        let hop = {
            let current = lock(&self.upload_hop);
            let Some(hop) = current
                .as_ref()
                .filter(|h| h.epoch == epoch && !h.stop.is_cancelled())
            else {
                return Ok(false);
            };
            if oversized {
                drop(current);
                // Fail the operation now; leaving it running would end as an
                // upload idle timeout with the credit already spent.
                let error = Error::new(
                    "ERR_RESOURCE_LIMIT",
                    "upload",
                    "Native upload chunk exceeds 64 KiB",
                );
                self.finish_scoped(Some(error.clone()), Some(epoch));
                return Err(error);
            }
            if epoch == 0
                || self
                    .credit
                    .compare_exchange(u64::from(epoch), 0, Ordering::SeqCst, Ordering::SeqCst)
                    .is_err()
            {
                return Err(Error::new(
                    "ERR_RESOURCE_LIMIT",
                    "upload",
                    "Upload write has no demand credit",
                ));
            }
            hop.clone()
        };
        hop.bytes
            .store(bytes.as_ref().map_or(0, Vec::len), Ordering::SeqCst);
        let message = if source_error {
            Err(Error::new(
                "ERR_UPLOAD_SOURCE",
                "upload",
                "JavaScript upload source failed",
            ))
        } else {
            Ok(bytes.map(Bytes::from))
        };
        tokio::select! { biased; _ = hop.stop.cancelled() => Ok(false), sent = hop.sender.send(message) => Ok(sent.is_ok()) }
    }
    pub async fn read(self: &Arc<Self>) -> Result<Option<Vec<u8>>> {
        let owner = self.owner.upgrade().ok_or_else(|| self.error())?;
        let _activity = Activity::new(&owner, self)?;
        self.check_readable()?;
        if self.reading.swap(true, Ordering::SeqCst) {
            return Err(Error::new(
                "ERR_BODY_USED",
                "body",
                "Only one native read may be pending",
            ));
        }
        let result = self.read_inner().await;
        self.end_read(result.as_ref().map(Option::is_none));
        result
    }
    /// Reads the rest of the body into one buffer of at most `max` bytes. The
    /// buffer is charged to the client's aggregate budget while it is filled.
    pub async fn read_all(self: &Arc<Self>, max: usize) -> Result<Vec<u8>> {
        let owner = self.owner.upgrade().ok_or_else(|| self.error())?;
        let _activity = Activity::new(&owner, self)?;
        self.check_readable()?;
        if self.reading.swap(true, Ordering::SeqCst) {
            return Err(Error::new(
                "ERR_BODY_USED",
                "body",
                "Only one native read may be pending",
            ));
        }
        let result = self.read_all_inner(&owner, max).await;
        self.end_read(result.as_ref().map(|_| true));
        result
    }
    /// A read before the response headers is a usage error; it must not
    /// destroy the operation that is still being executed.
    fn check_readable(&self) -> Result<()> {
        if !self.headers_ready.load(Ordering::SeqCst) && !self.terminal.load(Ordering::SeqCst) {
            return Err(Error::new(
                "ERR_INVALID_ARGUMENT",
                "body",
                "Response body is not available before its headers",
            ));
        }
        Ok(())
    }
    fn end_read(&self, result: std::result::Result<bool, &Error>) {
        self.reading.store(false, Ordering::SeqCst);
        match result {
            Err(e) => self.finish(Some(e.clone())),
            Ok(true) => self.finish(None),
            Ok(false) => {
                self.consumer_epoch.fetch_add(1, Ordering::SeqCst);
                self.consumer_notify.notify_one();
            }
        }
    }
    fn begin_read(&self) -> Result<(u64, Option<u64>, Download)> {
        if self.terminal.load(Ordering::SeqCst) {
            return Err(self.error());
        }
        self.consumer_epoch.fetch_add(1, Ordering::SeqCst);
        self.consumer_notify.notify_one();
        let limits = *self.limits.get().ok_or_else(|| self.error())?;
        let download = lock(&self.download).take().ok_or_else(|| self.error())?;
        Ok((limits.body_idle_ms, limits.max_response_bytes, download))
    }
    fn end_download(&self, download: Download) -> Result<()> {
        let mut slot = lock(&self.download);
        if self.terminal.load(Ordering::SeqCst) {
            return Err(self.error());
        }
        self.download_bytes
            .store(download.pending.len(), Ordering::SeqCst);
        *slot = Some(download);
        Ok(())
    }
    /// Makes `download.pending` non-empty; false at the end of the body.
    async fn fill(
        &self,
        download: &mut Download,
        idle_ms: u64,
        max_response_bytes: Option<u64>,
    ) -> Result<bool> {
        while download.pending.is_empty() {
            if let Some(error) = download.deferred.take() {
                return Err(error);
            }
            let next = tokio::select! { biased;
                _ = self.token.cancelled() => return Err(self.error()),
                n = tokio::time::timeout(Duration::from_millis(idle_ms), download.stream.next()) => n.map_err(|_| self.timeout("body"))?
            };
            let Some(bytes) = next else {
                return Ok(false);
            };
            let bytes = bytes.map_err(|e| Error::transport(e, "body"))?;
            download.received += bytes.len() as u64;
            if max_response_bytes.is_some_and(|max| download.received > max) {
                return Err(Error::new(
                    "ERR_RESOURCE_LIMIT",
                    "body",
                    "Response byte limit exceeded",
                ));
            }
            download.pending = bytes;
        }
        Ok(true)
    }
    async fn read_inner(&self) -> Result<Option<Vec<u8>>> {
        let (idle_ms, max, mut download) = self.begin_read()?;
        if !self.fill(&mut download, idle_ms, max).await? {
            return Ok(None);
        }
        let size = download.pending.len().min(CHUNK_BYTES);
        // Reuses the allocation when the transport handed over a unique
        // buffer of exactly this size; copies only shared slices.
        let chunk = Vec::from(download.pending.split_to(size));
        self.end_download(download)?;
        Ok(Some(chunk))
    }
    async fn read_all_inner(&self, owner: &ClientInner, max: usize) -> Result<Vec<u8>> {
        let (idle_ms, max_response, mut download) = self.begin_read()?;
        let budget = owner.buffered.lease();
        let expected = download
            .length
            .map_or(0, |n| n.saturating_sub(download.received) as usize)
            + download.pending.len();
        let mut out = Vec::with_capacity(expected.min(max));
        loop {
            if !download.pending.is_empty() {
                let pending = std::mem::take(&mut download.pending);
                if out.len() + pending.len() > max {
                    return Err(Error::new(
                        "ERR_RESOURCE_LIMIT",
                        "body",
                        "Buffered response byte limit exceeded",
                    ));
                }
                budget.reserve(pending.len())?;
                out.extend_from_slice(&pending);
            }
            if !self.fill(&mut download, idle_ms, max_response).await? {
                break;
            }
        }
        // Ownership passes to the caller together with the bytes.
        budget.release();
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn client() -> CoreClient {
        CoreClient::new(
            &Profile::parse(include_str!("../../../profiles/neutral.json")).unwrap(),
            ClientConfig {
                max_active_operations: 1,
                max_queued_operations: 1,
                max_active_per_origin: 1,
                max_connections: 64,
                max_connections_per_origin: 8,
                max_aggregate_buffered_response_bytes: 134217728,
                connect_ms: 1000,
                ca: None,
                trust_store: None,
                cookies: true,
                proxies: Vec::new(),
                resolve: Default::default(),
            },
        )
        .unwrap()
    }
    #[tokio::test]
    async fn first_terminal_reason_wins_and_close_is_idempotent() {
        let client = client();
        let op = client.open("http://127.0.0.1:1").unwrap();
        op.cancel("ERR_ABORTED");
        op.cancel("ERR_CLIENT_CLOSED");
        assert_eq!(op.error().code, "ERR_ABORTED");
        assert_eq!(client.stats()["aborted"], 1);
        assert_eq!(client.stats()["activeOperations"], 0);
        client.close().await.unwrap();
        client.close().await.unwrap();
        assert!(client.open("http://127.0.0.1:1").is_err());
        assert_eq!(client.stats()["nativeTasks"], 0);
    }
    #[tokio::test]
    async fn queue_is_bounded_and_handles_are_never_reused() {
        let client = client();
        let a = client.open("http://127.0.0.1:1").unwrap();
        let b = client.open("http://127.0.0.1:1").unwrap();
        assert!(client.open("http://127.0.0.1:1").is_err());
        a.cancel("ERR_ABORTED");
        let c = client.open("http://127.0.0.1:1").unwrap();
        assert!(c.id > b.id);
        a.cancel("ERR_ABORTED");
        assert_eq!(client.stats()["queuedOperations"], 1);
        assert_eq!(client.stats()["activeOperations"], 1);
        client.close().await.unwrap();
        assert_eq!(client.stats()["queuedOperations"], 0);
    }
    #[tokio::test]
    async fn close_wakes_blocked_upload_demand() {
        let client = client();
        let op = client.open("http://127.0.0.1:1").unwrap();
        let wait = op.upload_demand();
        let close = async {
            tokio::task::yield_now().await;
            client.close().await.unwrap();
        };
        let (result, ()) = tokio::join!(wait, close);
        assert_eq!(result.unwrap(), 0);
        assert_eq!(client.stats()["nativeTasks"], 0);
    }
    #[tokio::test]
    async fn stale_upload_hops_cannot_consume_current_credit_or_fail_the_chain() {
        let client = client();
        let op = client.open("http://127.0.0.1:1").unwrap();
        let (first, _) = op.start_upload_hop(1, None).unwrap();
        op.demand().0.send(1).await.unwrap();
        assert_eq!(op.upload_demand().await.unwrap(), 1);
        op.stop_upload_hop();
        let (second, hop) = op.start_upload_hop(2, None).unwrap();
        // A leftover credit notification is discarded without affecting epoch 2.
        op.demand().0.send(1).await.unwrap();
        let notify = async {
            tokio::task::yield_now().await;
            op.demand().0.send(2).await.unwrap();
        };
        let (epoch, ()) = tokio::join!(op.upload_demand(), notify);
        assert_eq!(epoch.unwrap(), 2);
        assert!(!op.upload_write(1, Some(vec![9]), false).await.unwrap());
        assert!(!op.upload_fail(1, "ERR_RESOURCE_LIMIT"));
        assert_eq!(op.credit.load(Ordering::SeqCst), 2);
        assert!(!op.terminal.load(Ordering::SeqCst));
        assert!(op.upload_write(2, Some(vec![1, 2]), false).await.unwrap());
        assert_eq!(hop.bytes.load(Ordering::SeqCst), 2);
        assert_eq!(op.credit.load(Ordering::SeqCst), 0);
        assert!(op.upload_fail(2, "ERR_UPLOAD_SOURCE"));
        assert_eq!(op.error().code, "ERR_UPLOAD_SOURCE");
        // No operation capacity is released while transport bodies still own work.
        assert_eq!(client.stats()["activeOperations"], 1);
        drop((first, second));
        op.wait_cleanup().await;
        assert_eq!(client.stats()["activeOperations"], 0);
        client.close().await.unwrap();
    }
    #[tokio::test]
    async fn known_upload_hints_complete_at_the_last_frame_without_an_extra_eof_poll() {
        use http_body::Body as _;
        let client = client();
        let op = client.open("http://127.0.0.1:1").unwrap();
        let (mut body, hop) = op.start_upload_hop(1, Some(3)).unwrap();
        assert_eq!(body.size_hint().exact(), Some(3));
        let receive = futures_util::future::poll_fn(|cx| Pin::new(&mut body).poll_frame(cx));
        let send = async {
            assert_eq!(op.upload_demand().await.unwrap(), 1);
            assert!(
                op.upload_write(1, Some(vec![1, 2, 3]), false)
                    .await
                    .unwrap()
            );
        };
        let (frame, ()) = tokio::join!(receive, send);
        assert_eq!(
            frame.unwrap().unwrap().data_ref().unwrap().as_ref(),
            &[1, 2, 3]
        );
        assert!(hop.progress.done.is_cancelled());
        assert!(body.is_end_stream());
        drop(body);
        op.stop_upload_hop();
        let (empty, hop) = op.start_upload_hop(2, Some(0)).unwrap();
        assert!(empty.is_end_stream());
        assert!(hop.progress.done.is_cancelled());
        assert_eq!(empty.size_hint().exact(), Some(0));
        drop(empty);
        op.cancel("ERR_ABORTED");
        client.close().await.unwrap();
    }
    #[tokio::test]
    async fn cancellation_holds_the_slot_until_owned_native_activity_has_dropped() {
        let client = client();
        let a = client.open("http://127.0.0.1:1").unwrap();
        let b = client.open("http://127.0.0.1:1").unwrap();
        let task = Activity::new(&client.inner, &a).unwrap();
        a.cancel("ERR_ABORTED");
        assert!(!a.cleaned.is_cancelled());
        assert_eq!(client.stats()["activeOperations"], 1);
        assert_eq!(client.stats()["queuedOperations"], 1);
        assert!(client.open("http://127.0.0.1:1").is_err());
        drop(task);
        a.wait_cleanup().await;
        assert_eq!(client.stats()["activeOperations"], 1);
        assert_eq!(client.stats()["queuedOperations"], 0);
        assert_eq!(a.error().code, "ERR_ABORTED");
        b.cancel("ERR_ABORTED");
        client.close().await.unwrap();
    }
    #[tokio::test]
    async fn close_waits_for_cleanup_and_does_not_reset_active_counts_early() {
        let client = client();
        let op = client.open("http://127.0.0.1:1").unwrap();
        let task = Activity::new(&client.inner, &op).unwrap();
        let mut closing = Box::pin(client.close());
        assert!(
            tokio::time::timeout(Duration::from_millis(5), &mut closing)
                .await
                .is_err()
        );
        assert_eq!(client.stats()["activeOperations"], 1);
        drop(task);
        closing.await.unwrap();
        op.wait_cleanup().await;
        assert_eq!(client.stats()["activeOperations"], 0);
        assert_eq!(client.stats()["nativeTasks"], 0);
    }
    #[tokio::test]
    async fn cancelled_dispatch_does_not_prepare_or_copy_the_body() {
        let client = client();
        let op = client.open("http://127.0.0.1:1").unwrap();
        op.cancel("ERR_ABORTED");
        let called = AtomicBool::new(false);
        let result = op
            .execute_prepared(|| {
                called.store(true, Ordering::SeqCst);
                Err(Error::new(
                    "ERR_INVALID_ARGUMENT",
                    "configuration",
                    "Must not prepare",
                ))
            })
            .await;
        assert_eq!(result.err().unwrap().code, "ERR_ABORTED");
        assert!(!called.load(Ordering::SeqCst));
        op.wait_cleanup().await;
        client.close().await.unwrap();
    }
    #[tokio::test]
    async fn admission_deadlines_include_native_dispatch_delay() {
        for total in [false, true] {
            let client = client();
            let op = client.open("http://127.0.0.1:1").unwrap();
            tokio::time::sleep(Duration::from_millis(10)).await;
            let config = serde_json::from_value(json!({
                "url":"http://127.0.0.1:1", "method":"GET", "headers":[],
                "streaming":false, "queueMs":if total {1000} else {1}, "hopQueueMs":1000,
                "headersMs":1000,"uploadIdleMs":1000,"bodyIdleMs":1000,
                "consumerIdleMs":null,"totalMs":if total {Some(1)} else {None},
                "maxResponseBytes":null
            }))
            .unwrap();
            let Err(error) = op.execute(config, None).await else {
                panic!("Expired dispatch unexpectedly succeeded");
            };
            assert_eq!(error.code, "ERR_TIMEOUT");
            assert_eq!(error.phase, "queue");
            assert_eq!(client.stats()["activeOperations"], 0);
            assert_eq!(client.stats()["queuedOperations"], 0);
            client.close().await.unwrap();
        }
    }
    #[test]
    fn fast_origin_matches_the_url_parser_or_defers_to_it() {
        for url in [
            "http://127.0.0.1:8080/a?b#c",
            "https://example.test/",
            "https://example.test",
            "http://[::1]:8080/x",
            "http://[::1]/",
            "http://[2001:db8::1]:8080/a",
            "https://xn--caf-dma.test:8443?q",
            "http://a.b-c.test.:81/",
        ] {
            let fast = normalized_origin(url).expect(url);
            assert_eq!(
                fast,
                Url::parse(url).unwrap().origin().ascii_serialization(),
                "{url}"
            );
        }
        for url in [
            "HTTP://EXAMPLE.TEST/",
            "http://example.test:80/",
            "https://example.test:443/",
            "http://0x7f.1/",
            "http://127.1/",
            "http://010.0.0.1/",
            "http://user@example.test/",
            "http://example.test:/",
            "ftp://example.test/",
            "http://ex%41mple.test/",
            "https://[",
            "http://[0:0::1]/",
            "http://[::ffff:7f00:1]x/",
            "http://example.test:0080/",
            "http://example.test:1:2/",
            "http://example.test:99999/",
        ] {
            assert!(normalized_origin(url).is_none(), "{url}");
        }
    }
    #[test]
    fn admission_origin_is_canonical_and_validated_before_allocation() {
        assert_eq!(
            request_origin("HTTPS://EXAMPLE.test:443/a?q=secret#x", false).unwrap(),
            "https://example.test"
        );
        assert_eq!(
            request_origin("http://[::1]:80/a", false).unwrap(),
            "http://[::1]"
        );
        for url in [
            "file:///a",
            "https://secret@example.test",
            "https://[",
            "http://example.test",
        ] {
            assert!(request_origin(url, true).is_err());
        }
        let client = client();
        assert!(client.open("https://user:password@example.test").is_err());
        assert_eq!(client.stats()["activeOperations"], 0);
        assert_eq!(client.stats()["queuedOperations"], 0);
    }

    fn request(url: &str, extra: Value) -> RequestConfig {
        let mut config = json!({
            "url":url, "method":"GET", "headers":[], "streaming":false,
            "queueMs":5000, "hopQueueMs":5000, "headersMs":5000, "uploadIdleMs":5000,
            "bodyIdleMs":5000, "consumerIdleMs":null, "totalMs":null, "maxResponseBytes":null
        });
        for (key, value) in extra.as_object().unwrap() {
            config[key] = value.clone();
        }
        serde_json::from_value(config).unwrap()
    }
    /// Reads one request head; None at EOF.
    fn read_head(stream: &mut std::net::TcpStream) -> Option<String> {
        use std::io::Read;
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            if stream.read(&mut byte).ok()? == 0 {
                return None;
            }
            head.push(byte[0]);
        }
        Some(String::from_utf8_lossy(&head).into_owned())
    }
    /// A blocking HTTP/1 test server. Each connection runs `serve` on its own
    /// thread; the counter reports accepted connections.
    fn server(
        serve: impl Fn(std::net::TcpStream) + Send + Sync + 'static,
    ) -> (String, Arc<AtomicUsize>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let accepted = Arc::new(AtomicUsize::new(0));
        let count = accepted.clone();
        let serve = Arc::new(serve);
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                count.fetch_add(1, Ordering::SeqCst);
                let serve = serve.clone();
                std::thread::spawn(move || serve(stream));
            }
        });
        (url, accepted)
    }
    #[tokio::test]
    async fn send_deadline_bounds_connecting_idle_gaps_and_header_waiting() {
        // Never polled: bounded like header waiting.
        let progress = SendProgress::new();
        let started = Instant::now();
        assert_eq!(send_deadline(Some(progress), 30, 10_000).await, "headers");
        assert!(started.elapsed() >= Duration::from_millis(30));
        // Polled, then stalled: the idle bound applies without any poll.
        let progress = SendProgress::new();
        progress.polled();
        assert_eq!(send_deadline(Some(progress), 10_000, 30).await, "upload");
        // Progress pushes the idle deadline; completion hands over to headers.
        let progress = SendProgress::new();
        progress.polled();
        let feeder = progress.clone();
        let started = Instant::now();
        tokio::spawn(async move {
            for _ in 0..4 {
                tokio::time::sleep(Duration::from_millis(20)).await;
                feeder.advanced();
            }
            feeder.done.cancel();
        });
        assert_eq!(send_deadline(Some(progress), 40, 50).await, "headers");
        assert!(started.elapsed() >= Duration::from_millis(120));
    }
    #[tokio::test]
    async fn replay_bodies_are_framed_and_signal_done_at_the_last_frame() {
        use http_body::Body as _;
        let progress = SendProgress::new();
        let mut body = ReplayBody {
            bytes: Bytes::from(vec![7u8; CHUNK_BYTES * 2 + 1]),
            progress: progress.clone(),
        };
        assert_eq!(body.size_hint().exact(), Some((CHUNK_BYTES * 2 + 1) as u64));
        let mut sizes = Vec::new();
        while !body.is_end_stream() {
            assert!(!progress.done.is_cancelled());
            let frame = futures_util::future::poll_fn(|cx| Pin::new(&mut body).poll_frame(cx))
                .await
                .unwrap()
                .unwrap();
            sizes.push(frame.into_data().unwrap().len());
        }
        assert_eq!(sizes, [CHUNK_BYTES, CHUNK_BYTES, 1]);
        assert!(progress.done.is_cancelled());
        assert_ne!(progress.last.load(Ordering::SeqCst), NEVER_POLLED);
    }
    #[tokio::test]
    async fn read_before_headers_is_a_usage_error_that_keeps_the_operation() {
        let client = client();
        let op = client.open("http://127.0.0.1:1").unwrap();
        assert_eq!(op.read().await.unwrap_err().code, "ERR_INVALID_ARGUMENT");
        assert_eq!(
            op.read_all(10).await.unwrap_err().code,
            "ERR_INVALID_ARGUMENT"
        );
        assert!(!op.terminal.load(Ordering::SeqCst));
        assert!(!op.reading.load(Ordering::SeqCst));
        op.cancel("ERR_ABORTED");
        client.close().await.unwrap();
    }
    #[tokio::test]
    async fn oversized_upload_chunks_fail_the_operation_with_a_resource_limit() {
        let client = client();
        let op = client.open("http://127.0.0.1:1").unwrap();
        let (body, _) = op.start_upload_hop(1, None).unwrap();
        op.demand().0.send(1).await.unwrap();
        assert_eq!(op.upload_demand().await.unwrap(), 1);
        let error = op
            .upload_write(1, Some(vec![0; CHUNK_BYTES + 1]), false)
            .await
            .unwrap_err();
        assert_eq!(error.code, "ERR_RESOURCE_LIMIT");
        assert!(op.terminal.load(Ordering::SeqCst));
        assert_eq!(op.error().code, "ERR_RESOURCE_LIMIT");
        assert_eq!(op.error().phase, "upload");
        drop(body);
        op.wait_cleanup().await;
        client.close().await.unwrap();
    }
    #[tokio::test]
    async fn total_deadline_reports_the_phase_it_interrupted() {
        let (url, _) = server(|mut stream| {
            // Read the head, then never answer.
            read_head(&mut stream);
            std::thread::sleep(Duration::from_secs(5));
        });
        let client = client();
        let op = client.open(&url).unwrap();
        let config = request(&url, json!({"totalMs":100}));
        let error = op.execute(config, None).await.err().unwrap();
        assert_eq!(
            (error.code.as_str(), error.phase.as_str()),
            ("ERR_TIMEOUT", "headers")
        );
        client.close().await.unwrap();
    }
    #[tokio::test]
    async fn stalled_uploads_time_out_even_when_the_transport_stops_polling() {
        // The server never reads: once socket buffers fill, the transport
        // stops polling the body and only the independent watchdog can fire.
        let (url, _) = server(|stream| {
            std::thread::sleep(Duration::from_secs(10));
            drop(stream);
        });
        let client = client();
        let op = client.open(&url).unwrap();
        let config = request(
            &url,
            json!({"method":"POST","streaming":true,"uploadIdleMs":300}),
        );
        let feeder = {
            let op = op.clone();
            tokio::spawn(async move {
                loop {
                    let Ok(epoch) = op.upload_demand().await else {
                        break;
                    };
                    if epoch == 0
                        || !matches!(
                            op.upload_write(epoch, Some(vec![1; CHUNK_BYTES]), false)
                                .await,
                            Ok(true)
                        )
                    {
                        break;
                    }
                }
            })
        };
        let result = tokio::time::timeout(Duration::from_secs(20), op.execute(config, None))
            .await
            .expect("stalled upload must not hang");
        let error = result.err().unwrap();
        assert_eq!(
            (error.code.as_str(), error.phase.as_str()),
            ("ERR_TIMEOUT", "upload")
        );
        feeder.await.unwrap();
        op.wait_cleanup().await;
        client.close().await.unwrap();
    }
    #[tokio::test]
    async fn small_redirect_bodies_are_drained_so_the_connection_is_reused() {
        let (url, accepted) = server(|mut stream| {
            use std::io::Write;
            while let Some(head) = read_head(&mut stream) {
                let sent = if head.starts_with("GET /final") {
                    stream.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok")
                } else {
                    // The body trails the headers, so it is still unread
                    // when the client decides to follow the redirect.
                    stream
                        .write_all(
                            b"HTTP/1.1 302 Found\r\nlocation: /final\r\ncontent-length: 5\r\n\r\n",
                        )
                        .and_then(|()| stream.flush())
                        .and_then(|()| {
                            std::thread::sleep(Duration::from_millis(30));
                            stream.write_all(b"moved")
                        })
                };
                if sent.is_err() {
                    break;
                }
            }
        });
        let client = client();
        let op = client.open(&url).unwrap();
        let executed = op
            .execute(request(&format!("{url}/start"), json!({})), None)
            .await
            .unwrap();
        assert_eq!(executed.meta.status, 200);
        assert_eq!(executed.meta.redirects.len(), 1);
        assert_eq!(executed.body.as_deref(), Some(&b"ok"[..]));
        assert_eq!(accepted.load(Ordering::SeqCst), 1);
        client.close().await.unwrap();
    }
    #[tokio::test]
    async fn an_early_response_fails_an_unfinished_upload_instead_of_ending_it() {
        let (seen_tx, seen_rx) = std::sync::mpsc::channel::<Vec<u8>>();
        let seen_tx = Mutex::new(seen_tx);
        let (url, _) = server(move |mut stream| {
            use std::io::{Read, Write};
            read_head(&mut stream).unwrap();
            let mut received = Vec::new();
            let mut buf = [0u8; 4096];
            // Answer as soon as the first chunk arrived, then record the
            // rest of the request stream until the client closes it.
            while !received.windows(3).any(|w| w == b"abc") {
                let n = stream.read(&mut buf).unwrap();
                assert_ne!(n, 0);
                received.extend_from_slice(&buf[..n]);
            }
            stream
                .write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok")
                .unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            loop {
                match stream.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => received.extend_from_slice(&buf[..n]),
                }
            }
            lock(&seen_tx).send(received).unwrap();
        });
        let client = client();
        let op = client.open(&url).unwrap();
        let config = request(&url, json!({"method":"POST","streaming":true}));
        let feeder = {
            let op = op.clone();
            tokio::spawn(async move {
                let epoch = op.upload_demand().await.unwrap();
                assert!(
                    op.upload_write(epoch, Some(b"abc".to_vec()), false)
                        .await
                        .unwrap()
                );
                // The source never ends: hold the next demand until the
                // response stops the upload, then try to continue.
                let _ = op.upload_demand().await.unwrap();
                op.wait_upload_stopped().await;
                op.upload_write(epoch, Some(b"def".to_vec()), false).await
            })
        };
        let executed = op.execute(config, None).await.unwrap();
        assert_eq!(executed.meta.status, 200);
        assert_eq!(executed.body.as_deref(), Some(&b"ok"[..]));
        let late = feeder.await.unwrap().unwrap_err();
        assert_eq!(
            (late.code.as_str(), late.phase.as_str()),
            ("ERR_ABORTED", "upload")
        );
        assert!(op.upload_error().unwrap().contains("ERR_ABORTED"));
        let received = tokio::task::spawn_blocking(move || seen_rx.recv().unwrap())
            .await
            .unwrap();
        // The server saw the chunk and then a closed connection, never the
        // terminating chunk of a complete chunked body.
        assert!(received.windows(3).any(|w| w == b"abc"));
        assert!(!received.ends_with(b"0\r\n\r\n"), "{received:?}");
        op.wait_cleanup().await;
        assert_eq!(client.stats()["nativeTasks"], 0);
        client.close().await.unwrap();
    }
}
