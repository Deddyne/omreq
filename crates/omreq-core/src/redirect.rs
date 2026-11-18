use crate::error::{Error, Result};
use serde::{Deserialize, Serialize};
use url::Url;
use wreq::{Method, header::HeaderMap};

#[derive(Clone, Copy, Default, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    #[default]
    Follow,
    Manual,
    Error,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hop {
    pub status: u16,
    pub from_url: String,
    pub to_url: String,
    pub method_before: String,
    pub method_after: String,
}
pub fn default_limit() -> usize {
    10
}
pub fn destination(status: u16, headers: &HeaderMap, current: &Url) -> Result<Option<Url>> {
    if !matches!(status, 301 | 302 | 303 | 307 | 308) {
        return Ok(None);
    }
    let mut values = headers.get_all("location").iter();
    let Some(value) = values.next() else {
        return Ok(None);
    };
    if values.next().is_some() {
        return Err(invalid_url());
    }
    // Browsers decode a raw (non-percent-encoded) Location as UTF-8 when it is
    // valid UTF-8, so `/café` sent as UTF-8 octets stays `/caf%C3%A9`. Other
    // octets fall back to Latin-1, one character per byte.
    let location = match std::str::from_utf8(value.as_bytes()) {
        Ok(text) => std::borrow::Cow::Borrowed(text),
        Err(_) => std::borrow::Cow::Owned(
            value
                .as_bytes()
                .iter()
                .map(|b| char::from(*b))
                .collect::<String>(),
        ),
    };
    let location = location.trim_matches([' ', '\t']);
    if location.is_empty() {
        return Ok(None);
    }
    let mut url = current.join(location).map_err(|_| invalid_url())?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none()
    {
        return Err(invalid_url());
    }
    url.set_fragment(None);
    Ok(Some(url))
}
fn invalid_url() -> Error {
    Error::new(
        "ERR_REDIRECT_URL",
        "headers",
        "Invalid redirect destination",
    )
}
pub fn drops_body(status: u16, method: &Method) -> bool {
    (matches!(status, 301 | 302) && *method == Method::POST)
        || (status == 303 && *method != Method::GET && *method != Method::HEAD)
}
pub fn strip_headers(
    headers: &mut HeaderMap,
    sensitive: &[String],
    cross_origin: bool,
    drop_body: bool,
) {
    if cross_origin {
        for name in ["authorization", "cookie", "referer"] {
            headers.remove(name);
        }
        for name in sensitive {
            headers.remove(name);
        }
    }
    if drop_body {
        // Fetch "request-body-header name"s, plus the framing of the dropped body.
        for name in [
            "content-encoding",
            "content-language",
            "content-location",
            "content-type",
            "content-length",
        ] {
            headers.remove(name);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn method_policy_is_explicit() {
        for status in [301, 302, 303, 307, 308] {
            for method in [
                Method::GET,
                Method::HEAD,
                Method::POST,
                Method::PUT,
                Method::PATCH,
            ] {
                let expected = (status == 303 && method != Method::GET && method != Method::HEAD)
                    || (matches!(status, 301 | 302) && method == Method::POST);
                assert_eq!(drops_body(status, &method), expected);
            }
        }
    }
    #[test]
    fn locations_use_url_resolution_and_reject_credentials_and_non_http() {
        let base = Url::parse("https://example.test:443/a/b?q=1").unwrap();
        for (location, expected) in [
            ("../next?x=1#fragment", "https://example.test/next?x=1"),
            ("//other.test/a", "https://other.test/a"),
            ("?q=2", "https://example.test/a/b?q=2"),
        ] {
            let mut headers = HeaderMap::new();
            headers.insert("location", location.parse().unwrap());
            assert_eq!(
                destination(302, &headers, &base).unwrap().unwrap().as_str(),
                expected
            );
        }
        for value in [
            "https://[",
            "file:///etc/passwd",
            "https://name:secret@example.test",
        ] {
            let mut headers = HeaderMap::new();
            headers.insert("location", value.parse().unwrap());
            assert_eq!(
                destination(302, &headers, &base).unwrap_err().code,
                "ERR_REDIRECT_URL"
            );
        }
        let mut headers = HeaderMap::new();
        headers.insert("location", "".parse().unwrap());
        assert!(destination(302, &headers, &base).unwrap().is_none());
        headers.append("location", "/other".parse().unwrap());
        assert!(destination(302, &headers, &base).is_err());
        assert!(destination(304, &headers, &base).unwrap().is_none());
    }
    #[test]
    fn raw_utf8_locations_are_decoded_as_utf8_and_other_octets_as_latin1() {
        let base = Url::parse("https://example.test/").unwrap();
        for (raw, expected) in [
            ("/café".as_bytes(), "https://example.test/caf%C3%A9"),
            (b"/caf\xe9".as_slice(), "https://example.test/caf%C3%A9"),
            (b"/%C3%A9".as_slice(), "https://example.test/%C3%A9"),
            (" /a b\t".as_bytes(), "https://example.test/a%20b"),
        ] {
            let mut headers = HeaderMap::new();
            headers.insert(
                "location",
                wreq::header::HeaderValue::from_bytes(raw).unwrap(),
            );
            assert_eq!(
                destination(301, &headers, &base).unwrap().unwrap().as_str(),
                expected
            );
        }
    }
    #[test]
    fn dropping_the_body_removes_request_body_headers() {
        let mut headers = HeaderMap::new();
        for name in [
            "content-type",
            "content-length",
            "content-encoding",
            "content-language",
            "content-location",
            "accept",
        ] {
            headers.insert(name, "x".parse().unwrap());
        }
        strip_headers(&mut headers, &[], false, true);
        assert_eq!(headers.keys().collect::<Vec<_>>(), ["accept"]);
    }
}
