//! A minimal DNS client for HTTPS resource records (RFC 9460), which tell a browser that an
//! origin speaks HTTP/3 before its first connection. It asks the system's configured name
//! servers over UDP; platforms without `/etc/resolv.conf` rely on Alt-Svc alone.

use std::{
    net::{IpAddr, SocketAddr},
    time::Duration,
};

use tokio::net::UdpSocket;

const TYPE_HTTPS: u16 = 65;
const KEY_ALPN: u16 = 1;
const KEY_PORT: u16 = 3;

/// What an HTTPS record says about HTTP/3 for a host.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct HttpsRecord {
    /// The port HTTP/3 is offered on, `None` when no service record lists `h3`.
    pub(crate) h3_port: Option<u16>,
    pub(crate) ttl: u32,
}

/// Name servers from `/etc/resolv.conf`.
pub(crate) fn system_name_servers() -> Vec<SocketAddr> {
    let Ok(text) = std::fs::read_to_string("/etc/resolv.conf") else {
        return Vec::new();
    };
    text.lines()
        .filter_map(|line| line.trim().strip_prefix("nameserver"))
        .filter_map(|rest| rest.trim().split('%').next()?.parse::<IpAddr>().ok())
        .map(|ip| SocketAddr::new(ip, 53))
        .take(3)
        .collect()
}

fn query(id: u16, host: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(64 + host.len());
    out.extend_from_slice(&id.to_be_bytes());
    // Recursion desired; one question; one additional record (EDNS).
    out.extend_from_slice(&[0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 1]);
    for label in host.trim_end_matches('.').split('.') {
        if label.is_empty() || label.len() > 63 {
            return None;
        }
        out.push(label.len() as u8);
        out.extend_from_slice(label.as_bytes());
    }
    out.push(0);
    out.extend_from_slice(&TYPE_HTTPS.to_be_bytes());
    out.extend_from_slice(&1u16.to_be_bytes());
    // OPT pseudo-record: root name, type 41, 1232-byte UDP payload, no flags.
    out.extend_from_slice(&[0, 0, 41, 0x04, 0xd0, 0, 0, 0, 0, 0, 0]);
    Some(out)
}

/// Skips a possibly compressed name, returning the offset after it.
fn skip_name(message: &[u8], mut at: usize) -> Option<usize> {
    loop {
        let length = *message.get(at)?;
        match length & 0xc0 {
            0xc0 => return Some(at + 2),
            0x00 if length == 0 => return Some(at + 1),
            0x00 => at += 1 + length as usize,
            _ => return None,
        }
    }
}

fn u16_at(message: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_be_bytes(
        message.get(at..at + 2)?.try_into().ok()?,
    ))
}

fn parse(message: &[u8], id: u16) -> Option<HttpsRecord> {
    if message.len() < 12 || u16_at(message, 0)? != id || message[2] & 0x80 == 0 {
        return None;
    }
    // Truncated, or an error other than "no such name".
    let rcode = message[3] & 0x0f;
    if message[2] & 0x02 != 0 || (rcode != 0 && rcode != 3) {
        return None;
    }
    let questions = u16_at(message, 4)?;
    let answers = u16_at(message, 6)?;
    let mut at = 12;
    for _ in 0..questions {
        at = skip_name(message, at)? + 4;
    }
    let mut record = HttpsRecord {
        h3_port: None,
        ttl: 300,
    };
    for _ in 0..answers {
        at = skip_name(message, at)?;
        let kind = u16_at(message, at)?;
        let ttl = u32::from_be_bytes(message.get(at + 4..at + 8)?.try_into().ok()?);
        let length = u16_at(message, at + 8)? as usize;
        let data = message.get(at + 10..at + 10 + length)?;
        at += 10 + length;
        if kind != TYPE_HTTPS {
            continue;
        }
        let priority = u16_at(data, 0)?;
        // AliasMode records point elsewhere; only ServiceMode records carry parameters.
        if priority == 0 {
            continue;
        }
        let mut cursor = skip_name(data, 2)?;
        let mut h3 = false;
        let mut port = None;
        while cursor + 4 <= data.len() {
            let key = u16_at(data, cursor)?;
            let len = u16_at(data, cursor + 2)? as usize;
            let value = data.get(cursor + 4..cursor + 4 + len)?;
            cursor += 4 + len;
            match key {
                KEY_ALPN => {
                    let mut i = 0;
                    while i < value.len() {
                        let n = value[i] as usize;
                        if value.get(i + 1..i + 1 + n) == Some(b"h3") {
                            h3 = true;
                        }
                        i += 1 + n;
                    }
                }
                KEY_PORT => port = u16_at(value, 0),
                _ => {}
            }
        }
        record.ttl = ttl;
        if h3 {
            record.h3_port = Some(port.unwrap_or(443));
            return Some(record);
        }
    }
    Some(record)
}

/// Looks up the HTTPS record of `host`, asking every name server at once and taking the first
/// useful answer within `timeout`. `None` when no name server answered usefully.
pub(crate) async fn lookup(
    servers: &[SocketAddr],
    host: &str,
    timeout: Duration,
) -> Option<HttpsRecord> {
    let mut id = [0u8; 2];
    btls::rand::rand_bytes(&mut id).ok()?;
    let id = u16::from_ne_bytes(id);
    let message = query(id, host)?;
    let mut queries = tokio::task::JoinSet::new();
    for server in servers.iter().copied() {
        let message = message.clone();
        queries.spawn(async move {
            let bind: SocketAddr = if server.is_ipv4() {
                ([0, 0, 0, 0], 0).into()
            } else {
                (std::net::Ipv6Addr::UNSPECIFIED, 0).into()
            };
            let socket = UdpSocket::bind(bind).await.ok()?;
            socket.connect(server).await.ok()?;
            socket.send(&message).await.ok()?;
            let mut buf = vec![0u8; 4096];
            loop {
                let n = socket.recv(&mut buf).await.ok()?;
                if let Some(record) = parse(&buf[..n], id) {
                    return Some(record);
                }
            }
        });
    }
    // Dropping the set aborts the queries still waiting.
    tokio::time::timeout(timeout, async {
        while let Some(answer) = queries.join_next().await {
            if let Ok(Some(record)) = answer {
                return Some(record);
            }
        }
        None
    })
    .await
    .ok()
    .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn answer(id: u16, rdata: &[u8]) -> Vec<u8> {
        let mut out = query(id, "example.com").unwrap();
        out[2] = 0x81;
        out[3] = 0x80;
        out[7] = 1; // one answer
        out[11] = 0; // drop the OPT record count
        let question_end = out.len() - 11;
        out.truncate(question_end);
        out.extend_from_slice(&[0xc0, 0x0c, 0, 65, 0, 1, 0, 0, 0x0e, 0x10]);
        out.extend_from_slice(&(rdata.len() as u16).to_be_bytes());
        out.extend_from_slice(rdata);
        out
    }

    #[test]
    fn parses_h3_service_records() {
        // priority 1, target ".", alpn ["h3", "h2"], port 8443.
        let rdata = [
            0, 1, 0, 0, 1, 0, 6, 2, b'h', b'3', 2, b'h', b'2', 0, 3, 0, 2, 0x20, 0xfb,
        ];
        assert_eq!(
            parse(&answer(7, &rdata), 7),
            Some(HttpsRecord {
                h3_port: Some(8443),
                ttl: 3600
            })
        );
        let h2_only = [0, 1, 0, 0, 1, 0, 3, 2, b'h', b'2'];
        assert_eq!(parse(&answer(7, &h2_only), 7).unwrap().h3_port, None);
        assert_eq!(parse(&answer(7, &rdata), 8), None);
        // Short or empty datagrams are ignored, not indexed.
        for short in [&[][..], &[0, 7], &[0, 7, 0x81, 0x80, 0, 1]] {
            assert_eq!(parse(short, 7), None);
        }
    }
}
