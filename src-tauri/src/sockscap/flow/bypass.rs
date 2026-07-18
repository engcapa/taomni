//! Hard-bypass registry for destinations that must never re-enter capture.
//!
//! Loopback, Taomni/helper PIDs, and exact Proxy/SSH upstream endpoints bypass
//! policy. LAN/private/link-local behavior remains a per-profile policy.

use std::collections::HashSet;
use std::net::IpAddr;

use serde::{Deserialize, Serialize};

use crate::sockscap::policy::rules::normalize_hostname;

/// A destination endpoint that must always DIRECT.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BypassEndpoint {
    pub host: String,
    pub port: Option<u16>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum CanonicalHost {
    Ip(IpAddr),
    Domain(String),
}

/// Runtime hard-bypass registry.
#[derive(Debug, Clone, Default)]
pub struct HardBypassSet {
    endpoints: HashSet<(CanonicalHost, Option<u16>)>,
    pids: HashSet<u32>,
}

impl HardBypassSet {
    pub fn new() -> Self {
        let mut set = Self::default();
        set.add_host("localhost", None);
        set
    }

    /// Add a canonical domain/IP endpoint. A specific port stays specific;
    /// registering `proxy:1080` must not bypass unrelated services on proxy's
    /// IP address.
    pub fn add_host(&mut self, host: impl AsRef<str>, port: Option<u16>) -> bool {
        if port == Some(0) {
            return false;
        }
        let Some(host) = canonical_host(host.as_ref()) else {
            return false;
        };
        self.endpoints.insert((host, port));
        true
    }

    pub fn add_endpoint(&mut self, endpoint: &BypassEndpoint) -> bool {
        self.add_host(&endpoint.host, endpoint.port)
    }

    /// Add a process identity owned by Taomni/helper. PID zero is never a real
    /// user-space process selector and is ignored.
    pub fn add_pid(&mut self, pid: u32) -> bool {
        pid != 0 && self.pids.insert(pid)
    }

    pub fn contains_pid(&self, pid: u32) -> bool {
        pid != 0 && self.pids.contains(&pid)
    }

    /// True when the flow must bypass capture and any PROXY/BLOCK policy.
    pub fn matches(
        &self,
        host: Option<&str>,
        ip: Option<&str>,
        port: u16,
        pid: Option<u32>,
    ) -> bool {
        if pid.is_some_and(|pid| self.contains_pid(pid)) {
            return true;
        }

        let ip = ip
            .and_then(|value| value.trim().parse::<IpAddr>().ok())
            .map(CanonicalHost::Ip);
        if ip
            .as_ref()
            .is_some_and(|host| is_loopback(host) || self.matches_host(host, port))
        {
            return true;
        }

        let host = host.and_then(canonical_host);
        host.as_ref()
            .is_some_and(|host| is_loopback(host) || self.matches_host(host, port))
    }

    fn matches_host(&self, host: &CanonicalHost, port: u16) -> bool {
        self.endpoints.contains(&(host.clone(), Some(port)))
            || self.endpoints.contains(&(host.clone(), None))
    }
}

fn canonical_host(input: &str) -> Option<CanonicalHost> {
    let input = input.trim();
    let input = input
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(input);
    if let Ok(ip) = input.parse::<IpAddr>() {
        return Some(CanonicalHost::Ip(ip));
    }
    normalize_hostname(input).map(CanonicalHost::Domain)
}

fn is_loopback(host: &CanonicalHost) -> bool {
    match host {
        CanonicalHost::Ip(ip) => ip.is_loopback(),
        CanonicalHost::Domain(domain) => domain == "localhost",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_is_always_bypassed_without_registration() {
        let set = HardBypassSet::new();
        assert!(set.matches(Some("127.0.0.1"), None, 80, None));
        assert!(set.matches(Some("localhost."), None, 443, None));
        assert!(set.matches(None, Some("::1"), 22, None));
    }

    #[test]
    fn upstream_endpoint_is_port_scoped_for_domain_and_ip() {
        let mut set = HardBypassSet::new();
        assert!(set.add_host("Proxy.Example.com.", Some(1080)));
        assert!(set.add_host("192.0.2.8", Some(1080)));
        assert!(set.matches(Some("proxy.example.com"), None, 1080, None));
        assert!(!set.matches(Some("proxy.example.com"), None, 1081, None));
        assert!(set.matches(None, Some("192.0.2.8"), 1080, None));
        assert!(!set.matches(None, Some("192.0.2.8"), 1081, None));
    }

    #[test]
    fn host_only_endpoint_and_idna_are_supported() {
        let mut set = HardBypassSet::new();
        assert!(set.add_host("BÜCHER.example", None));
        assert!(set.matches(Some("xn--bcher-kva.example"), None, 22, None));
        assert!(set.matches(Some("bücher.example"), None, 443, None));
    }

    #[test]
    fn invalid_endpoints_and_pid_zero_are_rejected() {
        let mut set = HardBypassSet::new();
        assert!(!set.add_host("bad host", Some(1080)));
        assert!(!set.add_host("example.com", Some(0)));
        assert!(!set.add_pid(0));
        assert!(!set.contains_pid(0));
    }

    #[test]
    fn helper_pid_is_bypassed() {
        let mut set = HardBypassSet::new();
        assert!(set.add_pid(42));
        assert!(set.matches(Some("example.com"), None, 443, Some(42)));
        assert!(!set.matches(Some("example.com"), None, 443, Some(43)));
    }
}
