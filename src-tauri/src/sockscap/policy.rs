//! Policy engine: hard-bypass → user rules → bypass CIDR → GFWList → default.

use crate::sockscap::config::{
    Decision, RuleMode, ScopeMode, SocksCapConfig, UserRule, UserRuleAction,
};
use crate::sockscap::paths::{normalize_exe_path, paths_match_exe};
use crate::sockscap::rules::{CompiledRules, RuleMatch};
use std::net::IpAddr;

#[derive(Debug, Clone)]
pub struct PolicyInput {
    pub host: Option<String>,
    pub ip: Option<IpAddr>,
    pub port: u16,
    pub process_path: Option<String>,
    pub pid: Option<u32>,
}

#[derive(Debug, Clone)]
pub struct MatchTrace {
    pub decision: Decision,
    pub reason: String,
    pub matched_rule: Option<String>,
}

pub struct PolicyEngine {
    mode: ScopeMode,
    apps: Vec<String>,
    rule_mode: RuleMode,
    user_rules: Vec<UserRule>,
    bypass_cidrs: Vec<IpNetwork>,
    default_action: Decision,
    rules: Option<CompiledRules>,
}

#[derive(Debug, Clone)]
struct IpNetwork {
    addr: IpAddr,
    prefix: u8,
}

impl IpNetwork {
    fn parse(s: &str) -> Option<Self> {
        let s = s.trim();
        if let Some((a, p)) = s.split_once('/') {
            let addr: IpAddr = a.parse().ok()?;
            let prefix: u8 = p.parse().ok()?;
            Some(Self { addr, prefix })
        } else {
            let addr: IpAddr = s.parse().ok()?;
            let prefix = match addr {
                IpAddr::V4(_) => 32,
                IpAddr::V6(_) => 128,
            };
            Some(Self { addr, prefix })
        }
    }

    fn contains(&self, ip: IpAddr) -> bool {
        match (self.addr, ip) {
            (IpAddr::V4(n), IpAddr::V4(a)) => {
                let shift = 32u32.saturating_sub(self.prefix as u32);
                let mask = if shift >= 32 {
                    0
                } else {
                    u32::MAX << shift
                };
                (u32::from(n) & mask) == (u32::from(a) & mask)
            }
            (IpAddr::V6(n), IpAddr::V6(a)) => {
                let n = u128::from(n);
                let a = u128::from(a);
                let shift = 128u32.saturating_sub(self.prefix as u32);
                let mask = if shift >= 128 {
                    0
                } else {
                    u128::MAX << shift
                };
                (n & mask) == (a & mask)
            }
            _ => false,
        }
    }
}

impl PolicyEngine {
    pub fn from_config(cfg: &SocksCapConfig, rules: Option<&CompiledRules>) -> Self {
        let bypass_cidrs = cfg
            .bypass_cidrs
            .iter()
            .filter_map(|s| IpNetwork::parse(s))
            .collect();
        let apps = cfg
            .apps
            .iter()
            .map(|a| normalize_exe_path(&a.path))
            .filter(|p| !p.is_empty())
            .collect();
        Self {
            mode: cfg.mode,
            apps,
            rule_mode: cfg.rule_mode,
            user_rules: cfg.user_rules.clone(),
            bypass_cidrs,
            default_action: cfg.default_action,
            rules: rules.cloned(),
        }
    }

    /// Whether this process is in scope for capture (App mode).
    pub fn process_in_scope(&self, process_path: Option<&str>) -> bool {
        match self.mode {
            ScopeMode::Global => true,
            ScopeMode::Apps => {
                let Some(p) = process_path else {
                    return false;
                };
                let p = normalize_path(p);
                self.apps.iter().any(|a| paths_match(&p, a))
            }
        }
    }

    pub fn decide(&self, input: &PolicyInput) -> MatchTrace {
        // App scope is enforced at capture; still guard here for dry-run.
        if matches!(self.mode, ScopeMode::Apps)
            && !self.process_in_scope(input.process_path.as_deref())
        {
            return MatchTrace {
                decision: Decision::Direct,
                reason: "process not in app list".into(),
                matched_rule: None,
            };
        }

        let host = input
            .host
            .as_deref()
            .map(|h| h.trim_end_matches('.').to_ascii_lowercase())
            .filter(|h| !h.is_empty());

        // Bypass CIDR
        if let Some(ip) = input.ip {
            for net in &self.bypass_cidrs {
                if net.contains(ip) {
                    return MatchTrace {
                        decision: Decision::Direct,
                        reason: format!("bypass CIDR ({ip})"),
                        matched_rule: Some(format!("{}/{}", net.addr, net.prefix)),
                    };
                }
            }
        }

        // User rules — Block > Proxy > Direct by scanning in that action order
        // while preserving list order within the same action.
        if let Some(t) = self.match_user_rules(host.as_deref(), input.ip, UserRuleAction::Block) {
            return t;
        }
        if let Some(t) = self.match_user_rules(host.as_deref(), input.ip, UserRuleAction::Proxy) {
            return t;
        }
        if let Some(t) = self.match_user_rules(host.as_deref(), input.ip, UserRuleAction::Direct) {
            return t;
        }

        match self.rule_mode {
            RuleMode::Off => MatchTrace {
                decision: Decision::Direct,
                reason: "rule_mode=off".into(),
                matched_rule: None,
            },
            RuleMode::ProxyAll => MatchTrace {
                decision: Decision::Proxy,
                reason: "rule_mode=proxyAll".into(),
                matched_rule: None,
            },
            RuleMode::GfwList => {
                let Some(host) = host else {
                    return MatchTrace {
                        decision: self.default_action,
                        reason: "no hostname for gfwlist; default_action".into(),
                        matched_rule: None,
                    };
                };
                match self.rules.as_ref().map(|r| r.match_host(&host)) {
                    Some(RuleMatch::Proxy { rule }) => MatchTrace {
                        decision: Decision::Proxy,
                        reason: "gfwlist proxy".into(),
                        matched_rule: Some(rule),
                    },
                    Some(RuleMatch::Direct { rule }) => MatchTrace {
                        decision: Decision::Direct,
                        reason: "gfwlist whitelist".into(),
                        matched_rule: Some(rule),
                    },
                    Some(RuleMatch::Miss) | None => MatchTrace {
                        decision: self.default_action,
                        reason: if self.rules.is_none() {
                            "gfwlist not loaded; default_action".into()
                        } else {
                            "gfwlist miss; default_action".into()
                        },
                        matched_rule: None,
                    },
                }
            }
        }
    }

    fn match_user_rules(
        &self,
        host: Option<&str>,
        ip: Option<IpAddr>,
        action: UserRuleAction,
    ) -> Option<MatchTrace> {
        for r in &self.user_rules {
            if r.action != action {
                continue;
            }
            if user_rule_matches(r, host, ip) {
                let decision = match r.action {
                    UserRuleAction::Direct => Decision::Direct,
                    UserRuleAction::Proxy => Decision::Proxy,
                    UserRuleAction::Block => Decision::Block,
                };
                return Some(MatchTrace {
                    decision,
                    reason: format!("user rule ({:?})", r.action),
                    matched_rule: Some(r.pattern.clone()),
                });
            }
        }
        None
    }
}

fn user_rule_matches(r: &UserRule, host: Option<&str>, ip: Option<IpAddr>) -> bool {
    let pat = r.pattern.trim();
    if pat.is_empty() {
        return false;
    }
    if let Some(net) = IpNetwork::parse(pat) {
        if let Some(ip) = ip {
            return net.contains(ip);
        }
        // pattern is CIDR/IP but we only have a hostname — no match
        if host.is_none() {
            return false;
        }
    }
    if let Some(h) = host {
        let p = pat.trim_start_matches('.').to_ascii_lowercase();
        if h == p || h.ends_with(&format!(".{p}")) || h.contains(&p) {
            return true;
        }
    }
    false
}

fn normalize_path(p: &str) -> String {
    normalize_exe_path(p)
}

fn paths_match(process: &str, selector: &str) -> bool {
    paths_match_exe(process, selector)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sockscap::rules::CompiledRules;

    fn cfg_gfw() -> SocksCapConfig {
        let mut c = SocksCapConfig::default();
        c.upstream.host = "127.0.0.1".into();
        c.upstream.port = 1080;
        c
    }

    #[test]
    fn bypass_private() {
        let eng = PolicyEngine::from_config(&cfg_gfw(), None);
        let t = eng.decide(&PolicyInput {
            host: None,
            ip: Some("192.168.1.1".parse().unwrap()),
            port: 80,
            process_path: None,
            pid: None,
        });
        assert!(matches!(t.decision, Decision::Direct));
    }

    #[test]
    fn gfwlist_proxy_and_default() {
        let sample = "||google.com\n";
        let rules = CompiledRules::compile(sample, "t").unwrap();
        let eng = PolicyEngine::from_config(&cfg_gfw(), Some(&rules));
        let hit = eng.decide(&PolicyInput {
            host: Some("www.google.com".into()),
            ip: None,
            port: 443,
            process_path: None,
            pid: None,
        });
        assert!(matches!(hit.decision, Decision::Proxy));
        let miss = eng.decide(&PolicyInput {
            host: Some("example.cn".into()),
            ip: None,
            port: 443,
            process_path: None,
            pid: None,
        });
        assert!(matches!(miss.decision, Decision::Direct));
    }

    #[test]
    fn user_block_overrides_gfw() {
        let mut c = cfg_gfw();
        c.user_rules.push(UserRule {
            pattern: "google.com".into(),
            action: UserRuleAction::Block,
            comment: String::new(),
        });
        let rules = CompiledRules::compile("||google.com\n", "t").unwrap();
        let eng = PolicyEngine::from_config(&c, Some(&rules));
        let t = eng.decide(&PolicyInput {
            host: Some("google.com".into()),
            ip: None,
            port: 443,
            process_path: None,
            pid: None,
        });
        assert!(matches!(t.decision, Decision::Block));
    }
}
