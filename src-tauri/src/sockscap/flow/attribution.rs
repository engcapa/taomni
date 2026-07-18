//! Hostname attribution priority (design plan §4.1 DomainAttribution).
//!
//! Priority: platform remote hostname → Fake-IP/DNS map → TLS SNI / HTTP Host
//! → IP rule → unknown. No TLS decryption is performed here; SNI/Host must be
//! supplied by the capture adapter or a passive parser upstream.

use crate::sockscap::types::HostnameSource;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::RwLock;

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

/// Resolve hostname using the fixed priority chain.
pub fn attribute_hostname(hints: &AttributionHints) -> AttributedHost {
    if let Some(h) = clean(hints.platform_hostname.as_deref()) {
        return AttributedHost {
            hostname: Some(h),
            source: HostnameSource::PlatformRemoteHostname,
        };
    }
    if let Some(h) = clean(hints.fake_ip_hostname.as_deref()) {
        return AttributedHost {
            hostname: Some(h),
            source: HostnameSource::FakeIpDnsMap,
        };
    }
    if let Some(h) = clean(hints.tls_sni.as_deref()) {
        return AttributedHost {
            hostname: Some(h),
            source: HostnameSource::TlsSni,
        };
    }
    if let Some(h) = clean(hints.http_host.as_deref()) {
        // Strip optional port from Host header.
        let host = h.split(':').next().unwrap_or(&h).to_string();
        return AttributedHost {
            hostname: Some(host),
            source: HostnameSource::HttpHost,
        };
    }
    if hints.destination_ip.as_deref().map(str::trim).filter(|s| !s.is_empty()).is_some() {
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

fn clean(s: Option<&str>) -> Option<String> {
    s.map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.trim_end_matches('.').to_ascii_lowercase())
}

/// In-memory Fake-IP / DNS mapping table used by Virtual DNS mode.
#[derive(Debug, Default)]
pub struct FakeIpMap {
    inner: RwLock<HashMap<String, String>>,
}

impl FakeIpMap {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&self, ip: impl Into<String>, hostname: impl Into<String>) {
        if let Ok(mut g) = self.inner.write() {
            g.insert(ip.into(), hostname.into());
        }
    }

    pub fn lookup(&self, ip: &str) -> Option<String> {
        self.inner
            .read()
            .ok()
            .and_then(|g| g.get(ip).cloned())
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

    #[test]
    fn priority_platform_over_sni() {
        let a = attribute_hostname(&AttributionHints {
            platform_hostname: Some("from.platform".into()),
            tls_sni: Some("from.sni".into()),
            ..Default::default()
        });
        assert_eq!(a.hostname.as_deref(), Some("from.platform"));
        assert_eq!(a.source, HostnameSource::PlatformRemoteHostname);
    }

    #[test]
    fn falls_back_to_sni() {
        let a = attribute_hostname(&AttributionHints {
            tls_sni: Some("Sni.Example.COM.".into()),
            ..Default::default()
        });
        assert_eq!(a.hostname.as_deref(), Some("sni.example.com"));
        assert_eq!(a.source, HostnameSource::TlsSni);
    }

    #[test]
    fn ip_only_when_no_name() {
        let a = attribute_hostname(&AttributionHints {
            destination_ip: Some("1.2.3.4".into()),
            ..Default::default()
        });
        assert!(a.hostname.is_none());
        assert_eq!(a.source, HostnameSource::IpOnly);
    }

    #[test]
    fn fake_ip_map_lookup() {
        let map = FakeIpMap::new();
        map.insert("198.18.0.1", "mapped.example");
        let hints = map.resolve_hints(AttributionHints {
            destination_ip: Some("198.18.0.1".into()),
            ..Default::default()
        });
        let a = attribute_hostname(&hints);
        assert_eq!(a.hostname.as_deref(), Some("mapped.example"));
        assert_eq!(a.source, HostnameSource::FakeIpDnsMap);
    }
}
