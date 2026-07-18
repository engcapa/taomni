//! Hostname attribution (plan §4 DomainAttribution, §6.4).
//!
//! Sockscap never decrypts TLS. To route HTTPS by domain it reads the TLS
//! ClientHello SNI and plaintext HTTP Host header only. Attribution priority
//! (most to least reliable): platform-provided remote hostname → Fake-IP/DNS
//! mapping → TLS SNI → HTTP Host → IP-only → unknown. The chosen source is
//! recorded per flow so the dashboard can show the `unknown` ratio honestly and
//! never claim "all HTTPS is identified by domain" (plan §6.4).

use super::HostnameSource;

/// The signals available for a flow, in the order Sockscap trusts them.
#[derive(Debug, Default, Clone)]
pub struct AttributionInputs {
    /// Hostname the platform capture adapter attached to the flow.
    pub platform_hostname: Option<String>,
    /// Hostname resolved via a Fake-IP / virtual-DNS mapping we installed.
    pub fake_ip_hostname: Option<String>,
    /// SNI parsed from the TLS ClientHello (no decryption).
    pub tls_sni: Option<String>,
    /// Host header parsed from a plaintext HTTP request.
    pub http_host: Option<String>,
    /// Whether a destination IP is known (for the ip-only fallback).
    pub has_ip: bool,
}

/// Resolve the flow hostname and record which source it came from.
pub fn attribute(inputs: &AttributionInputs) -> (Option<String>, HostnameSource) {
    if let Some(h) = normalize(&inputs.platform_hostname) {
        return (Some(h), HostnameSource::PlatformRemote);
    }
    if let Some(h) = normalize(&inputs.fake_ip_hostname) {
        return (Some(h), HostnameSource::FakeIpDns);
    }
    if let Some(h) = normalize(&inputs.tls_sni) {
        return (Some(h), HostnameSource::TlsSni);
    }
    if let Some(h) = normalize(&inputs.http_host) {
        return (Some(h), HostnameSource::HttpHost);
    }
    if inputs.has_ip {
        return (None, HostnameSource::IpRule);
    }
    (None, HostnameSource::Unknown)
}

fn normalize(v: &Option<String>) -> Option<String> {
    v.as_ref()
        .map(|s| s.trim().trim_end_matches('.').to_ascii_lowercase())
        .filter(|s| !s.is_empty())
}

/// Extract the SNI host from a TLS ClientHello record (RFC 6066 server_name).
/// Returns `None` for non-ClientHello data, truncated buffers, or when no SNI
/// is present (ECH can hide it — the caller then relies on unknown policy).
pub fn parse_tls_sni(buf: &[u8]) -> Option<String> {
    let mut r = Reader::new(buf);
    // TLS record header.
    if r.u8()? != 0x16 {
        return None; // not a handshake record
    }
    r.skip(2)?; // legacy record version
    let _record_len = r.u16()?;
    // Handshake header.
    if r.u8()? != 0x01 {
        return None; // not a ClientHello
    }
    let _hs_len = r.u24()?;
    r.skip(2)?; // client_version
    r.skip(32)?; // random
    let sid_len = r.u8()? as usize;
    r.skip(sid_len)?; // session id
    let cs_len = r.u16()? as usize;
    r.skip(cs_len)?; // cipher suites
    let comp_len = r.u8()? as usize;
    r.skip(comp_len)?; // compression methods
    let _ext_total = r.u16()?; // extensions length
    // Walk extensions.
    while r.remaining() >= 4 {
        let ext_type = r.u16()?;
        let ext_len = r.u16()? as usize;
        if ext_type == 0x0000 {
            // server_name extension.
            return parse_server_name_list(r.take(ext_len)?);
        }
        r.skip(ext_len)?;
    }
    None
}

/// Parse a ServerNameList and return the first host_name (name_type 0).
fn parse_server_name_list(data: &[u8]) -> Option<String> {
    let mut r = Reader::new(data);
    let _list_len = r.u16()?;
    while r.remaining() >= 3 {
        let name_type = r.u8()?;
        let name_len = r.u16()? as usize;
        let name = r.take(name_len)?;
        if name_type == 0x00 {
            let host = std::str::from_utf8(name).ok()?;
            let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
            if host.is_empty() {
                return None;
            }
            return Some(host);
        }
    }
    None
}

/// Extract the Host header from the start of a plaintext HTTP request. Returns
/// `None` for non-HTTP data or when no Host header is found in the buffer.
pub fn parse_http_host(buf: &[u8]) -> Option<String> {
    // Only inspect the request head (up to the blank line), bounded.
    let head_end = find_subslice(buf, b"\r\n\r\n").unwrap_or(buf.len().min(8192));
    let head = &buf[..head_end.min(buf.len())];
    let text = std::str::from_utf8(head).ok()?;
    for line in text.split("\r\n") {
        if let Some(rest) = line
            .strip_prefix("Host:")
            .or_else(|| line.strip_prefix("host:"))
        {
            let host = rest.trim();
            // Strip any :port.
            let host = host.split(':').next().unwrap_or(host);
            let host = host.trim_end_matches('.').to_ascii_lowercase();
            if !host.is_empty() {
                return Some(host);
            }
        }
    }
    None
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|w| w == needle)
}

/// A bounds-checked byte reader — every accessor returns `None` past the end so
/// a malformed/truncated ClientHello never panics.
struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn new(buf: &'a [u8]) -> Reader<'a> {
        Reader { buf, pos: 0 }
    }
    fn remaining(&self) -> usize {
        self.buf.len().saturating_sub(self.pos)
    }
    fn u8(&mut self) -> Option<u8> {
        let b = *self.buf.get(self.pos)?;
        self.pos += 1;
        Some(b)
    }
    fn u16(&mut self) -> Option<u16> {
        let hi = self.u8()? as u16;
        let lo = self.u8()? as u16;
        Some((hi << 8) | lo)
    }
    fn u24(&mut self) -> Option<u32> {
        let a = self.u8()? as u32;
        let b = self.u8()? as u32;
        let c = self.u8()? as u32;
        Some((a << 16) | (b << 8) | c)
    }
    fn skip(&mut self, n: usize) -> Option<()> {
        if self.remaining() < n {
            return None;
        }
        self.pos += n;
        Some(())
    }
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        if self.remaining() < n {
            return None;
        }
        let s = &self.buf[self.pos..self.pos + n];
        self.pos += n;
        Some(s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a minimal but well-formed TLS ClientHello carrying `host` in SNI.
    fn client_hello(host: &str) -> Vec<u8> {
        // server_name extension body.
        let mut sni = Vec::new();
        sni.push(0x00); // name_type = host_name
        sni.extend_from_slice(&(host.len() as u16).to_be_bytes());
        sni.extend_from_slice(host.as_bytes());
        let mut sn_list = Vec::new();
        sn_list.extend_from_slice(&(sni.len() as u16).to_be_bytes());
        sn_list.extend_from_slice(&sni);

        let mut ext = Vec::new();
        ext.extend_from_slice(&0x0000u16.to_be_bytes()); // ext type = server_name
        ext.extend_from_slice(&(sn_list.len() as u16).to_be_bytes());
        ext.extend_from_slice(&sn_list);

        let mut body = Vec::new();
        body.extend_from_slice(&[0x03, 0x03]); // client_version
        body.extend_from_slice(&[0u8; 32]); // random
        body.push(0x00); // session id len
        body.extend_from_slice(&[0x00, 0x02, 0x00, 0x2f]); // cipher suites
        body.extend_from_slice(&[0x01, 0x00]); // compression
        body.extend_from_slice(&(ext.len() as u16).to_be_bytes()); // extensions len
        body.extend_from_slice(&ext);

        let mut hs = Vec::new();
        hs.push(0x01); // ClientHello
        let len = body.len() as u32;
        hs.extend_from_slice(&[(len >> 16) as u8, (len >> 8) as u8, len as u8]);
        hs.extend_from_slice(&body);

        let mut rec = Vec::new();
        rec.push(0x16); // handshake
        rec.extend_from_slice(&[0x03, 0x01]); // record version
        rec.extend_from_slice(&(hs.len() as u16).to_be_bytes());
        rec.extend_from_slice(&hs);
        rec
    }

    #[test]
    fn parses_sni_from_client_hello() {
        let hello = client_hello("Example.COM");
        assert_eq!(parse_tls_sni(&hello).as_deref(), Some("example.com"));
    }

    #[test]
    fn rejects_non_handshake_and_truncated() {
        assert_eq!(parse_tls_sni(b"not tls"), None);
        let hello = client_hello("example.com");
        assert_eq!(parse_tls_sni(&hello[..20]), None); // truncated, no panic
    }

    #[test]
    fn parses_http_host_header() {
        let req = b"GET /path HTTP/1.1\r\nHost: www.Example.com:8080\r\nUA: x\r\n\r\n";
        assert_eq!(parse_http_host(req).as_deref(), Some("www.example.com"));
        assert_eq!(parse_http_host(b"random bytes"), None);
    }

    #[test]
    fn attribution_priority_order() {
        // Platform hostname wins over SNI.
        let (h, src) = attribute(&AttributionInputs {
            platform_hostname: Some("plat.example".into()),
            tls_sni: Some("sni.example".into()),
            has_ip: true,
            ..Default::default()
        });
        assert_eq!(h.as_deref(), Some("plat.example"));
        assert_eq!(src, HostnameSource::PlatformRemote);

        // SNI wins when no platform/fake-ip hostname.
        let (h, src) = attribute(&AttributionInputs {
            tls_sni: Some("SNI.example".into()),
            http_host: Some("host.example".into()),
            has_ip: true,
            ..Default::default()
        });
        assert_eq!(h.as_deref(), Some("sni.example"));
        assert_eq!(src, HostnameSource::TlsSni);

        // Only an IP → ip-rule.
        let (h, src) = attribute(&AttributionInputs {
            has_ip: true,
            ..Default::default()
        });
        assert_eq!(h, None);
        assert_eq!(src, HostnameSource::IpRule);

        // Nothing at all → unknown.
        let (_, src) = attribute(&AttributionInputs::default());
        assert_eq!(src, HostnameSource::Unknown);
    }
}
