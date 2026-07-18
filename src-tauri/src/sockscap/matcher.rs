//! Immutable compiled rule matcher (plan §6.3).
//!
//! Domains compile into a reverse-label trie (labels stored parent = TLD), IPs
//! into most-specific-first prefix lists. A [`CompiledRuleSource`] is built once
//! and shared read-only; updating rules builds a *new* snapshot and swaps it
//! atomically so existing flows keep their old decision (plan §16.4-14).

use std::collections::HashMap;
use std::net::IpAddr;

use super::model::RuleDirection;

/// An IP address or CIDR block. A bare address is stored as a full-length
/// prefix (/32 or /128).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IpCidr {
    pub addr: IpAddr,
    pub prefix_len: u8,
}

impl IpCidr {
    /// Parse `"1.2.3.4"`, `"1.2.3.0/24"`, `"::1"` or `"2001:db8::/32"`.
    pub fn parse(s: &str) -> Option<IpCidr> {
        let s = s.trim();
        if let Some((addr_part, len_part)) = s.split_once('/') {
            let addr: IpAddr = addr_part.trim().parse().ok()?;
            let prefix_len: u8 = len_part.trim().parse().ok()?;
            let max = match addr {
                IpAddr::V4(_) => 32,
                IpAddr::V6(_) => 128,
            };
            if prefix_len > max {
                return None;
            }
            Some(IpCidr { addr, prefix_len })
        } else {
            let addr: IpAddr = s.parse().ok()?;
            let prefix_len = match addr {
                IpAddr::V4(_) => 32,
                IpAddr::V6(_) => 128,
            };
            Some(IpCidr { addr, prefix_len })
        }
    }

    /// Whether `ip` falls inside this prefix. Mismatched families never match.
    pub fn contains(&self, ip: IpAddr) -> bool {
        match (self.addr, ip) {
            (IpAddr::V4(net), IpAddr::V4(ip)) => {
                prefix_match(&net.octets(), &ip.octets(), self.prefix_len)
            }
            (IpAddr::V6(net), IpAddr::V6(ip)) => {
                prefix_match(&net.octets(), &ip.octets(), self.prefix_len)
            }
            _ => false,
        }
    }
}

/// Compare the first `prefix_len` bits of two equal-length octet arrays.
fn prefix_match(net: &[u8], ip: &[u8], prefix_len: u8) -> bool {
    let full_bytes = (prefix_len / 8) as usize;
    if net[..full_bytes] != ip[..full_bytes] {
        return false;
    }
    let rem_bits = prefix_len % 8;
    if rem_bits == 0 {
        return true;
    }
    let mask = 0xFFu8 << (8 - rem_bits);
    (net[full_bytes] & mask) == (ip[full_bytes] & mask)
}

/// What kind of pattern matched, for test-target explainability (plan §6.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MatchKind {
    DomainSuffix,
    DomainExact,
    Ip,
    Cidr,
}

/// A single match result with enough provenance to explain the decision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuleHit {
    pub direction: RuleDirection,
    pub kind: MatchKind,
    /// The original rule text (e.g. `||example.com`, `192.168.0.0/16`).
    pub pattern: String,
    pub source_id: String,
}

/// Normalize a hostname for matching: trim, drop a trailing dot, lowercase.
/// (IDNA is applied at *compile* time in `autoproxy.rs`; live lookups only need
/// case/dot folding since captured hostnames already arrive in ASCII form.)
pub fn normalize_host(host: &str) -> String {
    host.trim().trim_end_matches('.').to_ascii_lowercase()
}

#[derive(Default)]
struct TrieNode {
    children: HashMap<String, TrieNode>,
    /// Original pattern text if a suffix rule terminates here (matches this
    /// domain and every subdomain).
    suffix_pattern: Option<String>,
    /// Original pattern text if an exact rule terminates here.
    exact_pattern: Option<String>,
}

/// A reverse-label domain trie. Lookups are O(number of labels).
#[derive(Default)]
pub struct DomainTrie {
    root: TrieNode,
    len: usize,
}

impl DomainTrie {
    pub fn new() -> DomainTrie {
        DomainTrie::default()
    }

    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// Insert a suffix rule: matches `domain` and any subdomain of it.
    pub fn insert_suffix(&mut self, domain: &str, pattern: String) {
        let node = self.descend(domain);
        if node.suffix_pattern.is_none() {
            node.suffix_pattern = Some(pattern);
            self.len += 1;
        }
    }

    /// Insert an exact rule: matches only `domain`.
    pub fn insert_exact(&mut self, domain: &str, pattern: String) {
        let node = self.descend(domain);
        if node.exact_pattern.is_none() {
            node.exact_pattern = Some(pattern);
            self.len += 1;
        }
    }

    fn descend(&mut self, domain: &str) -> &mut TrieNode {
        let mut node = &mut self.root;
        for label in domain.split('.').filter(|l| !l.is_empty()).rev() {
            node = node.children.entry(label.to_string()).or_default();
        }
        node
    }

    /// Look up a host. Returns the most general suffix match if any, otherwise
    /// an exact match. `None` means no rule in this trie applies.
    pub fn lookup(&self, host: &str) -> Option<(MatchKind, String)> {
        let host = normalize_host(host);
        let labels: Vec<&str> = host.split('.').filter(|l| !l.is_empty()).collect();
        let mut node = &self.root;
        for label in labels.iter().rev() {
            match node.children.get(*label) {
                Some(child) => {
                    node = child;
                    if let Some(pat) = &node.suffix_pattern {
                        return Some((MatchKind::DomainSuffix, pat.clone()));
                    }
                }
                None => return None,
            }
        }
        node
            .exact_pattern
            .as_ref()
            .map(|pat| (MatchKind::DomainExact, pat.clone()))
    }
}

/// Most-specific-first IP prefix matcher. Prefixes are kept sorted by
/// descending prefix length so the first containing entry is the most specific.
#[derive(Default)]
pub struct IpMatcher {
    v4: Vec<(IpCidr, String)>,
    v6: Vec<(IpCidr, String)>,
}

impl IpMatcher {
    pub fn new() -> IpMatcher {
        IpMatcher::default()
    }

    pub fn len(&self) -> usize {
        self.v4.len() + self.v6.len()
    }

    pub fn is_empty(&self) -> bool {
        self.v4.is_empty() && self.v6.is_empty()
    }

    pub fn insert(&mut self, cidr: IpCidr, pattern: String) {
        match cidr.addr {
            IpAddr::V4(_) => self.v4.push((cidr, pattern)),
            IpAddr::V6(_) => self.v6.push((cidr, pattern)),
        }
    }

    /// Sort each family most-specific-first. Call once after all inserts.
    pub fn finalize(&mut self) {
        self.v4.sort_by(|a, b| b.0.prefix_len.cmp(&a.0.prefix_len));
        self.v6.sort_by(|a, b| b.0.prefix_len.cmp(&a.0.prefix_len));
    }

    pub fn lookup(&self, ip: IpAddr) -> Option<(MatchKind, String)> {
        let bucket = match ip {
            IpAddr::V4(_) => &self.v4,
            IpAddr::V6(_) => &self.v6,
        };
        for (cidr, pattern) in bucket {
            if cidr.contains(ip) {
                let kind = if cidr.prefix_len
                    == match ip {
                        IpAddr::V4(_) => 32,
                        IpAddr::V6(_) => 128,
                    } {
                    MatchKind::Ip
                } else {
                    MatchKind::Cidr
                };
                return Some((kind, pattern.clone()));
            }
        }
        None
    }
}

/// A single rule source compiled into matchers. Exception (`@@` / DIRECT)
/// entries are kept separate and consulted first, since within one source an
/// exception outranks a proxy entry (plan §6.3 step 3 before step 4,
/// §16.3-11).
pub struct CompiledRuleSource {
    pub source_id: String,
    exception_domains: DomainTrie,
    proxy_domains: DomainTrie,
    exception_ips: IpMatcher,
    proxy_ips: IpMatcher,
}

impl CompiledRuleSource {
    pub fn new(source_id: impl Into<String>) -> CompiledRuleSource {
        CompiledRuleSource {
            source_id: source_id.into(),
            exception_domains: DomainTrie::new(),
            proxy_domains: DomainTrie::new(),
            exception_ips: IpMatcher::new(),
            proxy_ips: IpMatcher::new(),
        }
    }

    /// Number of compiled (effective) domain rules across both directions.
    pub fn domain_len(&self) -> usize {
        self.exception_domains.len() + self.proxy_domains.len()
    }

    /// Number of compiled (effective) IP rules across both directions.
    pub fn ip_len(&self) -> usize {
        self.exception_ips.len() + self.proxy_ips.len()
    }

    /// Exception-only lookup across domain then IP (⇒ DIRECT). Used by the
    /// policy engine to honor "all exceptions before all proxies" globally
    /// across sources (plan §6.3 step 3 before step 4).
    pub fn lookup_exception(&self, host: Option<&str>, ip: Option<IpAddr>) -> Option<RuleHit> {
        if let Some(h) = host {
            if let Some((kind, pattern)) = self.exception_domains.lookup(h) {
                return Some(self.hit(RuleDirection::Direct, kind, pattern));
            }
        }
        if let Some(ip) = ip {
            if let Some((kind, pattern)) = self.exception_ips.lookup(ip) {
                return Some(self.hit(RuleDirection::Direct, kind, pattern));
            }
        }
        None
    }

    /// Proxy-only lookup across domain then IP (⇒ PROXY).
    pub fn lookup_proxy(&self, host: Option<&str>, ip: Option<IpAddr>) -> Option<RuleHit> {
        if let Some(h) = host {
            if let Some((kind, pattern)) = self.proxy_domains.lookup(h) {
                return Some(self.hit(RuleDirection::Proxy, kind, pattern));
            }
        }
        if let Some(ip) = ip {
            if let Some((kind, pattern)) = self.proxy_ips.lookup(ip) {
                return Some(self.hit(RuleDirection::Proxy, kind, pattern));
            }
        }
        None
    }

    fn hit(&self, direction: RuleDirection, kind: MatchKind, pattern: String) -> RuleHit {
        RuleHit {
            direction,
            kind,
            pattern,
            source_id: self.source_id.clone(),
        }
    }

    /// Match by hostname. Exception before proxy (exception ⇒ DIRECT).
    pub fn lookup_domain(&self, host: &str) -> Option<RuleHit> {
        if let Some((kind, pattern)) = self.exception_domains.lookup(host) {
            return Some(RuleHit {
                direction: RuleDirection::Direct,
                kind,
                pattern,
                source_id: self.source_id.clone(),
            });
        }
        self.proxy_domains.lookup(host).map(|(kind, pattern)| RuleHit {
            direction: RuleDirection::Proxy,
            kind,
            pattern,
            source_id: self.source_id.clone(),
        })
    }

    /// Match by destination IP. Exception before proxy.
    pub fn lookup_ip(&self, ip: IpAddr) -> Option<RuleHit> {
        if let Some((kind, pattern)) = self.exception_ips.lookup(ip) {
            return Some(RuleHit {
                direction: RuleDirection::Direct,
                kind,
                pattern,
                source_id: self.source_id.clone(),
            });
        }
        self.proxy_ips.lookup(ip).map(|(kind, pattern)| RuleHit {
            direction: RuleDirection::Proxy,
            kind,
            pattern,
            source_id: self.source_id.clone(),
        })
    }

    pub(crate) fn insert_domain(&mut self, direction: RuleDirection, suffix: bool, domain: &str, pattern: String) {
        let trie = match direction {
            RuleDirection::Direct => &mut self.exception_domains,
            _ => &mut self.proxy_domains,
        };
        if suffix {
            trie.insert_suffix(domain, pattern);
        } else {
            trie.insert_exact(domain, pattern);
        }
    }

    pub(crate) fn insert_ip(&mut self, direction: RuleDirection, cidr: IpCidr, pattern: String) {
        let matcher = match direction {
            RuleDirection::Direct => &mut self.exception_ips,
            _ => &mut self.proxy_ips,
        };
        matcher.insert(cidr, pattern);
    }

    pub(crate) fn finalize(&mut self) {
        self.exception_ips.finalize();
        self.proxy_ips.finalize();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cidr_parse_and_contains_v4() {
        let net = IpCidr::parse("192.168.0.0/16").unwrap();
        assert!(net.contains("192.168.1.1".parse().unwrap()));
        assert!(net.contains("192.168.255.254".parse().unwrap()));
        assert!(!net.contains("192.169.0.1".parse().unwrap()));
        assert!(!net.contains("10.0.0.1".parse().unwrap()));
    }

    #[test]
    fn cidr_bare_ip_is_full_prefix() {
        let one = IpCidr::parse("1.2.3.4").unwrap();
        assert_eq!(one.prefix_len, 32);
        assert!(one.contains("1.2.3.4".parse().unwrap()));
        assert!(!one.contains("1.2.3.5".parse().unwrap()));
    }

    #[test]
    fn cidr_v6_and_family_isolation() {
        let net = IpCidr::parse("2001:db8::/32").unwrap();
        assert!(net.contains("2001:db8::1".parse().unwrap()));
        assert!(!net.contains("2001:db9::1".parse().unwrap()));
        // v4 never matches a v6 prefix and vice versa.
        assert!(!net.contains("192.168.0.1".parse().unwrap()));
    }

    #[test]
    fn cidr_rejects_out_of_range_prefix() {
        assert!(IpCidr::parse("10.0.0.0/33").is_none());
        assert!(IpCidr::parse("::/129").is_none());
        assert!(IpCidr::parse("not-an-ip").is_none());
    }

    #[test]
    fn domain_suffix_matches_self_and_subdomains() {
        let mut t = DomainTrie::new();
        t.insert_suffix("example.com", "||example.com".into());
        assert!(t.lookup("example.com").is_some());
        assert!(t.lookup("a.b.example.com").is_some());
        assert!(t.lookup("notexample.com").is_none());
        assert!(t.lookup("example.org").is_none());
        // trailing dot / case fold
        assert!(t.lookup("A.Example.Com.").is_some());
    }

    #[test]
    fn domain_exact_does_not_match_subdomains() {
        let mut t = DomainTrie::new();
        t.insert_exact("example.com", "|http://example.com".into());
        assert_eq!(t.lookup("example.com").unwrap().0, MatchKind::DomainExact);
        assert!(t.lookup("www.example.com").is_none());
    }

    #[test]
    fn ip_matcher_prefers_most_specific() {
        let mut m = IpMatcher::new();
        m.insert(IpCidr::parse("10.0.0.0/8").unwrap(), "10.0.0.0/8".into());
        m.insert(IpCidr::parse("10.1.2.0/24").unwrap(), "10.1.2.0/24".into());
        m.finalize();
        let (kind, pat) = m.lookup("10.1.2.3".parse().unwrap()).unwrap();
        assert_eq!(kind, MatchKind::Cidr);
        assert_eq!(pat, "10.1.2.0/24");
        let (_, pat2) = m.lookup("10.9.9.9".parse().unwrap()).unwrap();
        assert_eq!(pat2, "10.0.0.0/8");
    }

    #[test]
    fn compiled_source_exception_beats_proxy_within_source() {
        let mut src = CompiledRuleSource::new("gfwlist-official");
        src.insert_domain(RuleDirection::Proxy, true, "google.com", "||google.com".into());
        src.insert_domain(RuleDirection::Direct, true, "cache.google.com", "@@||cache.google.com".into());
        src.finalize();
        // The exception subdomain resolves to DIRECT even though the broader
        // proxy suffix also covers it.
        let hit = src.lookup_domain("x.cache.google.com").unwrap();
        assert_eq!(hit.direction, RuleDirection::Direct);
        // A sibling under the proxy suffix still routes to PROXY.
        let hit2 = src.lookup_domain("mail.google.com").unwrap();
        assert_eq!(hit2.direction, RuleDirection::Proxy);
    }
}
