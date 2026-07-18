//! Hard-bypass set: destinations that must never re-enter the capture plane.
//!
//! Design plan §5 / §16.2 #7:
//! - loopback
//! - Taomni / helper PIDs (caller supplies)
//! - Proxy / SSH upstream endpoints
//! - LAN/link-local default DIRECT is a profile policy, not hard bypass

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::net::IpAddr;

/// A destination endpoint that must always DIRECT (and ideally never be captured).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BypassEndpoint {
    pub host: String,
    pub port: Option<u16>,
}

/// Runtime hard-bypass registry.
#[derive(Debug, Clone, Default)]
pub struct HardBypassSet {
    endpoints: HashSet<(String, Option<u16>)>,
    ips: HashSet<IpAddr>,
    pids: HashSet<u32>,
}

impl HardBypassSet {
    pub fn new() -> Self {
        let mut s = Self::default();
        // Always bypass loopback hosts.
        s.add_host("127.0.0.1", None);
        s.add_host("::1", None);
        s.add_host("localhost", None);
        if let Ok(ip) = "127.0.0.1".parse() {
            s.ips.insert(ip);
        }
        if let Ok(ip) = "::1".parse() {
            s.ips.insert(ip);
        }
        s
    }

    pub fn add_host(&mut self, host: impl Into<String>, port: Option<u16>) {
        let host = host.into().trim().to_ascii_lowercase();
        if host.is_empty() {
            return;
        }
        if let Ok(ip) = host.parse::<IpAddr>() {
            self.ips.insert(ip);
        }
        self.endpoints.insert((host, port));
        // Also insert host-any-port entry when a specific port is given so
        // callers can match either way.
        if port.is_some() {
            // keep specific port entry only; matching checks both
        }
    }

    pub fn add_endpoint(&mut self, ep: &BypassEndpoint) {
        self.add_host(ep.host.clone(), ep.port);
    }

    pub fn add_pid(&mut self, pid: u32) {
        self.pids.insert(pid);
    }

    pub fn contains_pid(&self, pid: u32) -> bool {
        self.pids.contains(&pid)
    }

    /// True when the flow must hard-bypass capture/policy PROXY.
    pub fn matches(&self, host: Option<&str>, ip: Option<&str>, port: u16, pid: Option<u32>) -> bool {
        if let Some(pid) = pid {
            if self.pids.contains(&pid) {
                return true;
            }
        }
        if let Some(ip_s) = ip {
            if let Ok(ip) = ip_s.parse::<IpAddr>() {
                if self.ips.contains(&ip) {
                    return true;
                }
                if ip.is_loopback() {
                    return true;
                }
            }
        }
        if let Some(h) = host {
            let h = h.trim().trim_end_matches('.').to_ascii_lowercase();
            if h == "localhost" {
                return true;
            }
            if self.endpoints.contains(&(h.clone(), Some(port)))
                || self.endpoints.contains(&(h.clone(), None))
            {
                return true;
            }
            if let Ok(ip) = h.parse::<IpAddr>() {
                if self.ips.contains(&ip) || ip.is_loopback() {
                    return true;
                }
            }
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_always_bypassed() {
        let s = HardBypassSet::new();
        assert!(s.matches(Some("127.0.0.1"), None, 80, None));
        assert!(s.matches(Some("localhost"), None, 443, None));
        assert!(s.matches(None, Some("::1"), 22, None));
    }

    #[test]
    fn upstream_endpoint_bypass() {
        let mut s = HardBypassSet::new();
        s.add_host("proxy.example.com", Some(1080));
        assert!(s.matches(Some("proxy.example.com"), None, 1080, None));
        assert!(!s.matches(Some("proxy.example.com"), None, 1081, None));
        // host-only entry
        s.add_host("jump.example.com", None);
        assert!(s.matches(Some("jump.example.com"), None, 22, None));
    }

    #[test]
    fn pid_bypass() {
        let mut s = HardBypassSet::new();
        s.add_pid(42);
        assert!(s.matches(Some("example.com"), None, 443, Some(42)));
        assert!(!s.matches(Some("example.com"), None, 443, Some(43)));
    }
}
