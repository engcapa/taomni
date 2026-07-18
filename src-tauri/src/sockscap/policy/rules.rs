//! AutoProxy / GFWList rule projection onto domain/IP matchers.
//!
//! Sockscap is connection-level routing, not a browser URL filter. Only rules
//! that unambiguously yield a hostname or IP are compiled; the rest are reported
//! as `unsupported` (design plan §6.3 / §16.3).

use serde::{Deserialize, Serialize};
use std::net::IpAddr;

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

        match project_autopproxy_body(body) {
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
}

/// Project one AutoProxy body (without leading @@) into a matcher pattern.
fn project_autopproxy_body(body: &str) -> Result<Option<(RuleKind, String)>, String> {
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
        // Strip trailing wildcards like example.*
        let host_part = host_part.trim_end_matches('*').trim_end_matches('.');
        if host_part.contains('*') {
            return Err("wildcard domain anchors without unambiguous host are unsupported".into());
        }
        if let Ok(ip) = host_part.parse::<IpAddr>() {
            return Ok(Some((RuleKind::IpCidr, ip.to_string())));
        }
        let host = normalize_hostname(host_part)
            .ok_or_else(|| "domain anchor is not a valid hostname".to_string())?;
        return Ok(Some((RuleKind::DomainSuffix, host)));
    }

    // Left-anchor URL: |https://host/path or |http://host
    if let Some(rest) = body.strip_prefix('|') {
        if let Some(host) = extract_host_from_url_or_host(rest) {
            return Ok(Some((RuleKind::DomainExact, host)));
        }
        return Err("left-anchored rule has no unambiguous hostname".into());
    }

    // Full URL without left anchor
    if body.contains("://") {
        if let Some(host) = extract_host_from_url_or_host(body) {
            return Ok(Some((RuleKind::DomainExact, host)));
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
    if body.contains('/') || body.contains('?') || body.contains('=') {
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
    ip.parse::<IpAddr>().is_ok() && prefix.parse::<u8>().is_ok()
}

fn extract_host_from_url_or_host(s: &str) -> Option<String> {
    let s = s.trim();
    // Strip scheme
    let after_scheme = if let Some(idx) = s.find("://") {
        &s[idx + 3..]
    } else {
        s
    };
    // Strip userinfo
    let after_user = if let Some(idx) = after_scheme.rfind('@') {
        &after_scheme[idx + 1..]
    } else {
        after_scheme
    };
    // Host ends at / ? # or :
    let host_port = after_user.split(['/', '?', '#']).next().unwrap_or(after_user);
    // Handle [ipv6]:port
    let host = if host_port.starts_with('[') {
        let end = host_port.find(']')?;
        &host_port[1..end]
    } else {
        host_port.split(':').next().unwrap_or(host_port)
    };
    if host.parse::<IpAddr>().is_ok() {
        return Some(host.to_string());
    }
    normalize_hostname(host)
}

/// Lowercase, strip trailing dots, basic IDNA-ish acceptance (ASCII + punycode).
/// Full unicode IDNA conversion can be layered later with an idna crate; for
/// Phase 1 we accept LDH labels and xn-- punycode, reject spaces/controls.
pub fn normalize_hostname(input: &str) -> Option<String> {
    let s = input.trim().trim_end_matches('.').to_ascii_lowercase();
    if s.is_empty() || s.len() > 253 {
        return None;
    }
    if s.starts_with('.') || s.contains("..") {
        return None;
    }
    for label in s.split('.') {
        if label.is_empty() || label.len() > 63 {
            return None;
        }
        if label.starts_with('-') || label.ends_with('-') {
            return None;
        }
        if !label
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            // Allow underscore for some internal names; reject other unicode for now.
            return None;
        }
    }
    Some(s)
}

/// Decode a GFWList-style Base64 document into UTF-8 text.
pub fn decode_gfwlist_base64(input: &str) -> Result<String, String> {
    use base64::Engine;
    // GFWList files often wrap Base64 across lines.
    let compact: String = input
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
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
}
