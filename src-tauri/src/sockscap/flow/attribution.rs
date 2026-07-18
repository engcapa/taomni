//! Bounded, non-decrypting hostname attribution (design plan §4.1).
//!
//! Priority is fixed: platform remote hostname → Fake-IP/DNS mapping → TLS
//! ClientHello SNI → plaintext HTTP Host → IP-only → unknown. Every hostname
//! crosses the same IDNA validation boundary as the policy compiler.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::RwLock;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::sockscap::policy::rules::normalize_hostname;
use crate::sockscap::types::HostnameSource;

const DEFAULT_FAKE_IP_CAPACITY: usize = 65_536;
const DEFAULT_FAKE_IP_TTL: Duration = Duration::from_secs(10 * 60);
const MAX_INSPECT_BYTES: usize = 16 * 1024;

/// Inputs available when attributing a hostname to a flow.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttributionHints {
    pub platform_hostname: Option<String>,
    pub fake_ip_hostname: Option<String>,
    pub tls_sni: Option<String>,
    pub http_host: Option<String>,
    pub destination_ip: Option<String>,
}

/// Result of hostname attribution.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttributedHost {
    pub hostname: Option<String>,
    pub source: HostnameSource,
}

/// Resolve a hostname using the documented, stable priority chain.
pub fn attribute_hostname(hints: &AttributionHints) -> AttributedHost {
    for (candidate, source) in [
        (
            hints.platform_hostname.as_deref(),
            HostnameSource::PlatformRemoteHostname,
        ),
        (
            hints.fake_ip_hostname.as_deref(),
            HostnameSource::FakeIpDnsMap,
        ),
        (hints.tls_sni.as_deref(), HostnameSource::TlsSni),
    ] {
        if let Some(hostname) = candidate.and_then(normalize_hostname) {
            return AttributedHost {
                hostname: Some(hostname),
                source,
            };
        }
    }

    if let Some(hostname) = hints.http_host.as_deref().and_then(parse_http_host_value) {
        return AttributedHost {
            hostname: Some(hostname),
            source: HostnameSource::HttpHost,
        };
    }

    if hints
        .destination_ip
        .as_deref()
        .and_then(|value| value.trim().parse::<IpAddr>().ok())
        .is_some()
    {
        return AttributedHost {
            hostname: None,
            source: HostnameSource::IpOnly,
        };
    }

    AttributedHost {
        hostname: None,
        source: HostnameSource::Unknown,
    }
}

/// Extract SNI from one complete TLS ClientHello record without decrypting it.
/// Malformed, fragmented, ECH-only, and oversized inputs return `None`.
pub fn parse_tls_sni(input: &[u8]) -> Option<String> {
    let input = input.get(..input.len().min(MAX_INSPECT_BYTES))?;
    let mut reader = Reader::new(input);

    if reader.u8()? != 0x16 {
        return None;
    }
    reader.skip(2)?;
    let record_len = reader.u16()? as usize;
    if record_len > reader.remaining() || record_len > MAX_INSPECT_BYTES - 5 {
        return None;
    }
    let mut handshake = Reader::new(reader.take(record_len)?);
    if handshake.u8()? != 0x01 {
        return None;
    }
    let handshake_len = handshake.u24()? as usize;
    if handshake_len > handshake.remaining() {
        return None;
    }
    let mut hello = Reader::new(handshake.take(handshake_len)?);
    hello.skip(2 + 32)?;
    let session_len = hello.u8()? as usize;
    hello.skip(session_len)?;
    let cipher_len = hello.u16()? as usize;
    if cipher_len == 0 || cipher_len % 2 != 0 {
        return None;
    }
    hello.skip(cipher_len)?;
    let compression_len = hello.u8()? as usize;
    hello.skip(compression_len)?;
    let extensions_len = hello.u16()? as usize;
    let mut extensions = Reader::new(hello.take(extensions_len)?);

    while extensions.remaining() >= 4 {
        let extension_type = extensions.u16()?;
        let extension_len = extensions.u16()? as usize;
        let extension = extensions.take(extension_len)?;
        if extension_type == 0 {
            return parse_server_name_extension(extension);
        }
    }
    None
}

fn parse_server_name_extension(input: &[u8]) -> Option<String> {
    let mut reader = Reader::new(input);
    let list_len = reader.u16()? as usize;
    let mut names = Reader::new(reader.take(list_len)?);
    while names.remaining() >= 3 {
        let name_type = names.u8()?;
        let name_len = names.u16()? as usize;
        let name = names.take(name_len)?;
        if name_type == 0 {
            return std::str::from_utf8(name).ok().and_then(normalize_hostname);
        }
    }
    None
}

/// Extract a Host header from a bounded plaintext HTTP/1 request head.
pub fn parse_http_host(input: &[u8]) -> Option<String> {
    let bounded = &input[..input.len().min(MAX_INSPECT_BYTES)];
    let header_end = find_subslice(bounded, b"\r\n\r\n")?;
    let text = std::str::from_utf8(&bounded[..header_end]).ok()?;
    let mut lines = text.split("\r\n");
    let request_line = lines.next()?;
    if !request_line.contains(" HTTP/1.") {
        return None;
    }
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.eq_ignore_ascii_case("host") {
            return parse_http_host_value(value);
        }
    }
    None
}

fn parse_http_host_value(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty()
        || value.bytes().any(|byte| byte.is_ascii_whitespace())
        || value.contains(['/', '\\', '@', '#', '?'])
    {
        return None;
    }

    // Bracketed and unbracketed IP literals are valid Host values but are not
    // hostnames, so attribution continues to the IP-only stage.
    if let Some(rest) = value.strip_prefix('[') {
        let (literal, suffix) = rest.split_once(']')?;
        if literal.parse::<IpAddr>().is_err()
            || (!suffix.is_empty()
                && !suffix
                    .strip_prefix(':')
                    .is_some_and(|port| valid_port(port)))
        {
            return None;
        }
        return None;
    }
    if value.parse::<IpAddr>().is_ok() {
        return None;
    }

    let host = match value.rsplit_once(':') {
        Some((host, port)) if valid_port(port) => host,
        Some(_) if value.contains(':') => return None,
        _ => value,
    };
    normalize_hostname(host)
}

fn valid_port(value: &str) -> bool {
    value.parse::<u16>().is_ok_and(|port| port != 0)
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

#[derive(Debug)]
struct Reader<'a> {
    input: &'a [u8],
    offset: usize,
}

impl<'a> Reader<'a> {
    fn new(input: &'a [u8]) -> Self {
        Self { input, offset: 0 }
    }

    fn remaining(&self) -> usize {
        self.input.len().saturating_sub(self.offset)
    }

    fn u8(&mut self) -> Option<u8> {
        let value = *self.input.get(self.offset)?;
        self.offset += 1;
        Some(value)
    }

    fn u16(&mut self) -> Option<u16> {
        Some(u16::from_be_bytes([self.u8()?, self.u8()?]))
    }

    fn u24(&mut self) -> Option<u32> {
        Some(((self.u8()? as u32) << 16) | ((self.u8()? as u32) << 8) | self.u8()? as u32)
    }

    fn skip(&mut self, len: usize) -> Option<()> {
        self.take(len).map(|_| ())
    }

    fn take(&mut self, len: usize) -> Option<&'a [u8]> {
        let end = self.offset.checked_add(len)?;
        let value = self.input.get(self.offset..end)?;
        self.offset = end;
        Some(value)
    }
}

#[derive(Debug, Clone)]
struct FakeIpEntry {
    hostname: String,
    expires_at: Instant,
}

/// Bounded, expiring Fake-IP / DNS mapping table used by Virtual DNS mode.
#[derive(Debug)]
pub struct FakeIpMap {
    inner: RwLock<HashMap<IpAddr, FakeIpEntry>>,
    capacity: usize,
    ttl: Duration,
}

impl Default for FakeIpMap {
    fn default() -> Self {
        Self::with_limits(DEFAULT_FAKE_IP_CAPACITY, DEFAULT_FAKE_IP_TTL)
    }
}

impl FakeIpMap {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_limits(capacity: usize, ttl: Duration) -> Self {
        Self {
            inner: RwLock::new(HashMap::new()),
            capacity: capacity.max(1),
            ttl,
        }
    }

    pub fn insert(&self, ip: &str, hostname: &str) -> Result<(), String> {
        let ip = ip
            .trim()
            .parse::<IpAddr>()
            .map_err(|_| "fake-ip mapping requires a valid IP address".to_string())?;
        let hostname = normalize_hostname(hostname)
            .ok_or_else(|| "fake-ip mapping requires a valid hostname".to_string())?;
        let now = Instant::now();
        let expires_at = now.checked_add(self.ttl).unwrap_or(now);
        let mut entries = self
            .inner
            .write()
            .map_err(|_| "fake-ip mapping lock is poisoned".to_string())?;
        entries.retain(|_, entry| entry.expires_at > now);
        if !entries.contains_key(&ip) && entries.len() >= self.capacity {
            if let Some(oldest) = entries
                .iter()
                .min_by_key(|(_, entry)| entry.expires_at)
                .map(|(ip, _)| *ip)
            {
                entries.remove(&oldest);
            }
        }
        entries.insert(
            ip,
            FakeIpEntry {
                hostname,
                expires_at,
            },
        );
        Ok(())
    }

    pub fn lookup(&self, ip: &str) -> Option<String> {
        let ip = ip.trim().parse::<IpAddr>().ok()?;
        let now = Instant::now();
        let entry = self.inner.read().ok()?.get(&ip).cloned()?;
        (entry.expires_at > now).then_some(entry.hostname)
    }

    pub fn resolve_hints(&self, mut hints: AttributionHints) -> AttributionHints {
        if hints.fake_ip_hostname.is_none() {
            if let Some(ip) = hints.destination_ip.as_deref() {
                hints.fake_ip_hostname = self.lookup(ip);
            }
        }
        hints
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn client_hello(hostname: &str) -> Vec<u8> {
        let mut server_name = vec![0];
        server_name.extend_from_slice(&(hostname.len() as u16).to_be_bytes());
        server_name.extend_from_slice(hostname.as_bytes());

        let mut name_list = Vec::new();
        name_list.extend_from_slice(&(server_name.len() as u16).to_be_bytes());
        name_list.extend_from_slice(&server_name);

        let mut extension = Vec::new();
        extension.extend_from_slice(&0u16.to_be_bytes());
        extension.extend_from_slice(&(name_list.len() as u16).to_be_bytes());
        extension.extend_from_slice(&name_list);

        let mut body = vec![0x03, 0x03];
        body.extend_from_slice(&[0; 32]);
        body.push(0);
        body.extend_from_slice(&[0, 2, 0, 0x2f]);
        body.extend_from_slice(&[1, 0]);
        body.extend_from_slice(&(extension.len() as u16).to_be_bytes());
        body.extend_from_slice(&extension);

        let mut handshake = vec![1];
        let body_len = body.len() as u32;
        handshake.extend_from_slice(&[
            (body_len >> 16) as u8,
            (body_len >> 8) as u8,
            body_len as u8,
        ]);
        handshake.extend_from_slice(&body);

        let mut record = vec![0x16, 0x03, 0x01];
        record.extend_from_slice(&(handshake.len() as u16).to_be_bytes());
        record.extend_from_slice(&handshake);
        record
    }

    #[test]
    fn priority_and_idna_are_stable() {
        let attributed = attribute_hostname(&AttributionHints {
            platform_hostname: Some("BÜCHER.Example.".into()),
            tls_sni: Some("fallback.example".into()),
            ..Default::default()
        });
        assert_eq!(
            attributed.hostname.as_deref(),
            Some("xn--bcher-kva.example")
        );
        assert_eq!(attributed.source, HostnameSource::PlatformRemoteHostname);
    }

    #[test]
    fn invalid_high_priority_hint_falls_through() {
        let attributed = attribute_hostname(&AttributionHints {
            platform_hostname: Some("not a hostname".into()),
            tls_sni: Some("valid.example".into()),
            ..Default::default()
        });
        assert_eq!(attributed.hostname.as_deref(), Some("valid.example"));
        assert_eq!(attributed.source, HostnameSource::TlsSni);
    }

    #[test]
    fn http_host_parser_handles_ports_and_rejects_ip_literals() {
        let request = b"GET / HTTP/1.1\r\nHost: WWW.Example.com:8080\r\n\r\n";
        assert_eq!(parse_http_host(request).as_deref(), Some("www.example.com"));
        assert_eq!(parse_http_host_value("[2001:db8::1]:443"), None);
        assert_eq!(parse_http_host_value("127.0.0.1:80"), None);
        assert_eq!(parse_http_host_value("example.com:0"), None);
    }

    #[test]
    fn parses_bounded_tls_sni_and_rejects_truncation() {
        let hello = client_hello("SNI.Example");
        assert_eq!(parse_tls_sni(&hello).as_deref(), Some("sni.example"));
        assert_eq!(parse_tls_sni(&hello[..20]), None);
        assert_eq!(parse_tls_sni(b"not tls"), None);
    }

    #[test]
    fn ip_only_requires_a_valid_address() {
        let valid = attribute_hostname(&AttributionHints {
            destination_ip: Some("1.2.3.4".into()),
            ..Default::default()
        });
        assert_eq!(valid.source, HostnameSource::IpOnly);

        let invalid = attribute_hostname(&AttributionHints {
            destination_ip: Some("not-an-ip".into()),
            ..Default::default()
        });
        assert_eq!(invalid.source, HostnameSource::Unknown);
    }

    #[test]
    fn fake_ip_map_validates_normalizes_expires_and_bounds_entries() {
        let map = FakeIpMap::with_limits(1, Duration::from_secs(60));
        map.insert("198.18.0.1", "BÜCHER.example").unwrap();
        assert_eq!(
            map.lookup("198.18.0.1").as_deref(),
            Some("xn--bcher-kva.example")
        );
        map.insert("198.18.0.2", "second.example").unwrap();
        assert!(map.lookup("198.18.0.1").is_none());
        assert_eq!(map.lookup("198.18.0.2").as_deref(), Some("second.example"));
        assert!(map.insert("bad-ip", "example.com").is_err());
        assert!(map.insert("198.18.0.3", "bad host").is_err());

        let expired = FakeIpMap::with_limits(1, Duration::ZERO);
        expired.insert("198.18.0.1", "expired.example").unwrap();
        assert!(expired.lookup("198.18.0.1").is_none());
    }
}
