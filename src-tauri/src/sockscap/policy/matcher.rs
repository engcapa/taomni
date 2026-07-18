//! Immutable compiled policy snapshot and first-match evaluation.
//!
//! Decision order (design plan §6.3 / §16.3):
//! 1. Engine hard bypass (loopback, helper, upstream endpoints) — caller supplies
//! 2. User ordered overrides (first-match wins)
//! 3. Subscription DIRECT exceptions
//! 4. Subscription PROXY rules
//! 5. Profile default_action

use super::rules::{CompiledRule, RuleKind, normalize_hostname};
use crate::sockscap::types::{HostnameSource, RouteAction};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Arc;

/// Input for a single policy evaluation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowMatchInput {
    pub profile_id: String,
    pub hostname: Option<String>,
    pub hostname_source: HostnameSource,
    pub ip: Option<String>,
    pub port: u16,
    pub protocol: String,
    /// When true, skip subscription/user rules and return hard-bypass DIRECT.
    pub hard_bypass: bool,
}

/// Explainable decision returned to test_target / engine.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyDecision {
    pub action: RouteAction,
    pub matched_rule_original: Option<String>,
    pub matched_rule_source_id: Option<String>,
    pub matched_stage: String,
    pub hostname_source: HostnameSource,
    pub profile_id: String,
}

/// Per-profile compiled matchers. Cheap to clone via Arc swap.
#[derive(Debug, Clone, Default)]
pub struct ProfileMatcher {
    pub profile_id: String,
    pub default_action: RouteAction,
    pub unknown_domain_action: RouteAction,
    /// User overrides, ordered, first-match wins.
    pub user_overrides: Vec<CompiledRule>,
    pub subscription_direct: DomainIpIndex,
    pub subscription_proxy: DomainIpIndex,
}

/// Reverse-label domain suffix index + exact + keyword + IP/CIDR list.
#[derive(Debug, Clone, Default)]
pub struct DomainIpIndex {
    /// reverse("com.example") → rule meta
    suffix: HashMap<String, RuleMeta>,
    exact: HashMap<String, RuleMeta>,
    keywords: Vec<(String, RuleMeta)>,
    /// Stored as (network, prefix_len, meta) for linear scan; fine for Phase 1.
    cidrs: Vec<(IpAddr, u8, RuleMeta)>,
}

#[derive(Debug, Clone)]
struct RuleMeta {
    original: String,
    source_id: String,
}

impl DomainIpIndex {
    pub fn insert(&mut self, rule: &CompiledRule) {
        let meta = RuleMeta {
            original: rule.original.clone(),
            source_id: rule.source_id.clone(),
        };
        match rule.kind {
            RuleKind::DomainSuffix => {
                let key = reverse_labels(&rule.pattern);
                self.suffix.entry(key).or_insert(meta);
            }
            RuleKind::DomainExact => {
                self.exact.entry(rule.pattern.clone()).or_insert(meta);
            }
            RuleKind::DomainKeyword => {
                self.keywords.push((rule.pattern.clone(), meta));
            }
            RuleKind::IpCidr => {
                if let Some((ip, prefix)) = parse_ip_or_cidr(&rule.pattern) {
                    self.cidrs.push((ip, prefix, meta));
                }
            }
        }
    }

    fn match_host(&self, host: &str) -> Option<&RuleMeta> {
        if let Some(m) = self.exact.get(host) {
            return Some(m);
        }
        // reverse-label index: parents are prefixes of the reversed key.
        // www.google.com → com.google.www; google.com → com.google
        let rev = reverse_labels(host);
        let mut candidate = rev.as_str();
        loop {
            if let Some(m) = self.suffix.get(candidate) {
                return Some(m);
            }
            if let Some(idx) = candidate.rfind('.') {
                candidate = &candidate[..idx];
            } else {
                break;
            }
        }
        for (kw, meta) in &self.keywords {
            if host.contains(kw.as_str()) {
                return Some(meta);
            }
        }
        None
    }

    fn match_ip(&self, ip: IpAddr) -> Option<&RuleMeta> {
        for (net, prefix, meta) in &self.cidrs {
            if ip_in_cidr(ip, *net, *prefix) {
                return Some(meta);
            }
        }
        None
    }
}

fn reverse_labels(host: &str) -> String {
    let mut parts: Vec<&str> = host.split('.').collect();
    parts.reverse();
    parts.join(".")
}

fn parse_ip_or_cidr(s: &str) -> Option<(IpAddr, u8)> {
    if let Some((ip, p)) = s.split_once('/') {
        let ip: IpAddr = ip.parse().ok()?;
        let prefix: u8 = p.parse().ok()?;
        return Some((ip, prefix));
    }
    let ip: IpAddr = s.parse().ok()?;
    let prefix = match ip {
        IpAddr::V4(_) => 32,
        IpAddr::V6(_) => 128,
    };
    Some((ip, prefix))
}

fn ip_in_cidr(ip: IpAddr, network: IpAddr, prefix: u8) -> bool {
    match (ip, network) {
        (IpAddr::V4(a), IpAddr::V4(n)) => {
            if prefix > 32 {
                return false;
            }
            let mask = if prefix == 0 {
                0
            } else {
                u32::MAX << (32 - prefix)
            };
            (u32::from(a) & mask) == (u32::from(n) & mask)
        }
        (IpAddr::V6(a), IpAddr::V6(n)) => {
            if prefix > 128 {
                return false;
            }
            let a = u128::from(a);
            let n = u128::from(n);
            let mask = if prefix == 0 {
                0
            } else {
                u128::MAX << (128 - prefix)
            };
            (a & mask) == (n & mask)
        }
        _ => false,
    }
}

impl ProfileMatcher {
    pub fn from_parts(
        profile_id: impl Into<String>,
        default_action: RouteAction,
        unknown_domain_action: RouteAction,
        user_overrides: Vec<CompiledRule>,
        subscription_direct: &[CompiledRule],
        subscription_proxy: &[CompiledRule],
    ) -> Self {
        let mut direct = DomainIpIndex::default();
        let mut proxy = DomainIpIndex::default();
        for r in subscription_direct {
            direct.insert(r);
        }
        for r in subscription_proxy {
            proxy.insert(r);
        }
        Self {
            profile_id: profile_id.into(),
            default_action,
            unknown_domain_action,
            user_overrides,
            subscription_direct: direct,
            subscription_proxy: proxy,
        }
    }

    pub fn decide(&self, input: &FlowMatchInput) -> PolicyDecision {
        if input.hard_bypass {
            return PolicyDecision {
                action: RouteAction::Direct,
                matched_rule_original: None,
                matched_rule_source_id: None,
                matched_stage: "hard_bypass".into(),
                hostname_source: input.hostname_source,
                profile_id: self.profile_id.clone(),
            };
        }

        let host = input.hostname.as_deref().and_then(normalize_hostname);
        let ip = input.ip.as_deref().and_then(|s| s.parse::<IpAddr>().ok());

        // Unknown domain policy when no hostname and no IP match path.
        if host.is_none() && ip.is_none() {
            return PolicyDecision {
                action: self.unknown_domain_action,
                matched_rule_original: None,
                matched_rule_source_id: None,
                matched_stage: "unknown_domain_action".into(),
                hostname_source: input.hostname_source,
                profile_id: self.profile_id.clone(),
            };
        }

        // 2. User overrides first-match
        for rule in &self.user_overrides {
            if rule_matches(rule, host.as_deref(), ip) {
                return PolicyDecision {
                    action: rule.action,
                    matched_rule_original: Some(rule.original.clone()),
                    matched_rule_source_id: Some(rule.source_id.clone()),
                    matched_stage: "user_override".into(),
                    hostname_source: input.hostname_source,
                    profile_id: self.profile_id.clone(),
                };
            }
        }

        // 3. Subscription DIRECT exceptions
        if let Some(meta) = match_index(&self.subscription_direct, host.as_deref(), ip) {
            return PolicyDecision {
                action: RouteAction::Direct,
                matched_rule_original: Some(meta.original.clone()),
                matched_rule_source_id: Some(meta.source_id.clone()),
                matched_stage: "subscription_exception".into(),
                hostname_source: input.hostname_source,
                profile_id: self.profile_id.clone(),
            };
        }

        // 4. Subscription PROXY
        if let Some(meta) = match_index(&self.subscription_proxy, host.as_deref(), ip) {
            return PolicyDecision {
                action: RouteAction::Proxy,
                matched_rule_original: Some(meta.original.clone()),
                matched_rule_source_id: Some(meta.source_id.clone()),
                matched_stage: "subscription_proxy".into(),
                hostname_source: input.hostname_source,
                profile_id: self.profile_id.clone(),
            };
        }

        // 5. An IP-only flow gets one chance to match IP rules, then follows
        // the explicit unknown-hostname policy. Known hostnames use default.
        let (action, matched_stage) = if host.is_none() {
            (self.unknown_domain_action, "unknown_domain_action")
        } else {
            (self.default_action, "default_action")
        };

        PolicyDecision {
            action,
            matched_rule_original: None,
            matched_rule_source_id: None,
            matched_stage: matched_stage.into(),
            hostname_source: input.hostname_source,
            profile_id: self.profile_id.clone(),
        }
    }
}

fn match_index<'a>(
    index: &'a DomainIpIndex,
    host: Option<&str>,
    ip: Option<IpAddr>,
) -> Option<&'a RuleMeta> {
    if let Some(h) = host {
        if let Some(m) = index.match_host(h) {
            return Some(m);
        }
    }
    if let Some(ip) = ip {
        if let Some(m) = index.match_ip(ip) {
            return Some(m);
        }
    }
    None
}

fn rule_matches(rule: &CompiledRule, host: Option<&str>, ip: Option<IpAddr>) -> bool {
    match rule.kind {
        RuleKind::DomainExact => host == Some(rule.pattern.as_str()),
        RuleKind::DomainSuffix => host
            .map(|h| h == rule.pattern || h.ends_with(&format!(".{}", rule.pattern)))
            .unwrap_or(false),
        RuleKind::DomainKeyword => host
            .map(|h| h.contains(rule.pattern.as_str()))
            .unwrap_or(false),
        RuleKind::IpCidr => {
            if let (Some(ip), Some((net, prefix))) = (ip, parse_ip_or_cidr(&rule.pattern)) {
                ip_in_cidr(ip, net, prefix)
            } else {
                false
            }
        }
    }
}

/// Process-wide immutable snapshot of all profile matchers (atomic replace).
#[derive(Debug, Clone, Default)]
pub struct PolicySnapshot {
    profiles: HashMap<String, Arc<ProfileMatcher>>,
    /// Ordered profile ids by priority (ascending = higher priority).
    priority_order: Vec<String>,
}

impl PolicySnapshot {
    pub fn new(matchers: Vec<ProfileMatcher>, priority_order: Vec<String>) -> Self {
        let mut profiles = HashMap::new();
        for m in matchers {
            profiles.insert(m.profile_id.clone(), Arc::new(m));
        }
        Self {
            profiles,
            priority_order,
        }
    }

    pub fn get(&self, profile_id: &str) -> Option<Arc<ProfileMatcher>> {
        self.profiles.get(profile_id).cloned()
    }

    pub fn priority_order(&self) -> &[String] {
        &self.priority_order
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sockscap::policy::rules::parse_rule_document;
    use crate::sockscap::types::RouteAction;

    fn matcher_from_doc(doc: &str) -> ProfileMatcher {
        let report = parse_rule_document("gfw", doc);
        ProfileMatcher::from_parts(
            "p1",
            RouteAction::Direct,
            RouteAction::Direct,
            vec![],
            &report.direct_rules,
            &report.proxy_rules,
        )
    }

    #[test]
    fn proxy_suffix_match() {
        let m = matcher_from_doc("||google.com\n");
        let d = m.decide(&FlowMatchInput {
            profile_id: "p1".into(),
            hostname: Some("www.google.com".into()),
            hostname_source: HostnameSource::TlsSni,
            ip: None,
            port: 443,
            protocol: "tcp".into(),
            hard_bypass: false,
        });
        assert_eq!(d.action, RouteAction::Proxy);
        assert_eq!(d.matched_stage, "subscription_proxy");
    }

    #[test]
    fn exception_beats_proxy() {
        let m = matcher_from_doc("||github.com\n@@||github.com\n");
        let d = m.decide(&FlowMatchInput {
            profile_id: "p1".into(),
            hostname: Some("github.com".into()),
            hostname_source: HostnameSource::HttpHost,
            ip: None,
            port: 443,
            protocol: "tcp".into(),
            hard_bypass: false,
        });
        assert_eq!(d.action, RouteAction::Direct);
        assert_eq!(d.matched_stage, "subscription_exception");
    }

    #[test]
    fn user_override_first_match() {
        let report = parse_rule_document("gfw", "||blocked.example\n");
        let override_rule = CompiledRule {
            action: RouteAction::Block,
            kind: RuleKind::DomainSuffix,
            pattern: "blocked.example".into(),
            original: "BLOCK blocked.example".into(),
            source_id: "user".into(),
        };
        let m = ProfileMatcher::from_parts(
            "p1",
            RouteAction::Direct,
            RouteAction::Direct,
            vec![override_rule],
            &report.direct_rules,
            &report.proxy_rules,
        );
        let d = m.decide(&FlowMatchInput {
            profile_id: "p1".into(),
            hostname: Some("a.blocked.example".into()),
            hostname_source: HostnameSource::PlatformRemoteHostname,
            ip: None,
            port: 80,
            protocol: "tcp".into(),
            hard_bypass: false,
        });
        assert_eq!(d.action, RouteAction::Block);
        assert_eq!(d.matched_stage, "user_override");
    }

    #[test]
    fn hard_bypass_short_circuits() {
        let m = matcher_from_doc("||google.com\n");
        let d = m.decide(&FlowMatchInput {
            profile_id: "p1".into(),
            hostname: Some("google.com".into()),
            hostname_source: HostnameSource::TlsSni,
            ip: None,
            port: 443,
            protocol: "tcp".into(),
            hard_bypass: true,
        });
        assert_eq!(d.action, RouteAction::Direct);
        assert_eq!(d.matched_stage, "hard_bypass");
    }

    #[test]
    fn unknown_uses_unknown_action() {
        let mut m = matcher_from_doc("");
        m.unknown_domain_action = RouteAction::Proxy;
        let d = m.decide(&FlowMatchInput {
            profile_id: "p1".into(),
            hostname: None,
            hostname_source: HostnameSource::Unknown,
            ip: None,
            port: 443,
            protocol: "tcp".into(),
            hard_bypass: false,
        });
        assert_eq!(d.action, RouteAction::Proxy);
        assert_eq!(d.matched_stage, "unknown_domain_action");
    }

    #[test]
    fn cidr_match() {
        let m = matcher_from_doc("10.0.0.0/8\n");
        let d = m.decide(&FlowMatchInput {
            profile_id: "p1".into(),
            hostname: None,
            hostname_source: HostnameSource::IpOnly,
            ip: Some("10.1.2.3".into()),
            port: 80,
            protocol: "tcp".into(),
            hard_bypass: false,
        });
        assert_eq!(d.action, RouteAction::Proxy);
    }

    #[test]
    fn suffix_matches_label_boundary_not_substring() {
        let m = matcher_from_doc("||example.com\n");
        for (host, expected) in [
            ("example.com", RouteAction::Proxy),
            ("a.example.com", RouteAction::Proxy),
            ("notexample.com", RouteAction::Direct),
            ("example.com.invalid", RouteAction::Direct),
        ] {
            let decision = m.decide(&FlowMatchInput {
                profile_id: "p1".into(),
                hostname: Some(host.into()),
                hostname_source: HostnameSource::TlsSni,
                ip: None,
                port: 443,
                protocol: "tcp".into(),
                hard_bypass: false,
            });
            assert_eq!(decision.action, expected, "host={host}");
        }
    }

    #[test]
    fn unicode_hostname_matches_idna_compiled_rule() {
        let m = matcher_from_doc("||bücher.example\n");
        let decision = m.decide(&FlowMatchInput {
            profile_id: "p1".into(),
            hostname: Some("shop.bücher.example".into()),
            hostname_source: HostnameSource::TlsSni,
            ip: None,
            port: 443,
            protocol: "tcp".into(),
            hard_bypass: false,
        });
        assert_eq!(decision.action, RouteAction::Proxy);
    }

    #[test]
    fn cidr_matching_obeys_family_and_prefix_boundaries() {
        for (cidr, inside, outside) in [
            ("10.0.0.0/8", "10.255.255.255", "11.0.0.0"),
            ("2001:db8::/32", "2001:db8:ffff::1", "2001:db9::1"),
        ] {
            let matcher = matcher_from_doc(&format!("{cidr}\n"));
            for (ip, expected) in [(inside, RouteAction::Proxy), (outside, RouteAction::Direct)] {
                let decision = matcher.decide(&FlowMatchInput {
                    profile_id: "p1".into(),
                    hostname: None,
                    hostname_source: HostnameSource::IpOnly,
                    ip: Some(ip.into()),
                    port: 443,
                    protocol: "tcp".into(),
                    hard_bypass: false,
                });
                assert_eq!(decision.action, expected, "cidr={cidr}, ip={ip}");
            }
        }
    }
}
