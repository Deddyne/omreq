//! One client-owned, in-memory cookie store. No transport jar is used in parallel.
//!
//! The caller serializes access and supplies Unix seconds for deterministic clocks.
//! SameSite is retained as metadata: this client has no browser top-level context.
//! Record bytes charge owned string bytes and the fixed Rust record, not total RSS.
//!
//! Parsing follows RFC 6265bis: name/value reject only CTLs (except HTAB), so
//! cookies that browsers keep (spaces, quotes, commas, UTF-8, nameless) are kept.
//! Records are indexed by cookie domain, so a request only visits the buckets for
//! its host and that host's parent domains instead of scanning the whole jar.
use crate::error::{Error, Result};
use serde::Serialize;
use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::mem::size_of;
use url::{Host, Url};

pub(crate) const PSL_VERSION: &str = "psl/2.1.254";
const MAX_COOKIES: usize = 3_000;
const MAX_DOMAIN_COOKIES: usize = 180;
/// RFC 6265bis: limit on the cookie name plus value octets.
const MAX_COOKIE_BYTES: usize = 4 * 1024;
/// RFC 6265bis: longer attribute values are ignored. Also bounds stored paths.
const MAX_ATTRIBUTE_BYTES: usize = 1024;
const MAX_DOMAIN_BYTES: usize = 255;
const MAX_JAR_BYTES: usize = 12 * 1024 * 1024;
const MAX_HEADER_BYTES: usize = 64 * 1024;
/// RFC 6265bis: Expires and Max-Age are capped at 400 days from now.
const MAX_LIFETIME_SECONDS: i64 = 400 * 24 * 60 * 60;
/// Largest integer JavaScript represents exactly (2^53 - 1).
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const MAX_SAFE_COUNTER: u64 = MAX_SAFE_INTEGER as u64;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub(crate) enum SameSite {
    Strict,
    Lax,
    None,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CookieRecord {
    /// Empty for a nameless cookie (RFC 6265bis), which is sent as its value only.
    pub name: String,
    pub value: String,
    pub domain: String,
    pub path: String,
    pub host_only: bool,
    pub secure: bool,
    pub http_only: bool,
    pub same_site: Option<SameSite>,
    /// Unix seconds; None means a session cookie. Always within +/-(2^53 - 1).
    pub expires_at: Option<i64>,
}
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CookieStats {
    pub cookie_count: usize,
    pub cookie_bytes: usize,
    pub discarded_cookies: u64,
    pub partitioned_cookies: u64,
    pub evicted_cookies: u64,
}
struct Stored {
    cookie: CookieRecord,
    /// Name/value arrived as non-UTF-8 header bytes and are stored Latin-1
    /// decoded (one char per octet), so `header_bytes` re-emits the exact octets.
    latin1: bool,
    created: u64,
    used: u64,
    bytes: usize,
}
/// All records whose cookie domain is the bucket key.
struct Bucket {
    /// Registrable domain (or IP) of the key, for per-domain limits.
    group: String,
    entries: Vec<Stored>,
}
#[derive(Default)]
struct Group {
    count: usize,
    /// Bucket keys belonging to this group; nonempty exactly when count > 0.
    domains: Vec<String>,
}
#[derive(Clone, Copy)]
struct Limits {
    total: usize,
    per_domain: usize,
    /// Name plus value octets.
    record_bytes: usize,
    total_bytes: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            total: MAX_COOKIES,
            per_domain: MAX_DOMAIN_COOKIES,
            record_bytes: MAX_COOKIE_BYTES,
            total_bytes: MAX_JAR_BYTES,
        }
    }
}
pub(crate) struct CookieJar {
    /// Keyed by cookie domain (host for host-only cookies).
    domains: HashMap<String, Bucket>,
    /// Keyed by registrable domain (or IP), for per-domain limits and eviction.
    groups: HashMap<String, Group>,
    /// Count of Secure records per name, so insecure overwrite checks are rare.
    secure_names: HashMap<String, usize>,
    count: usize,
    bytes: usize,
    /// Lower bound on the earliest stored expiry; full expiry sweeps are skipped before it.
    next_expiry: Option<i64>,
    tick: u64,
    limits: Limits,
    discarded: u64,
    partitioned: u64,
    evicted: u64,
}
impl Default for CookieJar {
    fn default() -> Self {
        Self::new()
    }
}
impl CookieJar {
    pub fn new() -> Self {
        Self {
            domains: HashMap::new(),
            groups: HashMap::new(),
            secure_names: HashMap::new(),
            count: 0,
            bytes: 0,
            next_expiry: None,
            tick: 0,
            limits: Limits::default(),
            discarded: 0,
            partitioned: 0,
            evicted: 0,
        }
    }
    /// Explicit application API: malformed or unsupported cookies are errors.
    /// Errors deliberately contain no cookie, URL, name, or value.
    pub fn set_cookie(&mut self, value: &str, url: &Url, now: i64) -> Result<()> {
        self.store(value, false, url, now)
    }
    /// Response-header API: a discarded cookie never fails a successful response.
    #[cfg(test)]
    pub fn receive_cookie(&mut self, value: &str, url: &Url, now: i64) {
        self.receive_cookie_bytes(value.as_bytes(), url, now);
    }
    /// Response-header API for raw Set-Cookie field bytes. Valid UTF-8 is kept
    /// losslessly; otherwise octets are treated as opaque Latin-1 so they
    /// round-trip through `header_bytes`. Rejects count as discarded cookies.
    pub fn receive_cookie_bytes(&mut self, value: &[u8], url: &Url, now: i64) {
        let _ = match std::str::from_utf8(value) {
            Ok(text) => self.store(text, false, url, now),
            Err(_) => {
                let text = value
                    .iter()
                    .map(|&byte| char::from(byte))
                    .collect::<String>();
                self.store(&text, true, url, now)
            }
        };
    }
    pub fn get_cookies(&mut self, url: &Url, now: i64) -> Result<Vec<CookieRecord>> {
        let host = request_host(url)?;
        self.expire(now);
        let tick = self.next_tick();
        let mut records = Vec::new();
        for (offset, index) in self.matching(url, &host) {
            let entry = self.entry_mut(&host[offset..], index);
            entry.used = tick;
            records.push(entry.cookie.clone());
        }
        Ok(records)
    }
    /// Cookie header text for the request. Cookies stored from non-UTF-8 header
    /// bytes are omitted; use `header_bytes` to send them exactly.
    /// See `header_bytes` for ordering and the size bound.
    #[cfg(test)]
    pub fn header(&mut self, url: &Url, now: i64) -> Result<Option<String>> {
        Ok(self
            .build_header(url, now, true)?
            .map(|bytes| String::from_utf8(bytes).expect("UTF-8 cookie records")))
    }
    /// Exact Cookie header octets, valid for `HeaderValue::from_bytes` (no CTL
    /// other than HTAB). Cookies are emitted in RFC 6265bis order (longer paths,
    /// then earlier creation). When all matching cookies would exceed 64 KiB, the
    /// least recently sent or set ones are omitted until the rest fits; omitted
    /// cookies stay stored. The request itself never fails here.
    pub fn header_bytes(&mut self, url: &Url, now: i64) -> Result<Option<Vec<u8>>> {
        self.build_header(url, now, false)
    }
    /// Clear stored credentials; diagnostic counters remain cumulative.
    pub fn clear(&mut self) {
        self.domains.clear();
        self.groups.clear();
        self.secure_names.clear();
        self.count = 0;
        self.bytes = 0;
        self.next_expiry = None;
    }
    pub fn stats(&mut self, now: i64) -> CookieStats {
        self.expire(now);
        CookieStats {
            cookie_count: self.count,
            cookie_bytes: self.bytes,
            discarded_cookies: self.discarded,
            partitioned_cookies: self.partitioned,
            evicted_cookies: self.evicted,
        }
    }
    fn store(&mut self, value: &str, latin1: bool, url: &Url, now: i64) -> Result<()> {
        self.expire(now);
        let result = self.insert(value, latin1, url, now);
        if result.is_err() {
            increment(&mut self.discarded);
        }
        result
    }
    fn build_header(&mut self, url: &Url, now: i64, utf8_only: bool) -> Result<Option<Vec<u8>>> {
        let host = request_host(url)?;
        self.expire(now);
        let tick = self.next_tick();
        // (bucket offset, index, serialized length including the "; " separator, last use)
        let mut items = Vec::new();
        let mut total = 0;
        for (offset, index) in self.matching(url, &host) {
            let entry = self.entry_mut(&host[offset..], index);
            if utf8_only && entry.latin1 {
                continue;
            }
            let name = &entry.cookie.name;
            let length = 2
                + wire_len(name, entry.latin1)
                + usize::from(!name.is_empty())
                + wire_len(&entry.cookie.value, entry.latin1);
            total += length;
            items.push((offset, index, length, entry.used));
        }
        // The first cookie has no separator.
        let mut keep = vec![true; items.len()];
        if total.saturating_sub(2) > MAX_HEADER_BYTES {
            // Omit least recently used cookies first (later RFC order on ties)
            // until the rest fits, so a fresh cookie is still sent.
            let mut order = (0..items.len()).collect::<Vec<_>>();
            order.sort_by_key(|&i| (items[i].3, std::cmp::Reverse(i)));
            for i in order {
                if total.saturating_sub(2) <= MAX_HEADER_BYTES {
                    break;
                }
                keep[i] = false;
                total -= items[i].2;
            }
        }
        let mut header = Vec::with_capacity(total.saturating_sub(2));
        for (&(offset, index, _, _), _) in items.iter().zip(&keep).filter(|(_, keep)| **keep) {
            let entry = self.entry_mut(&host[offset..], index);
            if !header.is_empty() {
                header.extend_from_slice(b"; ");
            }
            if !entry.cookie.name.is_empty() {
                push_wire(&mut header, &entry.cookie.name, entry.latin1);
                header.push(b'=');
            }
            push_wire(&mut header, &entry.cookie.value, entry.latin1);
            entry.used = tick;
        }
        Ok((!header.is_empty()).then_some(header))
    }
    /// Matching records as (offset of the bucket key within `host`, index), in
    /// RFC 6265bis order. Only buckets keyed by `host` or a parent domain of it
    /// can match, so only those are visited.
    fn matching(&self, url: &Url, host: &str) -> Vec<(usize, usize)> {
        let is_ip = !matches!(url.host(), Some(Host::Domain(_)));
        let offsets = std::iter::once(0).chain(
            host.match_indices('.')
                .map(|(dot, _)| dot + 1)
                .filter(move |_| !is_ip),
        );
        let mut found = Vec::new();
        for offset in offsets {
            if let Some(bucket) = self.domains.get(&host[offset..]) {
                for (index, entry) in bucket.entries.iter().enumerate() {
                    if matches_url(&entry.cookie, url, host) {
                        found.push((offset, index, entry.cookie.path.len(), entry.created));
                    }
                }
            }
        }
        found.sort_by(|a, b| b.2.cmp(&a.2).then(a.3.cmp(&b.3)));
        found
            .into_iter()
            .map(|(offset, index, _, _)| (offset, index))
            .collect()
    }
    fn entry_mut(&mut self, domain: &str, index: usize) -> &mut Stored {
        &mut self
            .domains
            .get_mut(domain)
            .expect("indexed cookie bucket")
            .entries[index]
    }
    fn insert(&mut self, value: &str, latin1: bool, url: &Url, now: i64) -> Result<()> {
        let host = request_host(url)?;
        let parsed =
            parse_set_cookie(value, latin1, self.limits.record_bytes).ok_or_else(invalid_cookie)?;
        if parsed.partitioned {
            increment(&mut self.partitioned);
            return Err(invalid_cookie());
        }
        let name = parsed.name;
        // An empty Domain (also "Domain=.") leaves the cookie host-only.
        let (domain, host_only) = match parsed.domain.filter(|domain| !domain.is_empty()) {
            None => (host.clone(), true),
            Some(domain) => {
                if domain.ends_with('.') {
                    return Err(invalid_cookie());
                }
                let Host::Domain(domain) = Host::parse(domain).map_err(|_| invalid_cookie())?
                else {
                    // IP cookies remain host-only. Domain cannot broaden an address.
                    return Err(invalid_cookie());
                };
                if domain.starts_with('.') {
                    return Err(invalid_cookie());
                }
                if psl::suffix_str(&domain) == Some(domain.as_str()) {
                    // 6265bis: a public suffix is allowed only as the request host itself,
                    // and then the cookie is host-only.
                    if domain != host {
                        return Err(invalid_cookie());
                    }
                    (host.clone(), true)
                } else if domain_matches(&host, &domain) {
                    (domain, false)
                } else {
                    return Err(invalid_cookie());
                }
            }
        };
        let path = parsed
            .path
            .filter(|path| path.starts_with('/'))
            .map(str::to_owned)
            .unwrap_or_else(|| default_path(url.path()).to_owned());
        if domain.len() > MAX_DOMAIN_BYTES || path.len() > MAX_ATTRIBUTE_BYTES {
            return Err(invalid_cookie());
        }
        let secure = parsed.secure;
        let same_site = parsed.same_site;
        // Follow 6265bis-22 UA prefix checks, including case-insensitive variants.
        let secure_prefix = starts_with_ignore_case(name, "__Secure-");
        let host_prefix = starts_with_ignore_case(name, "__Host-");
        if secure && url.scheme() != "https"
            || same_site == Some(SameSite::None) && !secure
            || secure_prefix && !secure
            || host_prefix && (!secure || !host_only || parsed.path != Some("/"))
        {
            return Err(invalid_cookie());
        }
        // An insecure response must not overwrite/delete an overlapping Secure cookie.
        if !secure
            && url.scheme() != "https"
            && self.secure_names.contains_key(name)
            && self.records().any(|entry| {
                entry.cookie.secure
                    && entry.cookie.name == name
                    && (domain_matches(&domain, &entry.cookie.domain)
                        || domain_matches(&entry.cookie.domain, &domain))
                    && path_matches(&path, &entry.cookie.path)
            })
        {
            return Err(invalid_cookie());
        }
        let cap = now.saturating_add(MAX_LIFETIME_SECONDS);
        let expires_at = parsed
            .max_age
            .map(|age| now.saturating_add(age))
            .or(parsed.expires)
            .map(|expiry| expiry.min(cap).clamp(-MAX_SAFE_INTEGER, MAX_SAFE_INTEGER));
        let latin1 = latin1 && !(name.is_ascii() && parsed.value.is_ascii());
        let cookie = CookieRecord {
            name: name.to_owned(),
            value: parsed.value.to_owned(),
            domain,
            path,
            host_only,
            secure,
            http_only: parsed.http_only,
            same_site,
            expires_at,
        };
        let bytes = size_of::<Stored>()
            + cookie.name.len()
            + cookie.value.len()
            + cookie.domain.len()
            + cookie.path.len();
        if bytes > self.limits.total_bytes {
            return Err(invalid_cookie());
        }
        // Normalize the sequence, if needed, before saving replacement age.
        let tick = self.next_tick();
        let existing = self.domains.get(&cookie.domain).and_then(|bucket| {
            bucket.entries.iter().position(|entry| {
                entry.cookie.name == cookie.name
                    && entry.cookie.path == cookie.path
                    && (cookie.name.is_ascii() || entry.latin1 == latin1)
            })
        });
        let created = existing.map(|index| self.domains[&cookie.domain].entries[index].created);
        if let Some(index) = existing {
            let domain = cookie.domain.clone();
            self.remove(&domain, index, false);
        }
        if cookie.expires_at.is_some_and(|expiry| expiry <= now) {
            return Ok(());
        }
        // Remove the replaced record before testing limits: an update at capacity
        // must not evict an unrelated cookie or count as a resource eviction.
        // Expired records were already swept by `store`, so eviction is by
        // non-Secure first, then least recently used.
        let group = group_of(&cookie.domain).to_owned();
        while self
            .groups
            .get(&group)
            .is_some_and(|entry| entry.count >= self.limits.per_domain)
        {
            self.evict(Some(&group));
        }
        while self.count >= self.limits.total || self.bytes + bytes > self.limits.total_bytes {
            self.evict(None);
        }
        self.push(
            Stored {
                cookie,
                latin1,
                created: created.unwrap_or(tick),
                used: tick,
                bytes,
            },
            group,
        );
        Ok(())
    }
    fn push(&mut self, stored: Stored, group: String) {
        if let Some(expiry) = stored.cookie.expires_at {
            self.next_expiry = Some(self.next_expiry.map_or(expiry, |next| next.min(expiry)));
        }
        if stored.cookie.secure {
            *self
                .secure_names
                .entry(stored.cookie.name.clone())
                .or_default() += 1;
        }
        self.count += 1;
        self.bytes += stored.bytes;
        let members = self.groups.entry(group.clone()).or_default();
        members.count += 1;
        match self.domains.entry(stored.cookie.domain.clone()) {
            Entry::Occupied(bucket) => bucket.into_mut().entries.push(stored),
            Entry::Vacant(bucket) => {
                members.domains.push(bucket.key().clone());
                bucket.insert(Bucket {
                    group,
                    entries: vec![stored],
                });
            }
        }
    }
    fn records(&self) -> impl Iterator<Item = &Stored> {
        self.domains
            .values()
            .flat_map(|bucket| bucket.entries.iter())
    }
    fn expire(&mut self, now: i64) {
        if self.next_expiry.is_none_or(|next| next > now) {
            return;
        }
        let Self {
            domains,
            groups,
            secure_names,
            count,
            bytes,
            ..
        } = self;
        let mut next: Option<i64> = None;
        domains.retain(|domain, bucket| {
            let group = groups.get_mut(&bucket.group).expect("indexed cookie group");
            bucket
                .entries
                .retain(|entry| match entry.cookie.expires_at {
                    Some(expiry) if expiry <= now => {
                        *count -= 1;
                        *bytes -= entry.bytes;
                        group.count -= 1;
                        if entry.cookie.secure {
                            release_name(secure_names, &entry.cookie.name);
                        }
                        false
                    }
                    expiry => {
                        if let Some(expiry) = expiry {
                            next = Some(next.map_or(expiry, |next| next.min(expiry)));
                        }
                        true
                    }
                });
            if bucket.entries.is_empty() {
                group.domains.retain(|member| member != domain);
            }
            !bucket.entries.is_empty()
        });
        groups.retain(|_, group| group.count > 0);
        self.next_expiry = next;
    }
    fn remove(&mut self, domain: &str, index: usize, evicted: bool) {
        let bucket = self.domains.get_mut(domain).expect("indexed cookie bucket");
        let stored = bucket.entries.swap_remove(index);
        let emptied = bucket.entries.is_empty();
        let group_key = bucket.group.clone();
        if emptied {
            self.domains.remove(domain);
        }
        let group = self
            .groups
            .get_mut(&group_key)
            .expect("indexed cookie group");
        group.count -= 1;
        if emptied {
            group.domains.retain(|member| member != domain);
        }
        if group.count == 0 {
            self.groups.remove(&group_key);
        }
        self.count -= 1;
        self.bytes -= stored.bytes;
        if stored.cookie.secure {
            release_name(&mut self.secure_names, &stored.cookie.name);
        }
        if evicted {
            increment(&mut self.evicted);
        }
    }
    /// Evict the least recently used record, preferring non-Secure records.
    fn evict(&mut self, group: Option<&str>) {
        let rank = |entry: &Stored| (entry.cookie.secure, entry.used, entry.created);
        let candidates: Box<dyn Iterator<Item = (&String, &Bucket)>> = match group {
            Some(group) => Box::new(
                self.groups[group]
                    .domains
                    .iter()
                    .map(|domain| (domain, &self.domains[domain])),
            ),
            None => Box::new(self.domains.iter()),
        };
        let (domain, index) = candidates
            .flat_map(|(domain, bucket)| {
                bucket
                    .entries
                    .iter()
                    .enumerate()
                    .map(move |(index, entry)| (rank(entry), domain, index))
            })
            .min_by_key(|(rank, _, _)| *rank)
            .map(|(_, domain, index)| (domain.clone(), index))
            .expect("nonzero jar limits and a matching eviction candidate");
        self.remove(&domain, index, true);
    }
    fn next_tick(&mut self) -> u64 {
        if self.tick == u64::MAX {
            // Extremely long-lived clients retain deterministic ordering on wrap.
            let mut order = self
                .domains
                .values_mut()
                .flat_map(|bucket| bucket.entries.iter_mut())
                .collect::<Vec<_>>();
            order.sort_by_key(|entry| entry.created);
            for (rank, entry) in order.iter_mut().enumerate() {
                entry.created = rank as u64;
            }
            order.sort_by_key(|entry| entry.used);
            for (rank, entry) in order.iter_mut().enumerate() {
                entry.used = rank as u64;
            }
            self.tick = order.len() as u64;
        }
        self.tick += 1;
        self.tick
    }
}
/// RFC 6265bis 5.6 parse of one Set-Cookie field value.
struct ParsedCookie<'a> {
    name: &'a str,
    value: &'a str,
    /// Last non-empty Domain attribute with one leading dot removed (may be empty).
    domain: Option<&'a str>,
    /// Last Path attribute value, before validation.
    path: Option<&'a str>,
    max_age: Option<i64>,
    expires: Option<i64>,
    secure: bool,
    http_only: bool,
    same_site: Option<SameSite>,
    partitioned: bool,
}
fn parse_set_cookie(line: &str, latin1: bool, max_bytes: usize) -> Option<ParsedCookie<'_>> {
    // CTLs other than HTAB abort; DEL included. Everything else (including
    // obs-text, quotes, commas, backslashes, and spaces) is opaque data.
    if line
        .bytes()
        .any(|byte| byte < 0x20 && byte != b'\t' || byte == 0x7f)
    {
        return None;
    }
    let (pair, attributes) = line.split_once(';').unwrap_or((line, ""));
    let (name, value) = pair.split_once('=').unwrap_or(("", pair));
    let (name, value) = (trim_wsp(name), trim_wsp(value));
    if name.is_empty() && value.is_empty()
        || wire_len(name, latin1) + wire_len(value, latin1) > max_bytes
        || name.is_empty()
            && (starts_with_ignore_case(value, "__Secure-")
                || starts_with_ignore_case(value, "__Host-"))
    {
        return None;
    }
    let mut parsed = ParsedCookie {
        name,
        value,
        domain: None,
        path: None,
        max_age: None,
        expires: None,
        secure: false,
        http_only: false,
        same_site: None,
        partitioned: false,
    };
    for attribute in attributes.split(';') {
        let (key, value) = attribute.split_once('=').unwrap_or((attribute, ""));
        let (key, value) = (trim_wsp(key), trim_wsp(value));
        if value.len() > MAX_ATTRIBUTE_BYTES {
            continue;
        }
        if key.eq_ignore_ascii_case("expires") {
            if let Some(expiry) = parse_cookie_date(value) {
                parsed.expires = Some(expiry);
            }
        } else if key.eq_ignore_ascii_case("max-age") {
            // Empty/invalid attributes are ignored, rather than accidentally
            // becoming i64::MAX through a permissive parser's overflow path.
            if let Some(age) = parse_max_age(value) {
                parsed.max_age = Some(age);
            }
        } else if key.eq_ignore_ascii_case("domain") {
            if !value.is_empty() {
                parsed.domain = Some(value.strip_prefix('.').unwrap_or(value));
            }
        } else if key.eq_ignore_ascii_case("path") {
            parsed.path = Some(value);
        } else if key.eq_ignore_ascii_case("secure") {
            parsed.secure = true;
        } else if key.eq_ignore_ascii_case("httponly") {
            parsed.http_only = true;
        } else if key.eq_ignore_ascii_case("samesite") {
            parsed.same_site = if value.eq_ignore_ascii_case("strict") {
                Some(SameSite::Strict)
            } else if value.eq_ignore_ascii_case("lax") {
                Some(SameSite::Lax)
            } else if value.eq_ignore_ascii_case("none") {
                Some(SameSite::None)
            } else {
                None
            };
        } else if key.eq_ignore_ascii_case("partitioned") {
            parsed.partitioned = true;
        }
    }
    Some(parsed)
}
fn trim_wsp(value: &str) -> &str {
    value.trim_matches([' ', '\t'])
}
fn starts_with_ignore_case(value: &str, prefix: &str) -> bool {
    value
        .as_bytes()
        .get(..prefix.len())
        .is_some_and(|start| start.eq_ignore_ascii_case(prefix.as_bytes()))
}
/// Octets on the wire: Latin-1 records encode each char as one octet.
fn wire_len(value: &str, latin1: bool) -> usize {
    if latin1 {
        value.chars().count()
    } else {
        value.len()
    }
}
fn push_wire(out: &mut Vec<u8>, value: &str, latin1: bool) {
    if latin1 {
        // Latin-1 records only hold chars decoded from single octets.
        out.extend(value.chars().map(|c| c as u8));
    } else {
        out.extend_from_slice(value.as_bytes());
    }
}
fn release_name(names: &mut HashMap<String, usize>, name: &str) {
    if let Some(count) = names.get_mut(name) {
        *count -= 1;
        if *count == 0 {
            names.remove(name);
        }
    }
}
fn group_of(domain: &str) -> &str {
    if domain.parse::<std::net::IpAddr>().is_ok() {
        domain
    } else {
        psl::domain_str(domain).unwrap_or(domain)
    }
}
fn increment(value: &mut u64) {
    *value = value.saturating_add(1).min(MAX_SAFE_COUNTER);
}
fn invalid_cookie() -> Error {
    Error::new(
        "ERR_INVALID_COOKIE",
        "configuration",
        "Cookie is invalid or unsupported",
    )
}
fn request_host(url: &Url) -> Result<String> {
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(Error::new(
            "ERR_INVALID_ARGUMENT",
            "configuration",
            "Cookie URL must be HTTP(S) without credentials",
        ));
    }
    match url.host() {
        Some(Host::Domain(domain)) => Ok(domain.to_owned()),
        Some(Host::Ipv4(address)) => Ok(address.to_string()),
        Some(Host::Ipv6(address)) => Ok(address.to_string()),
        None => Err(Error::new(
            "ERR_INVALID_ARGUMENT",
            "configuration",
            "Cookie URL needs a host",
        )),
    }
}
fn parse_max_age(value: &str) -> Option<i64> {
    let negative = value.starts_with('-');
    let digits = value.strip_prefix('-').unwrap_or(value);
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some(if negative {
        0
    } else {
        digits.parse().unwrap_or(i64::MAX)
    })
}
/// RFC 6265bis 5.4.1 cookie-date algorithm; returns Unix seconds.
fn parse_cookie_date(input: &str) -> Option<i64> {
    let delimiter =
        |byte: &u8| matches!(byte, 0x09 | 0x20..=0x2f | 0x3b..=0x40 | 0x5b..=0x60 | 0x7b..=0x7e);
    let (mut time, mut day, mut month, mut year) = (None, None, None, None);
    for token in input
        .as_bytes()
        .split(delimiter)
        .filter(|token| !token.is_empty())
    {
        if time.is_none()
            && let Some(value) = parse_time(token)
        {
            time = Some(value);
        } else if day.is_none()
            && let Some(value) = leading_digits(token, 1, 2)
        {
            day = Some(value);
        } else if month.is_none()
            && let Some(value) = parse_month(token)
        {
            month = Some(value);
        } else if year.is_none()
            && let Some(value) = leading_digits(token, 2, 4)
        {
            year = Some(value);
        }
    }
    let ((hour, minute, second), day, month, mut year) = (time?, day?, month?, year?);
    if (70..=99).contains(&year) {
        year += 1900;
    } else if (0..=69).contains(&year) {
        year += 2000;
    }
    if !(1..=31).contains(&day)
        || year < 1601
        || hour > 23
        || minute > 59
        || second > 59
        || day > days_in_month(year, month)
    {
        return None;
    }
    Some(days_from_civil(year, month, day) * 86_400 + hour * 3_600 + minute * 60 + second)
}
/// `min..=max` DIGITs, then optionally a non-digit and any octets.
fn leading_digits(token: &[u8], min: usize, max: usize) -> Option<i64> {
    let digits = token
        .iter()
        .take_while(|byte| byte.is_ascii_digit())
        .count();
    (min..=max).contains(&digits).then(|| {
        token[..digits]
            .iter()
            .fold(0, |total, &byte| total * 10 + i64::from(byte - b'0'))
    })
}
/// `1*2DIGIT ":" 1*2DIGIT ":" 1*2DIGIT [ non-digit *OCTET ]`.
fn parse_time(token: &[u8]) -> Option<(i64, i64, i64)> {
    let mut rest = token;
    let mut fields = [0; 3];
    for (index, field) in fields.iter_mut().enumerate() {
        let digits = rest.iter().take_while(|byte| byte.is_ascii_digit()).count();
        *field = leading_digits(rest, 1, 2)?;
        rest = &rest[digits..];
        if index < 2 {
            rest = rest.strip_prefix(b":")?;
        }
    }
    Some((fields[0], fields[1], fields[2]))
}
fn parse_month(token: &[u8]) -> Option<i64> {
    const MONTHS: [&[u8; 3]; 12] = [
        b"jan", b"feb", b"mar", b"apr", b"may", b"jun", b"jul", b"aug", b"sep", b"oct", b"nov",
        b"dec",
    ];
    let prefix = token.get(..3)?;
    MONTHS
        .iter()
        .position(|month| prefix.eq_ignore_ascii_case(*month))
        .map(|index| index as i64 + 1)
}
fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}
/// Days since 1970-01-01 for a proleptic Gregorian date.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let day_of_year = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}
fn domain_matches(host: &str, domain: &str) -> bool {
    host == domain
        || host
            .strip_suffix(domain)
            .is_some_and(|prefix| prefix.ends_with('.'))
}
fn default_path(path: &str) -> &str {
    match path.rfind('/') {
        Some(index) if index > 0 => &path[..index],
        _ => "/",
    }
}
fn path_matches(request: &str, cookie: &str) -> bool {
    request == cookie
        || request
            .strip_prefix(cookie)
            .is_some_and(|suffix| cookie.ends_with('/') || suffix.starts_with('/'))
}
fn matches_url(cookie: &CookieRecord, url: &Url, host: &str) -> bool {
    (if cookie.host_only {
        host == cookie.domain
    } else {
        domain_matches(host, &cookie.domain)
    }) && path_matches(url.path(), &cookie.path)
        && (!cookie.secure || url.scheme() == "https")
}

#[cfg(test)]
mod tests {
    use super::*;
    const NOW: i64 = 1_800_000_000;
    fn url(value: &str) -> Url {
        Url::parse(value).unwrap()
    }
    fn set(jar: &mut CookieJar, value: &str, at: &str) {
        jar.set_cookie(value, &url(at), NOW).unwrap();
    }
    fn header(jar: &mut CookieJar, at: &str) -> Option<String> {
        jar.header(&url(at), NOW).unwrap()
    }
    fn limited(total: usize, per_domain: usize, total_bytes: usize) -> CookieJar {
        let mut jar = CookieJar::new();
        jar.limits = Limits {
            total,
            per_domain,
            record_bytes: MAX_COOKIE_BYTES,
            total_bytes,
        };
        jar
    }
    fn records(jar: &CookieJar) -> Vec<&Stored> {
        jar.records().collect()
    }
    /// The domain index, group index, and counters agree with the records.
    fn assert_invariants(jar: &CookieJar) {
        let all = records(jar);
        assert_eq!(jar.count, all.len());
        assert_eq!(
            jar.bytes,
            all.iter().map(|entry| entry.bytes).sum::<usize>()
        );
        for (domain, bucket) in &jar.domains {
            assert!(!bucket.entries.is_empty());
            assert_eq!(bucket.group, group_of(domain));
            assert!(bucket.entries.iter().all(|e| &e.cookie.domain == domain));
            assert!(jar.groups[&bucket.group].domains.contains(domain));
        }
        for (group, members) in &jar.groups {
            let count = members
                .domains
                .iter()
                .map(|domain| jar.domains[domain].entries.len())
                .sum::<usize>();
            assert!(count > 0 && count == members.count, "{group}");
        }
        let secure = all.iter().filter(|entry| entry.cookie.secure).count();
        assert_eq!(jar.secure_names.values().sum::<usize>(), secure);
    }
    #[test]
    fn host_only_domain_idna_and_ip_scope() {
        let mut jar = CookieJar::new();
        set(&mut jar, "h=host", "https://a.example.com/");
        set(
            &mut jar,
            "d=domain; Domain=.EXAMPLE.com",
            "https://a.example.com/",
        );
        assert_eq!(
            header(&mut jar, "https://a.example.com:8443/"),
            Some("h=host; d=domain".into())
        );
        assert_eq!(
            header(&mut jar, "https://b.example.com/"),
            Some("d=domain".into())
        );
        assert_eq!(header(&mut jar, "https://badexample.com/"), None);
        set(&mut jar, "i=ipv4", "http://127.0.0.1/");
        assert_eq!(header(&mut jar, "http://127.0.0.2/"), None);
        set(&mut jar, "v=ipv6", "http://[::1]/");
        assert_eq!(
            header(&mut jar, "http://[::1]:8080/"),
            Some("v=ipv6".into())
        );
        set(
            &mut jar,
            "u=idna; Domain=bücher.de",
            "https://shop.bücher.de/",
        );
        assert_eq!(
            header(&mut jar, "https://xn--bcher-kva.de/"),
            Some("u=idna".into())
        );
        for (value, at) in [
            ("a=x; Domain=other.com", "https://example.com/"),
            ("a=x; Domain=127.0.0.1", "http://127.0.0.1/"),
            ("a=x; Domain=example.com.", "https://example.com/"),
            ("a=x; Domain=..example.com", "https://example.com/"),
        ] {
            assert_eq!(
                jar.set_cookie(value, &url(at), NOW).unwrap_err().code,
                "ERR_INVALID_COOKIE"
            );
        }
    }
    #[test]
    fn actual_psl_includes_private_wildcard_and_exception_rules() {
        let mut jar = CookieJar::new();
        for (domain, at) in [
            ("com", "https://site.com/"),
            ("co.uk", "https://site.co.uk/"),
            ("github.io", "https://alice.github.io/"),
            ("foo.ck", "https://a.foo.ck/"),
        ] {
            assert!(
                jar.set_cookie(&format!("x=y; Domain={domain}"), &url(at), NOW)
                    .is_err(),
                "{domain}"
            );
        }
        set(&mut jar, "a=1; Domain=www.ck", "https://x.www.ck/");
        assert_eq!(header(&mut jar, "https://www.ck/"), Some("a=1".into()));
        set(
            &mut jar,
            "b=2; Domain=alice.github.io",
            "https://sub.alice.github.io/",
        );
        assert_eq!(
            header(&mut jar, "https://alice.github.io/"),
            Some("b=2".into())
        );
        assert_eq!(PSL_VERSION, "psl/2.1.254");
    }
    #[test]
    fn default_path_matching_and_stable_duplicate_name_order() {
        let mut jar = CookieJar::new();
        set(&mut jar, "id=root; Path=/", "https://example.com/a/b");
        set(&mut jar, "id=default", "https://example.com/a/b");
        set(&mut jar, "id=deep; Path=/a/b", "https://example.com/a/b");
        assert_eq!(
            header(&mut jar, "https://example.com/a/b/c"),
            Some("id=deep; id=default; id=root".into())
        );
        assert_eq!(
            header(&mut jar, "https://example.com/abc"),
            Some("id=root".into())
        );
        set(&mut jar, "other=old; Path=/a", "https://example.com/");
        set(&mut jar, "id=replaced; Path=/a", "https://example.com/");
        assert_eq!(
            header(&mut jar, "https://example.com/a"),
            Some("id=replaced; other=old; id=root".into())
        );
        set(
            &mut jar,
            "fallback=yes; Path=relative",
            "https://example.com/",
        );
        assert!(
            header(&mut jar, "https://example.com/")
                .unwrap()
                .contains("fallback=yes")
        );
    }
    #[test]
    fn expiry_max_age_precedence_deletion_and_saturating_lifetime() {
        let mut jar = CookieJar::new();
        set(
            &mut jar,
            "a=1; Max-Age=10; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
            "https://example.com/",
        );
        set(
            &mut jar,
            "b=2; Max-Age=0; Expires=Tue, 01 Jan 2100 00:00:00 GMT",
            "https://example.com/",
        );
        assert_eq!(
            jar.get_cookies(&url("https://example.com/"), NOW + 9)
                .unwrap()
                .len(),
            1
        );
        assert!(
            jar.get_cookies(&url("https://example.com/"), NOW + 10)
                .unwrap()
                .is_empty()
        );
        set(&mut jar, "session=1", "https://example.com/");
        set(
            &mut jar,
            "session=gone; Max-Age=-10",
            "https://example.com/",
        );
        assert_eq!(header(&mut jar, "https://example.com/"), None);
        set(
            &mut jar,
            "far=1; Max-Age=999999999999999999999999999999",
            "https://example.com/",
        );
        assert_eq!(
            jar.get_cookies(&url("https://example.com/"), NOW).unwrap()[0].expires_at,
            Some(NOW + MAX_LIFETIME_SECONDS)
        );
        set(
            &mut jar,
            "old=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
            "https://example.com/",
        );
        assert_eq!(jar.stats(NOW).cookie_count, 1);
    }
    #[test]
    fn secure_prefixes_samesite_httponly_and_insecure_overwrite_protection() {
        let mut jar = CookieJar::new();
        set(
            &mut jar,
            "__Host-token=s; Secure; Path=/; HttpOnly; SameSite=None",
            "https://example.com/",
        );
        let snapshot = jar.get_cookies(&url("https://example.com/"), NOW).unwrap();
        assert!(snapshot[0].http_only);
        assert_eq!(snapshot[0].same_site, Some(SameSite::None));
        assert_eq!(header(&mut jar, "http://example.com/"), None);
        for (value, at) in [
            ("__Host-token=x; Secure", "https://example.com/"),
            (
                "__Host-token=x; Secure; Path=/; Domain=example.com",
                "https://example.com/",
            ),
            ("__Secure-x=1", "https://example.com/"),
            ("__sEcUrE-x=1", "https://example.com/"),
            ("__hOsT-x=1; Secure; Path=/x", "https://example.com/"),
            ("x=1; SameSite=None", "https://example.com/"),
            ("x=1; Secure", "http://example.com/"),
            ("__Host-token=x; Max-Age=0", "http://example.com/"),
        ] {
            assert!(jar.set_cookie(value, &url(at), NOW).is_err(), "{value}");
        }
        set(
            &mut jar,
            "regular=s; Secure; Path=/account",
            "https://example.com/",
        );
        assert!(
            jar.set_cookie(
                "regular=x; Path=/account/detail",
                &url("http://example.com/"),
                NOW
            )
            .is_err()
        );
        assert!(
            jar.set_cookie(
                "regular=x; Path=/accounting",
                &url("http://example.com/"),
                NOW
            )
            .is_ok()
        );
        assert_eq!(
            jar.get_cookies(&url("https://example.com/"), NOW).unwrap()[0],
            snapshot[0]
        );
    }
    #[test]
    fn malformed_and_partitioned_are_counted_without_retaining_private_diagnostics() {
        let mut jar = CookieJar::new();
        for value in [
            "",
            "=",
            " \t; Path=/",
            "a=x\r\nsecret",
            "a=x\0secret",
            "a=x\u{7f}secret",
            "a\u{1}=x",
            "a=x; Path=/\u{1b}",
            "__Host-nameless",
            "=__sEcUrE-nameless",
            "partition=secret; Secure; Partitioned",
        ] {
            jar.receive_cookie(value, &url("https://example.com/"), NOW);
        }
        let stats = jar.stats(NOW);
        assert_eq!(stats.cookie_count, 0);
        assert_eq!(stats.discarded_cookies, 11);
        assert_eq!(stats.partitioned_cookies, 1);
        let error = jar
            .set_cookie(
                "private\u{1}token=secret",
                &url("https://example.com/"),
                NOW,
            )
            .unwrap_err();
        assert!(!error.message.contains("secret"));
        assert!(!error.message.contains("private"));
        set(
            &mut jar,
            "quoted=\"valid\"; Unknown=ignored",
            "https://example.com/",
        );
        assert_eq!(
            header(&mut jar, "https://example.com/"),
            Some("quoted=\"valid\"".into())
        );
    }
    #[test]
    fn per_registrable_domain_lru_crosses_hosts_and_preserves_other_groups() {
        let mut jar = limited(5, 2, MAX_JAR_BYTES);
        set(&mut jar, "a=1", "https://a.example.co.uk/one");
        set(&mut jar, "b=2", "https://b.example.co.uk/");
        set(&mut jar, "other=3", "https://other.co.uk/");
        header(&mut jar, "https://a.example.co.uk/");
        set(&mut jar, "c=4", "https://c.example.co.uk/");
        assert_eq!(header(&mut jar, "https://b.example.co.uk/"), None);
        assert_eq!(
            header(&mut jar, "https://a.example.co.uk/"),
            Some("a=1".into())
        );
        assert_eq!(
            header(&mut jar, "https://other.co.uk/"),
            Some("other=3".into())
        );
        assert_eq!(jar.stats(NOW).evicted_cookies, 1);
        assert_eq!(jar.groups["example.co.uk"].count, 2);
        assert_invariants(&jar);
    }
    #[test]
    fn global_count_byte_budget_replacement_and_expired_first() {
        let mut jar = limited(2, 2, MAX_JAR_BYTES);
        set(&mut jar, "a=1", "https://a.test/");
        set(&mut jar, "b=2", "https://b.test/");
        set(&mut jar, "a=updated", "https://a.test/");
        assert_eq!(jar.stats(NOW).cookie_count, 2);
        assert_eq!(jar.stats(NOW).evicted_cookies, 0);
        set(&mut jar, "c=3", "https://c.test/");
        assert_eq!(header(&mut jar, "https://b.test/"), None);
        assert_eq!(jar.stats(NOW).evicted_cookies, 1);
        set(&mut jar, "c=3; Max-Age=1", "https://c.test/");
        jar.set_cookie("d=4", &url("https://d.test/"), NOW + 1)
            .unwrap();
        assert_eq!(jar.stats(NOW + 1).evicted_cookies, 1);
        let cost = records(&jar)[0].bytes;
        let mut small = limited(10, 10, cost * 2);
        set(&mut small, "a=1", "https://a.test/");
        set(&mut small, "b=2", "https://b.test/");
        set(&mut small, "c=3", "https://c.test/");
        assert!(small.bytes <= cost * 2);
        assert_eq!(records(&small).len(), 2);
        assert_eq!(small.stats(NOW).evicted_cookies, 1);
        assert_invariants(&small);
        assert!(
            small
                .set_cookie(
                    &format!("large={}", "x".repeat(MAX_COOKIE_BYTES)),
                    &url("https://example.com/"),
                    NOW
                )
                .is_err()
        );
    }
    #[test]
    fn actual_default_count_domain_and_record_caps_hold() {
        let mut jar = CookieJar::new();
        for i in 0..MAX_DOMAIN_COOKIES + 1 {
            set(&mut jar, &format!("c{i}=x"), "https://a.example.com/");
        }
        assert_eq!(jar.stats(NOW).cookie_count, MAX_DOMAIN_COOKIES);
        assert_eq!(jar.stats(NOW).evicted_cookies, 1);
        jar.clear();
        for i in 0..MAX_COOKIES + 1 {
            set(&mut jar, "a=x", &format!("https://d{i}.test/"));
        }
        let stats = jar.stats(NOW);
        assert_eq!(stats.cookie_count, MAX_COOKIES);
        assert!(stats.cookie_bytes <= MAX_JAR_BYTES);
        assert!(
            records(&jar)
                .iter()
                .all(|entry| entry.bytes <= MAX_COOKIE_BYTES)
        );
        assert_eq!(header(&mut jar, "https://d0.test/"), None);
        assert_invariants(&jar);
    }
    #[test]
    fn isolated_stores_copied_metadata_clear_and_invalid_urls() {
        let mut a = CookieJar::new();
        let mut b = CookieJar::new();
        set(&mut a, "a=secret", "https://example.com/");
        let mut copy = a.get_cookies(&url("https://example.com/"), NOW).unwrap();
        copy[0].value = "changed".into();
        assert_eq!(
            header(&mut a, "https://example.com/"),
            Some("a=secret".into())
        );
        assert_eq!(header(&mut b, "https://example.com/"), None);
        a.clear();
        assert_eq!(a.stats(NOW).cookie_bytes, 0);
        assert_eq!(a.stats(NOW).cookie_count, 0);
        for at in ["file:///tmp/secret", "https://user:pass@example.com/"] {
            assert!(a.set_cookie("a=x", &url(at), NOW).is_err());
        }
    }
    #[test]
    fn invalid_max_age_is_ignored_and_repeated_attribute_rules_are_deterministic() {
        let mut jar = CookieJar::new();
        for (index, age) in ["", "-", "+1", "1.5", "1x"].iter().enumerate() {
            set(
                &mut jar,
                &format!("c{index}=1; Max-Age={age}"),
                "https://example.com/",
            );
        }
        assert!(
            jar.get_cookies(&url("https://example.com/"), NOW)
                .unwrap()
                .iter()
                .all(|cookie| cookie.expires_at.is_none())
        );
        set(
            &mut jar,
            "repeated=1; Max-Age=1; Max-Age=garbage; SameSite=None; SameSite=unknown",
            "https://example.com/",
        );
        let records = jar.get_cookies(&url("https://example.com/"), NOW).unwrap();
        let repeated = records
            .iter()
            .find(|cookie| cookie.name == "repeated")
            .unwrap();
        assert_eq!(repeated.expires_at, Some(NOW + 1));
        assert_eq!(repeated.same_site, None);
        assert_eq!(jar.stats(NOW + 1).cookie_count, 5);
    }
    #[test]
    fn ip_addresses_have_independent_domain_limits() {
        let mut jar = limited(10, 1, MAX_JAR_BYTES);
        set(&mut jar, "a=1", "http://127.0.0.1/");
        set(&mut jar, "b=2", "http://192.0.0.1/");
        assert_eq!(jar.stats(NOW).cookie_count, 2);
        assert_eq!(jar.stats(NOW).evicted_cookies, 0);
    }
    #[test]
    fn clock_sequence_wrap_preserves_creation_and_lru_order() {
        let mut jar = limited(2, 2, MAX_JAR_BYTES);
        set(&mut jar, "a=1; Path=/a", "https://example.com/");
        set(&mut jar, "b=2; Path=/b", "https://example.com/");
        header(&mut jar, "https://example.com/a");
        jar.tick = u64::MAX;
        set(&mut jar, "c=3; Path=/c", "https://example.com/");
        assert_eq!(header(&mut jar, "https://example.com/b"), None);
        assert_eq!(
            header(&mut jar, "https://example.com/a"),
            Some("a=1".into())
        );
        jar.tick = u64::MAX;
        set(&mut jar, "a=updated; Path=/a", "https://example.com/");
        assert!(
            records(&jar)
                .iter()
                .all(|entry| entry.created <= jar.tick && entry.used <= jar.tick)
        );
    }
    #[test]
    fn rfc6265bis_values_browsers_keep_are_stored_and_sent() {
        let mut jar = CookieJar::new();
        for value in [
            "space=a b",
            "comma=a,b",
            "quote=\"unclosed",
            "back=a\\b",
            "utf8=café ✓",
            "bad name=x",
            "tab=a\tb",
            "missing-equals",
            "=nameless-explicit",
            "  padded  =  v  ; Path=/",
            "empty=",
        ] {
            set(&mut jar, value, "https://example.com/");
        }
        let records = jar.get_cookies(&url("https://example.com/"), NOW).unwrap();
        let pairs = records
            .iter()
            .map(|cookie| (cookie.name.as_str(), cookie.value.as_str()))
            .collect::<Vec<_>>();
        assert_eq!(
            pairs,
            [
                ("space", "a b"),
                ("comma", "a,b"),
                ("quote", "\"unclosed"),
                ("back", "a\\b"),
                ("utf8", "café ✓"),
                ("bad name", "x"),
                ("tab", "a\tb"),
                ("", "nameless-explicit"),
                ("padded", "v"),
                ("empty", ""),
            ],
            "Nameless cookies share an identity, so the later one replaces the earlier"
        );
        let text = header(&mut jar, "https://example.com/").unwrap();
        assert_eq!(
            text,
            "space=a b; comma=a,b; quote=\"unclosed; back=a\\b; utf8=café ✓; \
             bad name=x; tab=a\tb; nameless-explicit; padded=v; empty="
        );
        assert!(http::HeaderValue::from_str(&text).is_ok());
        let bytes = jar.header_bytes(&url("https://example.com/"), NOW).unwrap();
        assert_eq!(bytes.as_deref(), Some(text.as_bytes()));
        // The 4096-octet bound covers name + value, not attributes.
        let mut jar = CookieJar::new();
        let value = "v".repeat(MAX_COOKIE_BYTES - 1);
        let line = format!("n={value}; Path=/; Comment={}", "c".repeat(900));
        assert!(line.len() > MAX_COOKIE_BYTES);
        set(&mut jar, &line, "https://example.com/");
        assert!(
            jar.set_cookie(&format!("nn={value}"), &url("https://example.com/"), NOW)
                .is_err()
        );
        assert_eq!(jar.stats(NOW).cookie_count, 1);
        // Attribute values over 1024 octets are ignored (default path applies).
        set(
            &mut jar,
            &format!("p=1; Path=/{}", "x".repeat(MAX_ATTRIBUTE_BYTES)),
            "https://example.com/dir/page",
        );
        let cookie = jar
            .get_cookies(&url("https://example.com/dir/"), NOW)
            .unwrap()
            .into_iter()
            .find(|cookie| cookie.name == "p")
            .unwrap();
        assert_eq!(cookie.path, "/dir");
        assert_invariants(&jar);
    }
    #[test]
    fn raw_set_cookie_bytes_round_trip_latin1_and_count_rejects() {
        let mut jar = CookieJar::new();
        let at = url("https://example.com/");
        jar.receive_cookie_bytes(b"lat=caf\xe9; Path=/", &at, NOW);
        jar.receive_cookie_bytes("utf=café; Path=/".as_bytes(), &at, NOW);
        jar.receive_cookie_bytes(b"ascii=1; Path=/; X=\xff", &at, NOW);
        jar.receive_cookie_bytes(b"bad=\x00\xe9", &at, NOW);
        jar.receive_cookie_bytes(b"bad=x\x7f", &at, NOW);
        jar.receive_cookie_bytes(b"", &at, NOW);
        let stats = jar.stats(NOW);
        assert_eq!(stats.cookie_count, 3);
        assert_eq!(stats.discarded_cookies, 3);
        let bytes = jar.header_bytes(&at, NOW).unwrap().unwrap();
        assert_eq!(bytes, b"lat=caf\xe9; utf=caf\xc3\xa9; ascii=1");
        assert!(http::HeaderValue::from_bytes(&bytes).is_ok());
        // The text API never re-encodes opaque octets; it omits those cookies.
        assert_eq!(
            header(&mut jar, "https://example.com/"),
            Some("utf=café; ascii=1".into())
        );
        let records = jar.get_cookies(&at, NOW).unwrap();
        assert_eq!(records[0].value, "café", "Latin-1 decoded for the JS view");
        // Latin-1 records still replace by identity and are charged on the wire length.
        jar.receive_cookie_bytes(b"lat=\xe0\xe1; Path=/", &at, NOW);
        let bytes = jar.header_bytes(&at, NOW).unwrap().unwrap();
        assert!(bytes.starts_with(b"lat=\xe0\xe1; "));
        // 3 + 4093 wire octets fit (the UTF-8 view is ~8 KiB); one more does not.
        let limit = format!("lat={}", "\u{e9}".repeat(MAX_COOKIE_BYTES - 2));
        let latin1 = limit.chars().map(|c| c as u8).collect::<Vec<_>>();
        assert_eq!(latin1.len(), MAX_COOKIE_BYTES + 2);
        jar.receive_cookie_bytes(&latin1[..MAX_COOKIE_BYTES + 1], &at, NOW);
        assert_eq!(jar.stats(NOW).discarded_cookies, 3);
        jar.receive_cookie_bytes(&latin1, &at, NOW);
        assert_eq!(jar.stats(NOW).discarded_cookies, 4);
        assert_invariants(&jar);
    }
    #[test]
    fn oversized_cookie_header_omits_least_recently_used_cookies_instead_of_failing() {
        let mut jar = CookieJar::new();
        set(&mut jar, "deep=1; Path=/a", "https://example.com/");
        for i in 0..30 {
            set(
                &mut jar,
                &format!("c{i}={}", "x".repeat(3000)),
                "https://example.com/",
            );
        }
        let names = |text: &str| {
            text.split("; ")
                .map(|pair| pair.split_once('=').unwrap().0.to_owned())
                .collect::<Vec<_>>()
        };
        let text = header(&mut jar, "https://example.com/a").unwrap();
        assert!(text.len() <= MAX_HEADER_BYTES);
        // All 31 would need 90176 bytes. The least recently used (deep, c0..c8)
        // are omitted; the rest keep RFC order: 3005 + 20 x 3006 - 2 = 63123.
        assert_eq!(text.len(), 63123);
        let expected = (9..30).map(|i| format!("c{i}")).collect::<Vec<_>>();
        assert_eq!(names(&text), expected);
        let bytes = jar
            .header_bytes(&url("https://example.com/a"), NOW)
            .unwrap()
            .unwrap();
        assert_eq!(bytes, text.as_bytes(), "the selection is stable");
        assert_eq!(jar.stats(NOW).cookie_count, 31);
        // Newly set cookies are sent; a tie among equally recent ones omits the
        // later cookie in RFC order.
        set(&mut jar, "fresh=1", "https://example.com/");
        set(
            &mut jar,
            &format!("c30={}", "x".repeat(3000)),
            "https://example.com/",
        );
        let text = header(&mut jar, "https://example.com/a").unwrap();
        assert!(text.len() <= MAX_HEADER_BYTES);
        let mut expected = (9..29).map(|i| format!("c{i}")).collect::<Vec<_>>();
        expected.extend(["fresh".to_owned(), "c30".to_owned()]);
        assert_eq!(names(&text), expected);
        assert_eq!(jar.stats(NOW).cookie_count, 33);
        assert_invariants(&jar);
    }
    #[test]
    fn empty_domain_is_ignored_and_public_suffix_host_is_host_only() {
        let mut jar = CookieJar::new();
        set(&mut jar, "a=1; Domain=", "https://a.example.com/");
        set(&mut jar, "b=1; Domain=.", "https://a.example.com/");
        set(
            &mut jar,
            "c=1; Domain=example.com; Domain=",
            "https://a.example.com/",
        );
        assert_eq!(
            header(&mut jar, "https://b.example.com/"),
            Some("c=1".into())
        );
        let records = jar
            .get_cookies(&url("https://a.example.com/"), NOW)
            .unwrap();
        for cookie in records.iter().filter(|cookie| cookie.name != "c") {
            assert!(cookie.host_only && cookie.domain == "a.example.com");
        }
        // A public suffix Domain equal to the request host becomes host-only.
        for (value, at, other) in [
            (
                "p=1; Domain=github.io",
                "https://github.io/",
                "https://alice.github.io/",
            ),
            (
                "p=1; Domain=.CO.UK",
                "https://co.uk/",
                "https://example.co.uk/",
            ),
        ] {
            set(&mut jar, value, at);
            let cookie = &jar.get_cookies(&url(at), NOW).unwrap()[0];
            assert!(cookie.host_only);
            assert_eq!(header(&mut jar, other), None);
        }
        // ...but never from any other host.
        assert!(
            jar.set_cookie(
                "p=1; Domain=github.io",
                &url("https://alice.github.io/"),
                NOW
            )
            .is_err()
        );
        assert_invariants(&jar);
    }
    #[test]
    fn lifetimes_are_capped_at_400_days_and_javascript_safe() {
        let mut jar = CookieJar::new();
        let at = url("https://example.com/");
        set(&mut jar, "age=1; Max-Age=999999999", "https://example.com/");
        set(
            &mut jar,
            "date=1; Expires=Fri, 01 Jan 2100 00:00:00 GMT",
            "https://example.com/",
        );
        set(&mut jar, "short=1; Max-Age=60", "https://example.com/");
        let expiry = |jar: &mut CookieJar, name: &str, now: i64| {
            jar.get_cookies(&at, now)
                .unwrap()
                .into_iter()
                .find(|cookie| cookie.name == name)
                .and_then(|cookie| cookie.expires_at)
        };
        assert_eq!(
            expiry(&mut jar, "age", NOW),
            Some(NOW + MAX_LIFETIME_SECONDS)
        );
        assert_eq!(
            expiry(&mut jar, "date", NOW),
            Some(NOW + MAX_LIFETIME_SECONDS)
        );
        assert_eq!(expiry(&mut jar, "short", NOW), Some(NOW + 60));
        let near = MAX_SAFE_INTEGER - 10;
        jar.set_cookie("edge=1; Max-Age=100", &at, near).unwrap();
        assert_eq!(expiry(&mut jar, "edge", near), Some(MAX_SAFE_INTEGER));
        jar.set_cookie("edge=1; Max-Age=100", &at, i64::MAX - 1)
            .unwrap();
        assert_eq!(jar.stats(i64::MAX - 1).cookie_count, 0);
        assert_invariants(&jar);
    }
    #[test]
    fn cookie_date_algorithm_matches_rfc6265bis() {
        for (input, expected) in [
            ("Thu, 01 Jan 1970 00:00:00 GMT", Some(0)),
            ("Thu, 01-Jan-1970 00:00:10 GMT", Some(10)),
            ("Sun, 06 Nov 1994 08:49:37 GMT", Some(784_111_777)),
            ("Sunday, 06-Nov-94 08:49:37 GMT", Some(784_111_777)),
            ("Sun Nov  6 08:49:37 1994", Some(784_111_777)),
            ("6 november 1994 8:49:37", Some(784_111_777)),
            ("Tue, 29 Feb 2000 00:00:00 GMT", Some(951_782_400)),
            ("01 Jan 69 00:00:00", Some(3_124_224_000)),
            ("Mon, 01 Jan 1601 00:00:00 GMT", Some(-11_644_473_600)),
            ("Thu, 29 Feb 1900 00:00:00 GMT", None),
            ("Fri, 31 Dec 1600 23:59:59 GMT", None),
            ("Thu, 01 Jan 1970 24:00:00 GMT", None),
            ("Thu, 32 Jan 1970 00:00:00 GMT", None),
            ("Thu, 01 Jan 1970", None),
            ("garbage", None),
            ("", None),
        ] {
            assert_eq!(parse_cookie_date(input), expected, "{input}");
        }
    }
    #[test]
    fn eviction_prefers_expired_then_non_secure_then_lru() {
        let mut jar = limited(3, 3, MAX_JAR_BYTES);
        set(&mut jar, "s=1; Secure; Path=/", "https://example.com/");
        set(&mut jar, "a=1", "https://example.com/");
        set(&mut jar, "b=1", "https://example.com/");
        // `s` is least recently used but Secure, so the oldest insecure goes first.
        set(&mut jar, "c=1", "https://example.com/");
        assert_eq!(
            header(&mut jar, "https://example.com/"),
            Some("s=1; b=1; c=1".into())
        );
        assert_eq!(jar.stats(NOW).evicted_cookies, 1);
        // Expired records are swept before any capacity eviction.
        set(&mut jar, "b=2; Max-Age=5", "https://example.com/");
        jar.set_cookie("d=1", &url("https://example.com/"), NOW + 5)
            .unwrap();
        assert_eq!(jar.stats(NOW + 5).evicted_cookies, 1);
        // With only Secure candidates left in the group, LRU among them applies.
        let mut jar = limited(10, 2, MAX_JAR_BYTES);
        set(&mut jar, "x=1; Secure", "https://example.com/");
        set(&mut jar, "y=1; Secure", "https://example.com/");
        header(&mut jar, "https://example.com/");
        set(&mut jar, "y=1; Secure; Path=/y", "https://example.com/");
        assert_eq!(jar.stats(NOW).cookie_count, 2);
        assert_invariants(&jar);
    }
    #[test]
    fn domain_index_visits_only_host_suffix_buckets() {
        let mut jar = CookieJar::new();
        for i in 0..500 {
            set(
                &mut jar,
                &format!("n{i}=1"),
                &format!("https://h{i}.other.test/"),
            );
        }
        set(
            &mut jar,
            "parent=1; Domain=example.com",
            "https://www.example.com/",
        );
        set(&mut jar, "host=1", "https://a.b.example.com/");
        set(&mut jar, "sibling=1", "https://b.example.com/");
        // Buckets are keyed by cookie domain; lookups probe host and parent domains.
        assert!(jar.domains.contains_key("example.com"));
        assert!(jar.domains.contains_key("a.b.example.com"));
        let found = jar.matching(&url("https://a.b.example.com/"), "a.b.example.com");
        assert_eq!(found.len(), 2);
        assert_eq!(
            header(&mut jar, "https://a.b.example.com/"),
            Some("parent=1; host=1".into())
        );
        assert_eq!(
            header(&mut jar, "https://b.example.com/"),
            Some("parent=1; sibling=1".into())
        );
        // A parent domain whose registrable domain differs from the host's
        // (deeper public suffix) is still found.
        assert_eq!(
            psl::domain_str("bucket.s3.amazonaws.com"),
            Some("bucket.s3.amazonaws.com")
        );
        set(
            &mut jar,
            "aws=1; Domain=amazonaws.com",
            "https://www.amazonaws.com/",
        );
        assert_eq!(
            header(&mut jar, "https://bucket.s3.amazonaws.com/"),
            Some("aws=1".into())
        );
        // IPv4 hosts are not split into labels.
        set(&mut jar, "ip=1", "http://10.0.0.1/");
        assert_eq!(header(&mut jar, "http://0.0.1/"), None);
        assert_eq!(header(&mut jar, "http://10.0.0.1/"), Some("ip=1".into()));
        // Removing the last record of a domain drops its bucket and group.
        set(&mut jar, "host=1; Max-Age=0", "https://a.b.example.com/");
        assert!(!jar.domains.contains_key("a.b.example.com"));
        set(&mut jar, "ip=1; Max-Age=0", "http://10.0.0.1/");
        assert!(!jar.groups.contains_key("10.0.0.1"));
        assert_invariants(&jar);
        jar.clear();
        assert!(jar.domains.is_empty() && jar.groups.is_empty());
    }
}
