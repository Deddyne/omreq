//! HTTP/3 transport. A request goes over HTTP/3 when the profile has a `transport.http3`
//! block, no proxy carries the target and the origin is known to speak HTTP/3: from its DNS
//! HTTPS record or an earlier `Alt-Svc` header, like Chromium. When a QUIC connection cannot
//! be established in time the origin is marked broken for a while and the request goes over
//! TCP. With `httpVersion: "3"` every HTTPS request uses HTTP/3 and nothing falls back.

mod conn;
mod dns;
pub(crate) mod profile;
mod qpack;

use std::{
    collections::{BTreeMap, HashMap},
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use btls::x509::{X509, store::X509StoreBuilder};
use http::{HeaderMap, HeaderName, HeaderValue};
use quic::{ClientConfig, ConnectionId, Endpoint, EndpointConfig, crypto::btls::QuicClientConfig};
use url::Url;

use self::{conn::H3Connection, profile::Http3Profile};
use crate::error::{Error, Result, lock};

/// How long an origin whose QUIC handshake failed is not tried again (Chromium starts at 5 min).
const BROKEN_FOR: Duration = Duration::from_secs(300);
/// How long a discovered (not required) HTTP/3 origin may take to handshake before the
/// request goes over TCP instead; UDP that is silently dropped gives no earlier signal.
const AUTO_HANDSHAKE: Duration = Duration::from_secs(3);
/// Upper bound on waiting for an HTTPS record before the first connection to a host.
const DNS_TIMEOUT: Duration = Duration::from_millis(1000);
/// Cache bounds; the oldest entries are dropped beyond them.
const MAX_HOSTS: usize = 4096;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Mode {
    /// HTTP/3 when the origin advertises it, with TCP as the fallback.
    Auto,
    /// HTTP/3 for every HTTPS request.
    Only,
}

#[derive(Clone)]
struct Alternative {
    host: Option<String>,
    port: u16,
    expires: Instant,
}

type Slot = Arc<tokio::sync::Mutex<Option<Arc<H3Connection>>>>;

/// Why a request did not get a response over HTTP/3.
pub(crate) enum SendError {
    /// No stream could be opened: the request was not sent and is handed back.
    NotSent(Error, Box<http::Request<wreq::Body>>),
    /// The connection failed or the server rejected the request before responding; the
    /// request may be sent again.
    Unprocessed(Error),
    Failed(Error),
}

impl SendError {
    pub(crate) fn into_error(self) -> Error {
        match self {
            Self::NotSent(error, _) | Self::Unprocessed(error) | Self::Failed(error) => error,
        }
    }
}

pub(crate) struct Http3 {
    profile: Arc<Http3Profile>,
    tls: QuicClientConfig,
    mode: Mode,
    connect_timeout: Duration,
    resolve: BTreeMap<String, Vec<IpAddr>>,
    name_servers: Vec<SocketAddr>,
    pool: Mutex<HashMap<String, Slot>>,
    alt_svc: Mutex<HashMap<String, Alternative>>,
    https_records: Mutex<HashMap<String, (Instant, Option<u16>)>>,
    broken: Mutex<HashMap<String, Instant>>,
    closed: std::sync::atomic::AtomicBool,
}

/// Trust roots for QUIC handshakes, built like the TCP client's: the trust store, the
/// Chromium roots the profile names as trust anchors, and extra PEM CAs.
fn roots(
    store: &str,
    ca: Option<&str>,
    anchors: &[String],
) -> Result<btls::x509::store::X509Store> {
    let certs: &[&[u8]] = &match store {
        "chromium" => chromium_roots::TLS_SERVER_ROOT_CERTS
            .iter()
            .map(|c| c.as_ref())
            .collect::<Vec<_>>(),
        _ => webpki_root_certs::TLS_SERVER_ROOT_CERTS
            .iter()
            .map(|c| c.as_ref())
            .chain(crate::profile_tls::advertised_roots(anchors))
            .collect(),
    };
    let failed = || {
        Error::new(
            "ERR_TLS",
            "configuration",
            "Trust roots could not be loaded",
        )
    };
    let mut builder = X509StoreBuilder::new().map_err(|_| failed())?;
    for der in certs {
        if let Ok(cert) = X509::from_der(der) {
            let _ = builder.add_cert(cert);
        }
    }
    if let Some(ca) = ca {
        for cert in X509::stack_from_pem(ca.as_bytes()).map_err(|_| failed())? {
            builder.add_cert(cert).map_err(|_| failed())?;
        }
    }
    Ok(builder.build())
}

impl Http3 {
    pub(crate) fn new(
        http3: &serde_json::Value,
        mode: Mode,
        config: &crate::client::ClientConfig,
    ) -> Result<Self> {
        let profile = Arc::new(Http3Profile::new(http3));
        let store = roots(
            config.trust_store.as_deref().unwrap_or("bundled"),
            config.ca.as_deref(),
            &crate::profile_tls::trust_anchor_ids(&http3["tls"]),
        )?;
        let tls = profile.tls(&store)?;
        Ok(Self {
            profile,
            tls,
            mode,
            connect_timeout: conn::handshake_timeout(config.connect_ms),
            resolve: config.resolve.clone(),
            name_servers: dns::system_name_servers(),
            pool: Mutex::new(HashMap::new()),
            alt_svc: Mutex::new(HashMap::new()),
            https_records: Mutex::new(HashMap::new()),
            broken: Mutex::new(HashMap::new()),
            closed: std::sync::atomic::AtomicBool::new(false),
        })
    }

    /// Remembers the `Alt-Svc` of a response from `origin` (RFC 7838).
    pub(crate) fn observe(&self, url: &Url, headers: &HeaderMap) {
        if url.scheme() != "https" {
            return;
        }
        let origin = url.origin().ascii_serialization();
        for value in headers.get_all(http::header::ALT_SVC) {
            let Ok(value) = value.to_str() else { continue };
            match parse_alt_svc(value) {
                Some(None) => {
                    lock(&self.alt_svc).remove(&origin);
                }
                Some(Some(alternative)) => {
                    let mut cache = lock(&self.alt_svc);
                    if cache.len() >= MAX_HOSTS {
                        cache.clear();
                    }
                    cache.insert(origin.clone(), alternative);
                }
                None => {}
            }
        }
    }

    /// Where HTTP/3 to this URL's origin is offered, if anywhere.
    async fn alternative(&self, url: &Url) -> Option<(String, u16)> {
        let host = url.host_str()?.to_owned();
        let port = url.port_or_known_default()?;
        if self.mode == Mode::Only {
            return Some((host, port));
        }
        let origin = url.origin().ascii_serialization();
        let now = Instant::now();
        if self.is_broken(&origin) {
            return None;
        }
        if let Some(alternative) = lock(&self.alt_svc).get(&origin).cloned()
            && alternative.expires > now
        {
            return Some((alternative.host.unwrap_or(host), alternative.port));
        }
        // HTTPS records name the default port's service; other ports and IP literals have none.
        if port != 443
            || url
                .host()
                .is_some_and(|h| !matches!(h, url::Host::Domain(_)))
        {
            return None;
        }
        if self.resolve.contains_key(&host.to_ascii_lowercase()) || self.name_servers.is_empty() {
            return None;
        }
        let cached = lock(&self.https_records).get(&host).copied();
        let h3_port = match cached {
            Some((expires, h3_port)) if expires > now => h3_port,
            _ => {
                let timeout = DNS_TIMEOUT.min(self.connect_timeout);
                let record = dns::lookup(&self.name_servers, &host, timeout).await;
                let (ttl, h3_port) = match record {
                    Some(record) => (record.ttl.clamp(60, 3600), record.h3_port),
                    None => (60, None),
                };
                let mut cache = lock(&self.https_records);
                if cache.len() >= MAX_HOSTS {
                    cache.clear();
                }
                cache.insert(
                    host.clone(),
                    (
                        Instant::now() + Duration::from_secs(u64::from(ttl)),
                        h3_port,
                    ),
                );
                h3_port
            }
        };
        h3_port.map(|p| (host, p))
    }

    /// Whether HTTP/3 to `origin` failed recently.
    fn is_broken(&self, origin: &str) -> bool {
        lock(&self.broken)
            .get(origin)
            .is_some_and(|until| *until > Instant::now())
    }

    /// Stops using HTTP/3 to the URL's origin for a while, like Chromium after a QUIC failure;
    /// TCP carries its requests.
    pub(crate) fn mark_broken(&self, url: &Url) {
        let now = Instant::now();
        let mut broken = lock(&self.broken);
        broken.retain(|_, until| *until > now);
        if broken.len() >= MAX_HOSTS {
            broken.clear();
        }
        broken.insert(url.origin().ascii_serialization(), now + BROKEN_FOR);
    }

    /// Whether a failed request falls back to TCP rather than failing.
    pub(crate) fn falls_back(&self) -> bool {
        self.mode == Mode::Auto
    }

    /// Drops pool slots that hold no open connection and no waiter, and expired entries.
    fn prune(&self) {
        let now = Instant::now();
        lock(&self.pool).retain(|_, slot| {
            Arc::strong_count(slot) > 1
                || slot
                    .try_lock()
                    .map_or(true, |s| s.as_ref().is_some_and(|c| c.is_usable()))
        });
        lock(&self.alt_svc).retain(|_, alternative| alternative.expires > now);
        lock(&self.broken).retain(|_, until| *until > now);
    }

    /// An HTTP/3 connection for the URL's origin, reused when one is open. `Ok(None)` means the
    /// request should go over TCP.
    pub(crate) async fn connection(
        self: &Arc<Self>,
        url: &Url,
    ) -> Result<Option<Arc<H3Connection>>> {
        if url.scheme() != "https" {
            return Ok(None);
        }
        let Some((host, port)) = self.alternative(url).await else {
            return Ok(None);
        };
        let origin = url.origin().ascii_serialization();
        let key = format!("{origin} {host}:{port}");
        let slot = {
            let pool = lock(&self.pool);
            pool.get(&key).cloned()
        };
        let slot = match slot {
            Some(slot) => slot,
            None => {
                self.prune();
                lock(&self.pool).entry(key).or_default().clone()
            }
        };
        let mut guard = slot.lock_owned().await;
        if let Some(connection) = guard.as_ref()
            && connection.is_usable()
        {
            return Ok(Some(connection.clone()));
        }
        // A request that waited on another one's failed handshake does not repeat it.
        if self.mode == Mode::Auto && self.is_broken(&origin) {
            return Ok(None);
        }
        *guard = None;
        // The handshake runs to its end in its own task, holding the slot, so a request that
        // is abandoned meanwhile still leaves the outcome for the requests after it.
        let this = self.clone();
        let url = url.clone();
        let task = tokio::spawn(async move {
            let server_name = url.host_str().unwrap_or_default().trim_matches(['[', ']']);
            match this.connect(server_name, &host, port).await {
                Ok(connection) if this.closed.load(std::sync::atomic::Ordering::SeqCst) => {
                    connection.close();
                    Err(Error::new("ERR_CLIENT_CLOSED", "queue", "Client is closed"))
                }
                Ok(connection) => {
                    lock(&this.broken).remove(&url.origin().ascii_serialization());
                    *guard = Some(connection.clone());
                    Ok(Some(connection))
                }
                Err(_) if this.mode == Mode::Auto => {
                    this.mark_broken(&url);
                    Ok(None)
                }
                Err(error) => Err(error),
            }
        });
        task.await.unwrap_or_else(|_| {
            Err(Error::new(
                "ERR_CONNECT",
                "connect",
                "QUIC connection task failed",
            ))
        })
    }

    async fn addresses(&self, host: &str, port: u16) -> Result<Vec<SocketAddr>> {
        let bare = host.trim_matches(['[', ']']);
        if let Ok(ip) = bare.parse::<IpAddr>() {
            return Ok(vec![SocketAddr::new(ip, port)]);
        }
        if let Some(ips) = self.resolve.get(&bare.to_ascii_lowercase()) {
            return Ok(ips.iter().map(|ip| SocketAddr::new(*ip, port)).collect());
        }
        let found = tokio::net::lookup_host((bare, port))
            .await
            .map_err(|_| Error::new("ERR_DNS", "connect", "DNS resolution failed"))?
            .collect::<Vec<_>>();
        if found.is_empty() {
            return Err(Error::new("ERR_DNS", "connect", "DNS resolution failed"));
        }
        Ok(found)
    }

    async fn connect(&self, server_name: &str, host: &str, port: u16) -> Result<Arc<H3Connection>> {
        let budget = match self.mode {
            Mode::Auto => self.connect_timeout.min(AUTO_HANDSHAKE),
            Mode::Only => self.connect_timeout,
        };
        let deadline = Instant::now() + budget;
        let addresses = self.addresses(host, port).await?;
        let mut last = Error::new("ERR_CONNECT", "connect", "QUIC connection failed");
        let addresses = &addresses[..addresses.len().min(4)];
        for (index, address) in addresses.iter().enumerate() {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            // UDP gives no connection refusal to move on from: the remaining time is shared
            // between the remaining addresses.
            let attempt = left / (addresses.len() - index) as u32;
            match tokio::time::timeout(attempt, self.connect_to(server_name, *address)).await {
                Ok(Ok(connection)) => return Ok(connection),
                Ok(Err(error)) => last = error,
                Err(_) => {
                    last = Error::new("ERR_TIMEOUT", "connect", "QUIC connection timed out");
                }
            }
        }
        Err(last)
    }

    async fn connect_to(
        &self,
        server_name: &str,
        address: SocketAddr,
    ) -> Result<Arc<H3Connection>> {
        let failed = |message: &str| Error::new("ERR_CONNECT", "connect", message);
        let bind: SocketAddr = if address.is_ipv4() {
            ([0, 0, 0, 0], 0).into()
        } else {
            (std::net::Ipv6Addr::UNSPECIFIED, 0).into()
        };
        let socket = std::net::UdpSocket::bind(bind).map_err(|_| failed("UDP socket failed"))?;
        let mut endpoint_config =
            EndpointConfig::new(Arc::new(quic::crypto::btls::HmacKey::sha256()));
        endpoint_config
            .max_udp_payload_size(self.profile.max_udp_payload_size)
            .map_err(|_| failed("Invalid QUIC packet size"))?;
        endpoint_config.grease_quic_bit(false);
        let cid_length = self.profile.cid_length;
        endpoint_config.cid_generator(Arc::new(move || {
            Box::new(quic_proto::RandomConnectionIdGenerator::new(cid_length))
        }));
        let runtime = quic::default_runtime().ok_or_else(|| failed("No async runtime"))?;
        let endpoint = Endpoint::new(endpoint_config, None, socket, runtime)
            .map_err(|_| failed("QUIC endpoint failed"))?;
        let mut client = ClientConfig::new(Arc::new(self.tls.clone()));
        client.transport_config(self.profile.transport.clone());
        let dcid_length = self.profile.initial_dcid_length;
        client.initial_dst_cid_provider(Arc::new(move || {
            let mut bytes = vec![0u8; dcid_length];
            btls::rand::rand_bytes(&mut bytes).expect("BoringSSL random bytes");
            ConnectionId::new(&bytes)
        }));
        let connecting = endpoint
            .connect_with(client, address, server_name)
            .map_err(|e| failed(&format!("QUIC connection failed: {e}")))?;
        let quic = connecting
            .await
            .map_err(|e| conn::connection_error(&e, "connect"))?;
        H3Connection::establish(endpoint, quic, self.profile.clone()).await
    }

    /// Sends one request over an established connection. `headers` are the request headers
    /// after profile ordering; connection-specific fields are dropped (RFC 9114 section 4.2).
    pub(crate) async fn send(
        &self,
        connection: &Arc<H3Connection>,
        request: http::Request<wreq::Body>,
        order: impl FnOnce(&mut HeaderMap),
    ) -> std::result::Result<wreq::Response, SendError> {
        let streams = match connection.open().await {
            Ok(streams) => streams,
            Err(error) => return Err(SendError::NotSent(error, Box::new(request))),
        };
        let (parts, body) = request.into_parts();
        let mut headers = parts.headers;
        for name in [
            "connection",
            "keep-alive",
            "proxy-connection",
            "transfer-encoding",
            "upgrade",
            "host",
        ] {
            headers.remove(name);
        }
        if let Some(length) = http_body::Body::size_hint(&body).exact()
            && (length != 0
                || !matches!(
                    parts.method,
                    http::Method::GET
                        | http::Method::HEAD
                        | http::Method::DELETE
                        | http::Method::CONNECT
                ))
            && !headers.contains_key(http::header::CONTENT_LENGTH)
        {
            headers.insert(http::header::CONTENT_LENGTH, HeaderValue::from(length));
        }
        order(&mut headers);
        let ordered = ordered(headers);
        match connection
            .send(streams, &parts.method, &parts.uri, ordered, body)
            .await
        {
            Ok(response) => Ok(wreq::Response::from(response.map(wreq::Body::wrap))),
            Err(failure) if failure.retryable => Err(SendError::Unprocessed(failure.error)),
            Err(failure) => Err(SendError::Failed(failure.error)),
        }
    }

    pub(crate) fn close(&self) {
        self.closed.store(true, std::sync::atomic::Ordering::SeqCst);
        for slot in lock(&self.pool).drain().map(|(_, slot)| slot) {
            if let Ok(slot) = slot.try_lock()
                && let Some(connection) = slot.as_ref()
            {
                connection.close();
            }
        }
    }

    /// Open connections, for client statistics.
    pub(crate) fn open_connections(&self) -> usize {
        lock(&self.pool)
            .values()
            .filter(|slot| {
                slot.try_lock()
                    .ok()
                    .is_some_and(|s| s.as_ref().is_some_and(|c| c.is_usable()))
            })
            .count()
    }
}

/// Headers in map order with lowercase names (`HeaderMap` names are already lowercase).
fn ordered(headers: HeaderMap) -> Vec<(HeaderName, HeaderValue)> {
    let mut out = Vec::with_capacity(headers.len());
    let mut name = None;
    for (next, value) in headers {
        if let Some(next) = next {
            name = Some(next);
        }
        if let Some(name) = &name {
            out.push((name.clone(), value));
        }
    }
    out
}

/// Parses an `Alt-Svc` value: `Some(None)` for `clear`, `Some(Some(_))` for the first `h3`
/// alternative, `None` when it offers no HTTP/3.
fn parse_alt_svc(value: &str) -> Option<Option<Alternative>> {
    if value.trim().eq_ignore_ascii_case("clear") {
        return Some(None);
    }
    for entry in value.split(',') {
        let mut parts = entry.split(';').map(str::trim);
        let Some((protocol, authority)) = parts.next().and_then(|p| p.split_once('=')) else {
            continue;
        };
        if protocol.trim() != "h3" {
            continue;
        }
        let authority = authority.trim().trim_matches('"');
        let (host, port) = authority.rsplit_once(':')?;
        let Ok(port) = port.parse::<u16>() else {
            continue;
        };
        let mut max_age = 86400u64;
        for parameter in parts {
            if let Some(value) = parameter.strip_prefix("ma=")
                && let Ok(value) = value.trim_matches('"').parse()
            {
                max_age = value;
            }
        }
        return Some(Some(Alternative {
            host: (!host.is_empty()).then(|| host.to_owned()),
            port,
            expires: Instant::now() + Duration::from_secs(max_age.min(30 * 86400)),
        }));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alt_svc_offers_h3() {
        let alt = parse_alt_svc(r#"h3=":443"; ma=86400, h3-29=":443""#)
            .unwrap()
            .unwrap();
        assert_eq!((alt.host, alt.port), (None, 443));
        let alt = parse_alt_svc(r#"h2="alt.example:443", h3="alt.example:8443"; ma=60"#)
            .unwrap()
            .unwrap();
        assert_eq!((alt.host.as_deref(), alt.port), (Some("alt.example"), 8443));
        assert!(parse_alt_svc("clear").unwrap().is_none());
        assert!(parse_alt_svc(r#"h2=":443""#).is_none());
    }
}
