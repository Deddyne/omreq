use crate::error::{Error, Result};
use serde_json::{Value, json};
use std::{collections::HashSet, sync::Arc};
use wreq::header::{CONNECTION, HeaderMap, HeaderName, HeaderValue, OrigHeaderMap};
use wreq_proto::ext::OnPreserveHeaderCallback;
/// Header names the transport owns, rejected in every layer (profile, client
/// and request); mirrors `TRANSPORT_HEADERS` in `packages/omreq/src/headers.ts`.
pub const TRANSPORT_HEADERS: [&str; 8] = [
    "host",
    "connection",
    "keep-alive",
    "proxy-connection",
    "transfer-encoding",
    "upgrade",
    "proxy-authorization",
    "content-length",
];
/// Profiles describe a client, never a session: credentials are rejected too.
pub const PROFILE_ONLY_FORBIDDEN_HEADERS: [&str; 2] = ["cookie", "authorization"];
/// Limits on a complete header list (name plus value characters), shared with
/// `MAX_HEADER_PAIRS` / `MAX_HEADER_BYTES` in TypeScript.
pub const MAX_HEADER_PAIRS: usize = 200;
pub const MAX_HEADER_BYTES: usize = 65536;
/// Whether a header with lowercase `name` is transport-managed. `te` is allowed
/// only as `trailers`, the one value HTTP/2 permits.
pub fn is_transport_header(name: &str, value: &str) -> bool {
    TRANSPORT_HEADERS.contains(&name)
        || name == "te"
            // The characters JavaScript's String.prototype.trim removes within Latin-1.
            && !value
                .trim_matches(['\t', '\n', '\x0b', '\x0c', '\r', ' ', '\u{a0}'])
                .eq_ignore_ascii_case("trailers")
}
pub fn normalize_http1(input: &Value) -> Result<Value> {
    let order = input.get("headerOrder").cloned().unwrap_or(json!([]));
    let mut seen = HashSet::new();
    for name in order.as_array().expect("schema checked") {
        if !seen.insert(name.as_str().expect("schema checked").to_ascii_lowercase()) {
            return Err(Error::new(
                "ERR_PROFILE_INVALID",
                "configuration",
                "/transport/http1/headerOrder: duplicate header name",
            ));
        }
    }
    Ok(
        json!({"headerOrder":order,"keepAliveHeader":input["keepAliveHeader"].as_bool().unwrap_or(false),"omitDefaultPriority":input["omitDefaultPriority"].as_bool().unwrap_or(false)}),
    )
}
/// The HTTP/1 part of a normalized profile, parsed once per client.
pub struct Http1Profile {
    /// Profile header order, before names of the request's own order.
    order: OrigHeaderMap,
    /// Lowercase names in `order`.
    names: HashSet<String>,
    keep_alive: bool,
    omit_default_priority: bool,
}
impl Http1Profile {
    pub fn new(http1: &Value) -> Self {
        let mut order = OrigHeaderMap::new();
        let mut names = HashSet::new();
        for name in http1["headerOrder"].as_array().expect("normalized") {
            let name = name.as_str().expect("normalized");
            order.insert(name.to_owned());
            names.insert(name.to_ascii_lowercase());
        }
        Self {
            order,
            names,
            keep_alive: http1["keepAliveHeader"] == true,
            omit_default_priority: http1["omitDefaultPriority"] == true,
        }
    }
}
pub struct HeaderPolicy {
    h2: OrigHeaderMap,
    h1: OrigHeaderMap,
    keep_alive: bool,
    omit_priority: bool,
}
impl HeaderPolicy {
    pub fn new(order: OrigHeaderMap, http1: &Arc<Http1Profile>, overrides: &[String]) -> Self {
        let mut h1 = http1.order.clone();
        let mut seen = HashSet::new();
        for (name, _) in order.iter() {
            let name_str = name.as_str();
            if !http1.names.contains(name_str) && seen.insert(name_str.to_owned()) {
                h1.insert(name.clone());
            }
        }
        Self {
            h2: order,
            h1,
            keep_alive: http1.keep_alive,
            omit_priority: http1.omit_default_priority
                && !overrides.iter().any(|s| s.eq_ignore_ascii_case("priority")),
        }
    }
}
impl HeaderPolicy {
    /// Orders headers as on HTTP/2, which HTTP/3 shares.
    pub fn order_h2(&self, headers: &mut HeaderMap) {
        self.h2.call(headers);
    }
}
impl OnPreserveHeaderCallback for HeaderPolicy {
    fn call(&self, headers: &mut HeaderMap) {
        self.h2.call(headers);
    }
    fn call_visit(
        &self,
        headers: &mut HeaderMap,
        dst: &mut dyn FnMut(&dyn AsRef<[u8]>, &HeaderValue),
    ) {
        // This callback is only used by the HTTP/1 serializer. H2 uses call().
        if self.keep_alive && !headers.contains_key(CONNECTION) {
            headers.insert(CONNECTION, HeaderValue::from_static("keep-alive"));
        }
        if self.omit_priority {
            headers.remove(HeaderName::from_static("priority"));
        }
        self.h1.call_visit(headers, dst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn transport_headers_match_the_typescript_rules() {
        for name in TRANSPORT_HEADERS {
            assert!(is_transport_header(name, "x"));
        }
        assert!(is_transport_header("te", "gzip"));
        assert!(!is_transport_header("te", " Trailers\t"));
        assert!(!is_transport_header("accept", "x"));
        assert!(!is_transport_header("cookie", "x"));
    }
}
