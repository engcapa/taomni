//! Short-lived IP → hostname map for GFWList matching when only the IP is known.

use std::collections::HashMap;
use std::net::IpAddr;
use std::time::{Duration, Instant};

#[derive(Debug, Clone)]
struct Entry {
    host: String,
    expires: Instant,
}

/// Bounded TTL cache. Not persisted.
#[derive(Debug, Default)]
pub struct DnsMap {
    by_ip: HashMap<IpAddr, Entry>,
    max_entries: usize,
    default_ttl: Duration,
}

impl DnsMap {
    pub fn new(max_entries: usize, default_ttl: Duration) -> Self {
        Self {
            by_ip: HashMap::new(),
            max_entries: max_entries.max(16),
            default_ttl,
        }
    }

    pub fn insert(&mut self, ip: IpAddr, host: impl Into<String>, ttl: Option<Duration>) {
        if self.by_ip.len() >= self.max_entries {
            self.evict_expired();
        }
        if self.by_ip.len() >= self.max_entries {
            // Drop an arbitrary oldest-ish entry.
            if let Some(k) = self.by_ip.keys().next().cloned() {
                self.by_ip.remove(&k);
            }
        }
        let host = host.into().trim_end_matches('.').to_ascii_lowercase();
        if host.is_empty() {
            return;
        }
        self.by_ip.insert(
            ip,
            Entry {
                host,
                expires: Instant::now() + ttl.unwrap_or(self.default_ttl),
            },
        );
    }

    pub fn lookup(&mut self, ip: IpAddr) -> Option<String> {
        let now = Instant::now();
        match self.by_ip.get(&ip) {
            Some(e) if e.expires > now => Some(e.host.clone()),
            Some(_) => {
                self.by_ip.remove(&ip);
                None
            }
            None => None,
        }
    }

    pub fn lookup_ref(&self, ip: IpAddr) -> Option<&str> {
        let now = Instant::now();
        self.by_ip
            .get(&ip)
            .filter(|e| e.expires > now)
            .map(|e| e.host.as_str())
    }

    fn evict_expired(&mut self) {
        let now = Instant::now();
        self.by_ip.retain(|_, e| e.expires > now);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

    #[test]
    fn insert_and_lookup() {
        let mut m = DnsMap::new(64, Duration::from_secs(60));
        let ip = IpAddr::V4(Ipv4Addr::new(1, 2, 3, 4));
        m.insert(ip, "Example.COM", None);
        assert_eq!(m.lookup(ip).as_deref(), Some("example.com"));
    }
}
