//! AutoProxy / GFWList rule projection onto domain/IP matchers.
//!
//! Sockscap is connection-level routing, not a browser URL filter. Only rules
//! that unambiguously yield a hostname or IP are compiled; the rest are reported
//! as `unsupported` (design plan §6.3 / §16.3).

use serde::{Deserialize, Serialize};
use std::net::IpAddr;
use url::{Host, Url};

use crate::sockscap::types::{CustomRuleDraft, CustomRuleKind};

/// One compiled rule after projection from AutoProxy syntax.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompiledRule {
    pub action: super::super::types::RouteAction,
    pub kind: RuleKind,
    pub pattern: String,
    /// Original AutoProxy line (for test_target explainability).
    pub original: String,
    pub source_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuleKind {
    /// Match domain and all subdomains (`||example.com` → suffix).
    DomainSuffix,
    /// Exact host match.
    DomainExact,
    /// IP or CIDR.
    IpCidr,
    /// Keyword substring in hostname (rare after projection).
    DomainKeyword,
}

/// A rule line that could not be projected safely.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnsupportedRule {
    pub original: String,
    pub reason: String,
}

/// Result of parsing a full AutoProxy / domain-list document.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParseReport {
    pub proxy_rules: Vec<CompiledRule>,
    pub direct_rules: Vec<CompiledRule>,
    pub unsupported: Vec<UnsupportedRule>,
    pub ignored_comments: usize,
    pub total_lines: usize,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomRuleCompileReport {
    pub rules: Vec<CompiledRule>,
    pub unsupported: Vec<UnsupportedRule>,
}

/// Validate and compile ordered user overrides. Invalid entries are reported,
/// never silently skipped, and valid entries retain their original order.
pub fn compile_custom_rules(
    profile_id: &str,
    rules: &[CustomRuleDraft],
) -> CustomRuleCompileReport {
    let mut report = CustomRuleCompileReport::default();
    for rule in rules.iter().filter(|rule| rule.enabled) {
        let compiled = match rule.kind {
            CustomRuleKind::DomainSuffix => normalize_hostname(&rule.pattern)
                .map(|pattern| (RuleKind::DomainSuffix, pattern))
                .ok_or_else(|| "invalid domain suffix".to_string()),
            CustomRuleKind::DomainExact => normalize_hostname(&rule.pattern)
                .map(|pattern| (RuleKind::DomainExact, pattern))
                .ok_or_else(|| "invalid exact domain".to_string()),
            CustomRuleKind::DomainKeyword => {
                let pattern = rule.pattern.trim().to_ascii_lowercase();
                if pattern.is_empty()
                    || !pattern.is_ascii()
                    || pattern
                        .chars()
                        .any(|character| character.is_whitespace() || "/?#*".contains(character))
                {
                    Err("domain keyword must be a non-empty ASCII hostname fragment".into())
                } else {
                    Ok((RuleKind::DomainKeyword, pattern))
                }
            }
            CustomRuleKind::IpCidr => normalize_ip_or_cidr(&rule.pattern)
                .map(|pattern| (RuleKind::IpCidr, pattern))
                .ok_or_else(|| "invalid IP or CIDR prefix".to_string()),
        };
        match compiled {
            Ok((kind, pattern)) => report.rules.push(CompiledRule {
                action: rule.action,
                kind,
                pattern,
                original: rule.pattern.clone(),
                source_id: format!("user-overrides:{profile_id}"),
            }),
            Err(reason) => report.unsupported.push(UnsupportedRule {
                original: rule.pattern.clone(),
                reason,
            }),
        }
    }
    report
}

/// Parse AutoProxy 0.2.x text (already Base64-decoded) or a plain domain list.
pub fn parse_rule_document(source_id: &str, text: &str) -> ParseReport {
    let mut report = ParseReport::default();
    for raw_line in text.lines() {
        report.total_lines += 1;
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        // AutoProxy header / comments
        if line.starts_with('!') || line.starts_with('[') {
            report.ignored_comments += 1;
            continue;
        }
        // IP / CIDR lines (before plain-domain heuristic).
        if let Ok(ip) = line.parse::<IpAddr>() {
            report.proxy_rules.push(CompiledRule {
                action: super::super::types::RouteAction::Proxy,
                kind: RuleKind::IpCidr,
                pattern: ip.to_string(),
                original: raw_line.to_string(),
                source_id: source_id.to_string(),
            });
            continue;
        }
        if looks_like_cidr(line) {
            report.proxy_rules.push(CompiledRule {
                action: super::super::types::RouteAction::Proxy,
                kind: RuleKind::IpCidr,
                pattern: line.to_string(),
                original: raw_line.to_string(),
                source_id: source_id.to_string(),
            });
            continue;
        }

        // Plain domain list: lines without AutoProxy operators
        if looks_like_plain_domain_list_line(line) {
            if let Some(host) = normalize_hostname(line) {
                report.proxy_rules.push(CompiledRule {
                    action: super::super::types::RouteAction::Proxy,
                    kind: RuleKind::DomainSuffix,
                    pattern: host,
                    original: raw_line.to_string(),
                    source_id: source_id.to_string(),
                });
            } else {
                report.unsupported.push(UnsupportedRule {
                    original: raw_line.to_string(),
                    reason: "plain list line is not a valid hostname".into(),
                });
            }
            continue;
        }

        let (is_exception, body) = if let Some(rest) = line.strip_prefix("@@") {
            (true, rest)
        } else {
            (false, line)
        };

        match project_autoproxy_body(body) {
            Ok(Some((kind, pattern))) => {
                let rule = CompiledRule {
                    action: if is_exception {
                        super::super::types::RouteAction::Direct
                    } else {
                        super::super::types::RouteAction::Proxy
                    },
                    kind,
                    pattern,
                    original: raw_line.to_string(),
                    source_id: source_id.to_string(),
                };
                if is_exception {
                    report.direct_rules.push(rule);
                } else {
                    report.proxy_rules.push(rule);
                }
            }
            Ok(None) => {
                report.ignored_comments += 1;
            }
            Err(reason) => {
                report.unsupported.push(UnsupportedRule {
                    original: raw_line.to_string(),
                    reason,
                });
            }
        }
    }
    report
}

fn looks_like_plain_domain_list_line(line: &str) -> bool {
    // No AutoProxy operators and no URL scheme → treat as domain list entry.
    !line.contains("://")
        && !line.starts_with("||")
        && !line.starts_with('|')
        && !line.starts_with('/')
        && !line.contains('*')
        && !line.contains('^')
        && !line.starts_with('@')
        && !line.contains(['/', '?', '#', ':'])
        && !line.chars().any(char::is_whitespace)
}

/// Project one AutoProxy body (without leading @@) into a matcher pattern.
fn project_autoproxy_body(body: &str) -> Result<Option<(RuleKind, String)>, String> {
    let body = body.trim();
    if body.is_empty() {
        return Ok(None);
    }

    // Regex rules: /.../ — only accept if we can extract a literal host (rare).
    if body.starts_with('/') && body.ends_with('/') && body.len() > 2 {
        return Err("regular expression rules are not projected to domain matchers".into());
    }

    // Domain anchor: ||example.com^ or ||example.com
    if let Some(rest) = body.strip_prefix("||") {
        let host_part = rest.split(['^', '/', '?', '#']).next().unwrap_or(rest);
        let host_part = host_part.strip_prefix("*.").unwrap_or(host_part);
        if host_part.contains('*') {
            return Err("wildcard domain anchors without unambiguous host are unsupported".into());
        }
        if let Some((host, port)) = host_part.rsplit_once(':') {
            if !host.contains(':') && port.parse::<u16>().is_ok() {
                return normalize_hostname(host)
                    .map(|host| Some((RuleKind::DomainSuffix, host)))
                    .ok_or_else(|| "domain anchor is not a valid hostname".to_string());
            }
        }
        if let Ok(ip) = host_part.trim_matches(['[', ']']).parse::<IpAddr>() {
            return Ok(Some((RuleKind::IpCidr, ip.to_string())));
        }
        let host = normalize_hostname(host_part)
            .ok_or_else(|| "domain anchor is not a valid hostname".to_string())?;
        return Ok(Some((RuleKind::DomainSuffix, host)));
    }

    // Left-anchor URL: |https://host/path or |http://host
    if let Some(rest) = body.strip_prefix('|') {
        if let Some(host) = extract_host_from_url_or_host(rest) {
            return Ok(Some(rule_for_exact_host(host)));
        }
        return Err("left-anchored rule has no unambiguous hostname".into());
    }

    // Full URL without left anchor
    if body.contains("://") {
        if let Some(host) = extract_host_from_safe_wildcard_url(body) {
            return Ok(Some((RuleKind::DomainSuffix, host)));
        }
        if let Some(host) = extract_host_from_url_or_host(body) {
            return Ok(Some(rule_for_exact_host(host)));
        }
        return Err("URL rule has no unambiguous hostname".into());
    }

    // Pure IP / CIDR
    if let Ok(ip) = body.parse::<IpAddr>() {
        return Ok(Some((RuleKind::IpCidr, ip.to_string())));
    }
    if looks_like_cidr(body) {
        return Ok(Some((RuleKind::IpCidr, body.to_string())));
    }

    // Keyword rule (AutoProxy bare token): treat as domain keyword only when it
    // looks like a hostname fragment without path characters.
    if body.contains('/')
        || body.contains('?')
        || body.contains('=')
        || body.chars().any(char::is_whitespace)
    {
        return Err("path/query keyword rules are not projected".into());
    }
    if body.contains('*') {
        return Err("wildcard keyword rules are unsupported".into());
    }
    let keyword = body.trim_matches(|c| c == '.' || c == '^');
    if keyword.is_empty() {
        return Ok(None);
    }
    // Prefer suffix when the token looks fully qualified.
    if keyword.contains('.') {
        if let Some(host) = normalize_hostname(keyword) {
            return Ok(Some((RuleKind::DomainSuffix, host)));
        }
    }
    Ok(Some((
        RuleKind::DomainKeyword,
        keyword.to_ascii_lowercase(),
    )))
}

fn looks_like_cidr(s: &str) -> bool {
    let mut parts = s.splitn(2, '/');
    let ip = parts.next().unwrap_or("");
    let prefix = parts.next().unwrap_or("");
    let Ok(ip) = ip.parse::<IpAddr>() else {
        return false;
    };
    let Ok(prefix) = prefix.parse::<u8>() else {
        return false;
    };
    prefix
        <= match ip {
            IpAddr::V4(_) => 32,
            IpAddr::V6(_) => 128,
        }
}

fn normalize_ip_or_cidr(input: &str) -> Option<String> {
    let input = input.trim();
    if let Ok(ip) = input.parse::<IpAddr>() {
        return Some(ip.to_string());
    }
    let (ip, prefix) = input.split_once('/')?;
    let ip = ip.parse::<IpAddr>().ok()?;
    let prefix = prefix.parse::<u8>().ok()?;
    let max_prefix = match ip {
        IpAddr::V4(_) => 32,
        IpAddr::V6(_) => 128,
    };
    (prefix <= max_prefix).then(|| format!("{ip}/{prefix}"))
}

fn extract_host_from_url_or_host(s: &str) -> Option<String> {
    let s = s.trim();
    let parsed = if s.contains("://") {
        Url::parse(s).ok()?
    } else {
        Url::parse(&format!("http://{s}")).ok()?
    };
    match parsed.host()? {
        Host::Domain(domain) => normalize_hostname(domain),
        Host::Ipv4(ip) => Some(ip.to_string()),
        Host::Ipv6(ip) => Some(ip.to_string()),
    }
}

fn rule_for_exact_host(host: String) -> (RuleKind, String) {
    if host.parse::<IpAddr>().is_ok() {
        (RuleKind::IpCidr, host)
    } else {
        (RuleKind::DomainExact, host)
    }
}

/// Extract the one unambiguous hostname from patterns such as
/// `*://*.example.com/*`. Any wildcard outside a leading `*.` host is rejected.
fn extract_host_from_safe_wildcard_url(input: &str) -> Option<String> {
    let (_, remainder) = input.split_once("://")?;
    let authority = remainder.split(['/', '?', '#']).next()?;
    let authority = authority.rsplit('@').next()?;
    let host = authority.strip_prefix("*.")?;
    if host.contains('*') || host.contains(':') {
        return None;
    }
    normalize_hostname(host)
}

/// Lowercase, strip a trailing root dot, and convert Unicode labels to their
/// canonical IDNA ASCII representation. IP literals are handled by IP rules.
pub fn normalize_hostname(input: &str) -> Option<String> {
    let input = input.trim().trim_end_matches('.');
    if input.is_empty() || input.contains('%') {
        return None;
    }
    let Host::Domain(domain) = Host::parse(input).ok()? else {
        return None;
    };
    let domain = domain.to_ascii_lowercase();
    if domain.len() > 253 || domain.starts_with('.') || domain.contains("..") {
        return None;
    }
    for label in domain.split('.') {
        if label.is_empty() || label.len() > 63 {
            return None;
        }
        if label.starts_with('-') || label.ends_with('-') {
            return None;
        }
        if !label
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            return None;
        }
    }
    Some(domain)
}

/// Decode a GFWList-style Base64 document into UTF-8 text.
pub fn decode_gfwlist_base64(input: &str) -> Result<String, String> {
    use base64::Engine;
    // GFWList files often wrap Base64 across lines.
    let compact: String = input.chars().filter(|c| !c.is_whitespace()).collect();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(compact.as_bytes())
        .map_err(|e| format!("gfwlist base64 decode failed: {e}"))?;
    String::from_utf8(bytes).map_err(|e| format!("gfwlist is not valid UTF-8: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sockscap::types::RouteAction;

    const SAMPLE: &str = r#"[AutoProxy 0.2.9]
! Comment line
||google.com
||github.com^
@@||github.com
|https://example.org/path
@@||internal.example.com
127.0.0.1
10.0.0.0/8
/useless-regex/
||wild*.example.com
http://bare-url.test/foo
"#;

    #[test]
    fn projects_domain_suffix_and_exceptions() {
        let report = parse_rule_document("test", SAMPLE);
        assert!(
            report
                .proxy_rules
                .iter()
                .any(|r| r.pattern == "google.com" && r.kind == RuleKind::DomainSuffix)
        );
        assert!(
            report
                .direct_rules
                .iter()
                .any(|r| r.pattern == "github.com" && r.action == RouteAction::Direct)
        );
        assert!(
            report
                .unsupported
                .iter()
                .any(|u| u.original.contains("useless-regex"))
        );
        assert!(
            report
                .unsupported
                .iter()
                .any(|u| u.original.contains("wild*"))
        );
    }

    #[test]
    fn left_anchor_https_extracts_host() {
        let report = parse_rule_document("test", "|https://example.org/path\n");
        assert_eq!(report.proxy_rules.len(), 1);
        assert_eq!(report.proxy_rules[0].pattern, "example.org");
        assert_eq!(report.proxy_rules[0].kind, RuleKind::DomainExact);
    }

    #[test]
    fn plain_domain_list() {
        let report = parse_rule_document("local", "foo.example\nbar.example\n");
        assert_eq!(report.proxy_rules.len(), 2);
        assert_eq!(report.proxy_rules[0].kind, RuleKind::DomainSuffix);
    }

    #[test]
    fn decode_base64_roundtrip() {
        let text = "||example.com\n";
        let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, text);
        let decoded = decode_gfwlist_base64(&encoded).unwrap();
        assert_eq!(decoded, text);
    }

    #[test]
    fn normalize_hostname_strips_dot_and_case() {
        assert_eq!(
            normalize_hostname("ExAmPle.COM."),
            Some("example.com".into())
        );
        assert!(normalize_hostname("").is_none());
        assert!(normalize_hostname("bad..com").is_none());
    }

    #[test]
    fn normalize_hostname_converts_idna_and_rejects_dns_invalid_labels() {
        assert_eq!(
            normalize_hostname("Bücher.Example"),
            Some("xn--bcher-kva.example".into())
        );
        assert!(normalize_hostname("bad_name.example").is_none());
        assert!(normalize_hostname("-bad.example").is_none());
    }

    #[test]
    fn validates_cidr_prefix_and_projects_safe_wildcard_urls() {
        let report = parse_rule_document("test", "10.0.0.0/33\n*://*.example.com/*\n");
        assert_eq!(report.proxy_rules.len(), 1);
        assert_eq!(report.proxy_rules[0].pattern, "example.com");
        assert_eq!(report.proxy_rules[0].kind, RuleKind::DomainSuffix);
        assert_eq!(report.unsupported.len(), 1);
    }

    #[test]
    fn custom_override_compilation_preserves_order_and_block_action() {
        use crate::sockscap::types::{CustomRuleDraft, CustomRuleKind, RouteAction};

        let report = compile_custom_rules(
            "profile",
            &[
                CustomRuleDraft {
                    id: "first".into(),
                    enabled: true,
                    action: RouteAction::Direct,
                    kind: CustomRuleKind::DomainSuffix,
                    pattern: "Bücher.Example".into(),
                },
                CustomRuleDraft {
                    id: "second".into(),
                    enabled: true,
                    action: RouteAction::Block,
                    kind: CustomRuleKind::IpCidr,
                    pattern: "10.0.0.0/8".into(),
                },
            ],
        );
        assert!(report.unsupported.is_empty());
        assert_eq!(report.rules[0].pattern, "xn--bcher-kva.example");
        assert_eq!(report.rules[1].action, RouteAction::Block);
    }
}
