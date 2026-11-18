use crate::error::{Error, Result};
use serde::{
    Deserialize, Deserializer,
    de::{self, MapAccess, SeqAccess, Visitor},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, sync::LazyLock};
use wreq::{
    Emulation, Group,
    header::{HeaderMap, HeaderName, HeaderValue},
};

pub const BUILD_ID: &str = env!("OMREQ_ENGINE_BUILD_ID");
pub const CAPABILITIES: &[&str] = &[
    "headers.v1",
    "http.version.v1",
    "tls.versions.v1",
    "tls.alpn.v1",
    "http2.options.v1",
    "tls.algorithms.v1",
    "tls.extensions.v1",
    "tls.trust-anchors.v1",
    "tls.certificate-compression.brotli.v1",
    "http2.settings.v1",
    "http2.hpack.v1",
    "http1.header-format.v1",
];
static SCHEMA: LazyLock<jsonschema::Validator> = LazyLock::new(|| {
    let schema: Value =
        serde_json::from_str(include_str!("../../../profiles/profile-v1.schema.json"))
            .expect("bundled schema");
    jsonschema::validator_for(&schema).expect("valid bundled schema")
});
struct StrictValue(Value);
impl<'de> Deserialize<'de> for StrictValue {
    fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = StrictValue;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("JSON without duplicate keys")
            }
            fn visit_bool<E: de::Error>(self, v: bool) -> std::result::Result<Self::Value, E> {
                Ok(StrictValue(v.into()))
            }
            fn visit_i64<E: de::Error>(self, v: i64) -> std::result::Result<Self::Value, E> {
                Ok(StrictValue(v.into()))
            }
            fn visit_u64<E: de::Error>(self, v: u64) -> std::result::Result<Self::Value, E> {
                Ok(StrictValue(v.into()))
            }
            fn visit_f64<E: de::Error>(self, v: f64) -> std::result::Result<Self::Value, E> {
                if v.fract() == 0.0 && (-9007199254740991.0..=9007199254740991.0).contains(&v) {
                    return Ok(StrictValue((v as i64).into()));
                }
                serde_json::Number::from_f64(v)
                    .map(|n| StrictValue(Value::Number(n)))
                    .ok_or_else(|| E::custom("non-finite number"))
            }
            fn visit_str<E: de::Error>(self, v: &str) -> std::result::Result<Self::Value, E> {
                Ok(StrictValue(v.into()))
            }
            fn visit_string<E: de::Error>(self, v: String) -> std::result::Result<Self::Value, E> {
                Ok(StrictValue(v.into()))
            }
            fn visit_unit<E: de::Error>(self) -> std::result::Result<Self::Value, E> {
                Ok(StrictValue(Value::Null))
            }
            fn visit_seq<A: SeqAccess<'de>>(
                self,
                mut a: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                let mut out = Vec::new();
                while let Some(StrictValue(v)) = a.next_element()? {
                    if out.len() >= 256 {
                        return Err(de::Error::custom("list limit exceeded"));
                    }
                    out.push(v);
                }
                Ok(StrictValue(out.into()))
            }
            fn visit_map<A: MapAccess<'de>>(
                self,
                mut a: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                let mut out = BTreeMap::new();
                while let Some(k) = a.next_key::<String>()? {
                    if out.contains_key(&k) {
                        return Err(de::Error::custom(format!("duplicate key {k}")));
                    }
                    let StrictValue(v) = a.next_value()?;
                    out.insert(k, v);
                }
                Ok(StrictValue(
                    serde_json::to_value(out).map_err(de::Error::custom)?,
                ))
            }
        }
        d.deserialize_any(V)
    }
}
fn invalid(message: &str) -> Error {
    Error::new("ERR_PROFILE_INVALID", "configuration", message)
}
fn complexity(value: &Value, depth: usize, count: &mut usize) -> Result<()> {
    *count += 1;
    if depth > 16 || *count > 4096 {
        return Err(invalid("/: profile complexity limit exceeded"));
    }
    match value {
        Value::Array(a) => {
            for v in a {
                complexity(v, depth + 1, count)?;
            }
        }
        Value::Object(o) => {
            for v in o.values() {
                complexity(v, depth + 1, count)?;
            }
        }
        _ => {}
    }
    Ok(())
}
#[derive(Clone)]
pub struct Profile {
    pub id: String,
    pub effective: Value,
    pub digest: String,
    pub required: Vec<String>,
}
impl Profile {
    pub fn parse(text: &str) -> Result<Self> {
        if text.len() > 262144 {
            return Err(invalid("/: profile exceeds 256 KiB"));
        }
        let StrictValue(p) =
            serde_json::from_str(text).map_err(|_| invalid("/: invalid JSON or duplicate keys"))?;
        complexity(&p, 0, &mut 0)?;
        if let Some(e) = SCHEMA.iter_errors(&p).next() {
            return Err(invalid(&format!("{}: {}", e.instance_path(), e)));
        }
        let t = &p["transport"];
        let version = t["httpVersion"].as_str().unwrap_or("auto");
        let min = t["tls"]["minVersion"].as_str().unwrap_or("1.2");
        let max = t["tls"]["maxVersion"].as_str().unwrap_or("1.3");
        if min > max {
            return Err(invalid("/transport/tls: minimum version exceeds maximum"));
        }
        let alpn = t["tls"]["alpn"]
            .as_array()
            .cloned()
            .unwrap_or_else(|| match version {
                "1.1" => vec![json!("http/1.1")],
                "2" => vec![json!("h2")],
                _ => vec![json!("h2"), json!("http/1.1")],
            });
        if (version == "2" && alpn != vec![json!("h2")])
            || (version == "1.1" && alpn != vec![json!("http/1.1")])
        {
            return Err(invalid(
                "/transport/tls/alpn: conflicts with strict HTTP version",
            ));
        }
        // The same forbidden set and limits apply when the profile's headers are
        // merged into a request, so a profile that validates never fails later.
        let headers = p["headers"].as_array().expect("schema checked");
        let mut header_bytes = 0;
        for pair in headers {
            let name = pair[0].as_str().expect("schema checked");
            let value = pair[1].as_str().expect("schema checked");
            let n = name.to_ascii_lowercase();
            if crate::profile_headers::is_transport_header(&n, value)
                || crate::profile_headers::PROFILE_ONLY_FORBIDDEN_HEADERS.contains(&n.as_str())
            {
                return Err(invalid("/headers: profile contains a forbidden header"));
            }
            // Characters, as in TypeScript; every character is one Latin-1 byte.
            header_bytes += name.chars().count() + value.chars().count();
        }
        if headers.len() > crate::profile_headers::MAX_HEADER_PAIRS
            || header_bytes > crate::profile_headers::MAX_HEADER_BYTES
        {
            return Err(invalid("/headers: at most 200 headers and 65536 bytes"));
        }
        let h2 = &t["http2"];
        let effective = json!({
            "defaults": p["defaults"],
            "headers": p["headers"].as_array().expect("schema checked").iter().map(|p| json!([p[0].as_str().expect("schema checked").to_ascii_lowercase(), p[1]])).collect::<Vec<_>>(),
            "transport": {
                "httpVersion": version,
                "tls": crate::profile_tls::normalize(&t["tls"], version)?,
                "http1": crate::profile_headers::normalize_http1(&t["http1"])?,
                "http2": crate::profile_http2::normalize(h2)?
            }
        });
        let mut required = p["requires"]
            .as_array()
            .expect("schema checked")
            .iter()
            .map(|v| v.as_str().expect("schema checked").to_owned())
            .collect::<Vec<_>>();
        // Defaults materialize these options too, so requirements cannot be hidden.
        required.extend(CAPABILITIES[..5].iter().map(|s| (*s).into()));
        let tls = &t["tls"];
        if ["cipherSuites", "signatureAlgorithms", "supportedGroups"]
            .iter()
            .any(|k| tls.get(k).is_some())
        {
            required.push("tls.algorithms.v1".into());
        }
        if [
            "greaseEnabled",
            "greaseSignatureAlgorithms",
            "permuteExtensions",
            "echGrease",
            "ocspStapling",
            "signedCertificateTimestamps",
            "alpsUseNewCodepoint",
        ]
        .iter()
        .any(|k| tls.get(k).is_some())
            || tls.get("alps").is_some()
        {
            required.push("tls.extensions.v1".into());
        }
        if tls.get("trustAnchorIds").is_some() {
            required.push("tls.trust-anchors.v1".into());
        }
        if tls["certificateCompression"]
            .as_array()
            .is_some_and(|a| !a.is_empty())
        {
            required.push("tls.certificate-compression.brotli.v1".into());
        }
        if ["settings", "pseudoHeaderOrder", "headersPriority"]
            .iter()
            .any(|k| h2.get(k).is_some())
        {
            required.push("http2.settings.v1".into());
        }
        if h2.get("hpackHuffman").is_some() {
            required.push("http2.hpack.v1".into());
        }
        if t.get("http1").is_some() {
            required.push("http1.header-format.v1".into());
        }
        required.sort();
        required.dedup();
        let digest = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&effective).expect("JSON config"))
        );
        Ok(Self {
            id: p["id"].as_str().expect("schema checked").into(),
            effective,
            digest,
            required,
        })
    }
    pub fn report(&self) -> Value {
        let issues = self.required.iter().filter(|s| !CAPABILITIES.contains(&s.as_str())).map(|s| json!({"code":"ERR_PROFILE_UNSUPPORTED", "path":"/requires", "message":format!("Missing capability: {s}")})).collect::<Vec<_>>();
        json!({ "compatible": issues.is_empty(), "verification":"custom-unverified", "profileDigest":self.digest, "engineBuildId":BUILD_ID, "requiredCapabilities": self.required, "issues":issues, "normalizedConfig":self.effective })
    }
    pub fn emulation(&self) -> Result<Emulation> {
        if self
            .required
            .iter()
            .any(|s| !CAPABILITIES.contains(&s.as_str()))
        {
            return Err(Error::new(
                "ERR_PROFILE_UNSUPPORTED",
                "initialization",
                "Profile requires an unavailable engine capability",
            ));
        }
        let t = &self.effective["transport"];
        let tls = crate::profile_tls::build(&t["tls"])?;
        let http2 = crate::profile_http2::build(&t["http2"]);
        let mut headers = HeaderMap::new();
        for pair in self.effective["headers"].as_array().expect("normalized") {
            let name = HeaderName::from_bytes(pair[0].as_str().expect("normalized").as_bytes())
                .map_err(|_| invalid("/headers: invalid name"))?;
            let bytes = pair[1]
                .as_str()
                .expect("normalized")
                .chars()
                .map(|c| c as u8)
                .collect::<Vec<_>>();
            let value =
                HeaderValue::from_bytes(&bytes).map_err(|_| invalid("/headers: invalid value"))?;
            headers.append(name, value);
        }
        Ok(Emulation::builder()
            .tls_options(tls)
            .http2_options(http2)
            .headers(headers)
            .build(Group::new(self.digest.clone())))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const CUSTOM: &str = include_str!("../../../profiles/neutral.json");
    #[test]
    fn schema_and_digest() {
        let p = Profile::parse(CUSTOM).unwrap();
        assert!(p.report()["compatible"].as_bool().unwrap());
        assert_eq!(p.digest.len(), 64);
        let mut v: Value = serde_json::from_str(CUSTOM).unwrap();
        v["id"] = json!("other");
        v["target"]["family"] = json!("chrome");
        assert_eq!(p.digest, Profile::parse(&v.to_string()).unwrap().digest);
        v["transport"]["tls"] = json!({"alpn":["http/1.1"]});
        assert_ne!(p.digest, Profile::parse(&v.to_string()).unwrap().digest);
    }
    #[test]
    fn rejects_duplicates_unknown_fields_and_conflicts() {
        assert!(
            Profile::parse(&CUSTOM.replacen(
                "\"schemaVersion\": 1",
                "\"schemaVersion\": 1, \"schemaVersion\": 1",
                1
            ))
            .is_err()
        );
        let mut v: Value = serde_json::from_str(CUSTOM).unwrap();
        v["transport"]["tls"] = json!({"verify":false});
        assert!(Profile::parse(&v.to_string()).is_err());
        v["transport"]["tls"] = json!({"minVersion":"1.3", "maxVersion":"1.2"});
        assert!(Profile::parse(&v.to_string()).is_err());
        v["transport"]["tls"] = json!({"alpn":["http/1.1"]});
        v["transport"]["httpVersion"] = json!("2");
        assert!(Profile::parse(&v.to_string()).is_err());
    }
}
