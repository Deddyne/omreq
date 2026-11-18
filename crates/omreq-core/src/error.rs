use serde::Serialize;
use std::sync::{Mutex, MutexGuard, PoisonError};

/// Locks a mutex even if another thread panicked while holding it. Every
/// mutex in this crate guards plain bookkeeping that stays consistent at each
/// unlock, so a panic on one task must not cascade into every later caller.
pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[derive(Clone, Debug, Serialize)]
pub struct Error {
    pub code: String,
    pub phase: String,
    pub message: String,
}
impl Error {
    pub fn new(code: &str, phase: &str, message: &str) -> Self {
        Self {
            code: code.into(),
            phase: phase.into(),
            message: message.into(),
        }
    }
    pub fn wire(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| {
            r#"{"code":"ERR_INTERNAL","phase":"body","message":"Unserializable error"}"#.into()
        })
    }
    /// Maps a transport error. `fallback_phase` is used for protocol failures
    /// that wreq does not classify, such as a reset while reading the body.
    pub fn transport(e: wreq::Error, fallback_phase: &str) -> Self {
        let mut source = std::error::Error::source(&e);
        let mut tls_error = e.is_tls();
        while let Some(cause) = source {
            if cause.is::<btls::ssl::Error>() || cause.is::<btls::error::ErrorStack>() {
                tls_error = true;
            }
            source = cause.source();
        }
        let (code, phase, summary) = if e.is_timeout() {
            ("ERR_TIMEOUT", "connect", "Transport timed out")
        } else if e.is_dns() {
            ("ERR_DNS", "connect", "DNS resolution failed")
        } else if e.is_proxy_connect() {
            ("ERR_PROXY", "proxy", "Proxy connection failed")
        } else if tls_error {
            ("ERR_TLS", "tls", "TLS handshake failed")
        } else if e.is_connect() {
            ("ERR_CONNECT", "connect", "Connection failed")
        } else if e.is_body() {
            ("ERR_BODY_READ", "body", "Body transfer failed")
        } else {
            (
                "ERR_HTTP_PROTOCOL",
                fallback_phase,
                "Transport operation failed",
            )
        };
        let chain = cause_chain(&e);
        let message = if chain.is_empty() {
            summary.to_owned()
        } else {
            format!("{summary}: {chain}")
        };
        Self::new(code, phase, &message)
    }
}

const CAUSE_PART_CHARS: usize = 160;
const CAUSE_CHARS: usize = 400;

/// A concise, bounded `a: b: c` rendering of the error's source chain. The
/// top-level wreq error is skipped because its Display carries the request
/// URI (query strings can hold secrets); any cause that looks like it embeds
/// a URL is dropped for the same reason.
fn cause_chain(e: &wreq::Error) -> String {
    let mut texts = Vec::new();
    let mut source = std::error::Error::source(e);
    while let Some(cause) = source {
        if texts.len() == 8 {
            break;
        }
        texts.push(cause.to_string());
        source = cause.source();
    }
    let mut parts: Vec<String> = Vec::new();
    for (i, text) in texts.iter().enumerate() {
        // Wrappers often print "outer: inner"; keep only what is new.
        let mut own = text.as_str();
        if let Some(next) = texts.get(i + 1)
            && let Some(prefix) = own.strip_suffix(next.as_str())
        {
            own = prefix.trim_end_matches([':', ' ']);
        }
        let own = own.trim();
        if own.is_empty() || own.contains("://") || parts.iter().any(|p| p == own) {
            continue;
        }
        let clean = own
            .chars()
            .map(|c| if c.is_control() { ' ' } else { c })
            .take(CAUSE_PART_CHARS)
            .collect::<String>();
        parts.push(clean);
    }
    let mut out = String::new();
    for part in parts {
        let extra = if out.is_empty() { 0 } else { 2 };
        if out.chars().count() + extra + part.chars().count() > CAUSE_CHARS {
            break;
        }
        if extra != 0 {
            out.push_str(": ");
        }
        out.push_str(&part);
    }
    out
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.wire())
    }
}
impl std::error::Error for Error {}
impl From<wreq::Error> for Error {
    fn from(e: wreq::Error) -> Self {
        Self::transport(e, "headers")
    }
}
pub type Result<T> = std::result::Result<T, Error>;

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn transport_errors_keep_a_bounded_cause_without_the_url() {
        // Bind and drop a listener to obtain a closed local port.
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let client = wreq::Client::builder().no_proxy().build().unwrap();
        let error = client
            .get(format!("http://127.0.0.1:{port}/path?secret=token"))
            .send()
            .await
            .unwrap_err();
        let error = Error::from(error);
        assert_eq!(error.code, "ERR_CONNECT");
        assert_eq!(error.phase, "connect");
        assert!(
            error.message.starts_with("Connection failed: "),
            "{}",
            error.message
        );
        assert!(error.message.len() > "Connection failed: ".len());
        assert!(!error.message.contains("secret"), "{}", error.message);
        assert!(!error.message.contains("127.0.0.1"), "{}", error.message);
        assert!(error.message.chars().count() <= 420);
    }

    #[test]
    fn poisoned_mutexes_stay_usable() {
        let mutex = std::sync::Arc::new(Mutex::new(1));
        let poison = mutex.clone();
        let _ = std::thread::spawn(move || {
            let _guard = poison.lock().unwrap();
            panic!("poison the mutex");
        })
        .join();
        assert!(mutex.is_poisoned());
        *lock(&mutex) += 1;
        assert_eq!(*lock(&mutex), 2);
    }
}
