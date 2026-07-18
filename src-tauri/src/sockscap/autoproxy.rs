//! AutoProxy / GFWList → domain-routing projection (plan §6.3).
//!
//! Sockscap is domain/connection-level routing, not a browser URL filter. This
//! module decodes the base64 GFWList blob and projects each AutoProxy line onto
//! a domain-suffix / domain-exact / IP / CIDR rule, or records it as
//! `unsupported` when a hostname cannot be extracted unambiguously — it never
//! silently mis-configures a rule (plan §6.3 step 5, §16.3-12).

use base64::Engine as _;

use super::matcher::{CompiledRuleSource, IpCidr};
use super::model::RuleDirection;
use super::SockscapError;

/// One projected rule ready to be inserted into a [`CompiledRuleSource`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectedRule {
    pub direction: RuleDirection,
    pub target: RuleTarget,
    /// Original AutoProxy line, kept for test-target explainability.
    pub original: String,
}

/// The matchable target a line projected to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuleTarget {
    DomainSuffix(String),
    DomainExact(String),
    Ip(IpCidr),
    Cidr(IpCidr),
}

/// A line that could not be projected, with a human reason (plan §16.3-12 —
/// surfaced with counts and examples, but does not block the update).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnsupportedRule {
    pub original: String,
    pub reason: String,
}

/// Aggregate parse statistics shown in the UI (plan §6.1, §6.2).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProjectionStats {
    pub total_lines: usize,
    pub comments: usize,
    pub blank: usize,
    pub domain_rules: usize,
    pub exception_rules: usize,
    pub ip_rules: usize,
    pub unsupported: usize,
}

/// The full result of projecting an AutoProxy document.
#[derive(Debug, Clone, Default)]
pub struct Projection {
    pub rules: Vec<ProjectedRule>,
    pub unsupported: Vec<UnsupportedRule>,
    pub stats: ProjectionStats,
}

impl Projection {
    /// Compile this projection into a matcher for the given source id.
    pub fn compile(&self, source_id: impl Into<String>) -> CompiledRuleSource {
        let mut src = CompiledRuleSource::new(source_id);
        for rule in &self.rules {
            match &rule.target {
                RuleTarget::DomainSuffix(d) => {
                    src.insert_domain(rule.direction, true, d, rule.original.clone())
                }
                RuleTarget::DomainExact(d) => {
                    src.insert_domain(rule.direction, false, d, rule.original.clone())
                }
                RuleTarget::Ip(c) | RuleTarget::Cidr(c) => {
                    src.insert_ip(rule.direction, *c, rule.original.clone())
                }
            }
        }
        src.finalize();
        src
    }
}

/// Decode a GFWList base64 blob into its AutoProxy text. Whitespace/newlines
/// between base64 chunks are stripped first (GFWList wraps at 64 columns).
/// A plain (already-decoded) AutoProxy document is returned as-is.
pub fn decode_base64(input: &str) -> Result<String, SockscapError> {
    let trimmed = input.trim_start();
    // A raw AutoProxy file starts with its header or a comment; don't try to
    // base64-decode it.
    if trimmed.starts_with("[AutoProxy") || trimmed.starts_with('!') {
        return Ok(input.to_string());
    }
    let compact: String = input.chars().filter(|c| !c.is_whitespace()).collect();
    if compact.is_empty() {
        return Err(SockscapError::Decode("empty input".into()));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(compact.as_bytes())
        .map_err(|e| SockscapError::Decode(format!("base64: {e}")))?;
    String::from_utf8(bytes).map_err(|e| SockscapError::Decode(format!("utf8: {e}")))
}

/// Normalize a hostname candidate to ASCII (IDNA), lowercase, no trailing dot.
/// Returns `None` if it cannot be a routable host (empty, contains an
/// unresolvable wildcard, or IDNA rejects it).
fn normalize_domain(raw: &str) -> Option<String> {
    let mut host = raw.trim().trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty() {
        return None;
    }
    // A leading `*.` is a suffix wildcard handled by the caller; strip it here.
    if let Some(rest) = host.strip_prefix("*.") {
        host = rest.to_string();
    }
    // Any remaining `*` cannot be projected to a domain unambiguously.
    if host.contains('*') {
        return None;
    }
    match idna::domain_to_ascii(&host) {
        Ok(ascii) if !ascii.is_empty() && ascii.contains(|c: char| c != '.') => Some(ascii),
        _ => None,
    }
}

/// The IP/CIDR candidate token: everything up to an AutoProxy `^` separator or
/// whitespace, but keeping `/` (CIDR prefix) and `:` (IPv6). Used to try an IP
/// parse *before* `extract_host` would strip the `/prefix`.
fn ip_token(s: &str) -> &str {
    let end = s
        .find(|c: char| c == '^' || c.is_whitespace())
        .unwrap_or(s.len());
    &s[..end]
}

/// Extract the host portion from an anchor/URL body, dropping any scheme, path,
/// port, or AutoProxy `^` separator.
fn extract_host(body: &str) -> &str {
    let mut s = body;
    // Strip a scheme if present (`http://`, `https://`).
    if let Some(idx) = s.find("://") {
        s = &s[idx + 3..];
    }
    // Drop userinfo.
    if let Some(idx) = s.find('@') {
        s = &s[idx + 1..];
    }
    // Cut at the first path / separator / port marker.
    let end = s
        .find(|c| c == '/' || c == '^' || c == ':' || c == '?')
        .unwrap_or(s.len());
    &s[..end]
}

/// Project a single AutoProxy line. Returns `Ok(Some(rule))` for a projected
/// rule, `Ok(None)` for comments/blanks (with `stats` updated by the caller),
/// or `Err(reason)` for an unsupported line.
fn project_line(raw: &str) -> Result<ProjectedRule, String> {
    let line = raw.trim();
    // Detect the `@@` exception prefix (⇒ DIRECT).
    let (direction, body) = match line.strip_prefix("@@") {
        Some(rest) => (RuleDirection::Direct, rest.trim()),
        None => (RuleDirection::Proxy, line),
    };
    if body.is_empty() {
        return Err("empty rule body".into());
    }

    // Regex rules (`/.../`) cannot yield an unambiguous host.
    if body.len() > 1 && body.starts_with('/') && body.ends_with('/') {
        return Err("regex rule (no unambiguous host)".into());
    }

    let make = |target: RuleTarget| ProjectedRule {
        direction,
        target,
        original: line.to_string(),
    };

    // `||host` — domain anchor: host and all subdomains. Try IP/CIDR first so a
    // `/prefix` isn't mistaken for a path and stripped.
    if let Some(rest) = body.strip_prefix("||") {
        if let Some(cidr) = IpCidr::parse(ip_token(rest)) {
            return Ok(make(ip_target(cidr)));
        }
        let host = extract_host(rest);
        return match normalize_domain(host) {
            Some(d) => Ok(make(RuleTarget::DomainSuffix(d))),
            None => Err(format!("cannot extract host from '{body}'")),
        };
    }

    // `|scheme://host/...` — start-anchored URL: exact host.
    if let Some(rest) = body.strip_prefix('|') {
        let rest = rest.trim_end_matches('|');
        let host = extract_host(rest);
        if let Some(cidr) = IpCidr::parse(host) {
            return Ok(make(ip_target(cidr)));
        }
        return match normalize_domain(host) {
            Some(d) => Ok(make(RuleTarget::DomainExact(d))),
            None => Err(format!("cannot extract host from '{body}'")),
        };
    }

    // `.domain` — domain fragment ⇒ suffix.
    if let Some(rest) = body.strip_prefix('.') {
        let host = extract_host(rest);
        return match normalize_domain(host) {
            Some(d) => Ok(make(RuleTarget::DomainSuffix(d))),
            None => Err(format!("cannot extract host from '{body}'")),
        };
    }

    // Bare IP / CIDR.
    if let Some(cidr) = IpCidr::parse(ip_token(body)) {
        return Ok(make(ip_target(cidr)));
    }

    // Bare host / keyword: project only when the leading token is a clean host.
    let host = extract_host(body);
    match normalize_domain(host) {
        Some(d) => Ok(make(RuleTarget::DomainSuffix(d))),
        None => Err(format!("keyword rule (no unambiguous host): '{body}'")),
    }
}

fn ip_target(cidr: IpCidr) -> RuleTarget {
    let full = matches!(cidr.addr, std::net::IpAddr::V4(_)) && cidr.prefix_len == 32
        || matches!(cidr.addr, std::net::IpAddr::V6(_)) && cidr.prefix_len == 128;
    if full {
        RuleTarget::Ip(cidr)
    } else {
        RuleTarget::Cidr(cidr)
    }
}

/// Parse a full AutoProxy document into a [`Projection`]. The input may be
/// either base64 (GFWList) or already-decoded AutoProxy text.
pub fn parse(input: &str) -> Result<Projection, SockscapError> {
    let text = decode_base64(input)?;
    Ok(parse_decoded(&text))
}

/// Parse already-decoded AutoProxy text.
pub fn parse_decoded(text: &str) -> Projection {
    let mut proj = Projection::default();
    for raw in text.lines() {
        proj.stats.total_lines += 1;
        let line = raw.trim();
        if line.is_empty() {
            proj.stats.blank += 1;
            continue;
        }
        // `[AutoProxy x.y]` header and `!` comments.
        if line.starts_with('!') || line.starts_with('[') {
            proj.stats.comments += 1;
            continue;
        }
        match project_line(line) {
            Ok(rule) => {
                match (&rule.direction, &rule.target) {
                    (RuleDirection::Direct, _) => proj.stats.exception_rules += 1,
                    (_, RuleTarget::Ip(_)) | (_, RuleTarget::Cidr(_)) => proj.stats.ip_rules += 1,
                    _ => proj.stats.domain_rules += 1,
                }
                proj.rules.push(rule);
            }
            Err(reason) => {
                proj.stats.unsupported += 1;
                proj.unsupported.push(UnsupportedRule {
                    original: line.to_string(),
                    reason,
                });
            }
        }
    }
    proj
}

#[cfg(test)]
mod tests {
    use super::*;

    fn only(text: &str) -> ProjectedRule {
        let p = parse_decoded(text);
        assert_eq!(p.rules.len(), 1, "expected exactly one rule for {text:?}");
        p.rules.into_iter().next().unwrap()
    }

    #[test]
    fn base64_roundtrip_decodes_gfwlist_blob() {
        let doc = "[AutoProxy 0.2.9]\n||example.com\n@@||cache.example.com\n";
        let encoded = base64::engine::general_purpose::STANDARD.encode(doc.as_bytes());
        let decoded = decode_base64(&encoded).unwrap();
        assert_eq!(decoded, doc);
        // Wrapped base64 (newlines every N chars) still decodes.
        let wrapped = encoded
            .as_bytes()
            .chunks(16)
            .map(|c| String::from_utf8_lossy(c))
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(decode_base64(&wrapped).unwrap(), doc);
    }

    #[test]
    fn raw_autoproxy_is_passed_through_not_base64_decoded() {
        let doc = "[AutoProxy 0.2.9]\n||example.com\n";
        assert_eq!(decode_base64(doc).unwrap(), doc);
    }

    #[test]
    fn domain_anchor_projects_to_suffix() {
        let r = only("||example.com");
        assert_eq!(r.direction, RuleDirection::Proxy);
        assert_eq!(r.target, RuleTarget::DomainSuffix("example.com".into()));
    }

    #[test]
    fn exception_projects_to_direct() {
        let r = only("@@||cache.example.com");
        assert_eq!(r.direction, RuleDirection::Direct);
        assert_eq!(r.target, RuleTarget::DomainSuffix("cache.example.com".into()));
    }

    #[test]
    fn start_anchored_url_projects_to_exact_and_drops_path() {
        let r = only("|http://example.com/path?q=1");
        assert_eq!(r.target, RuleTarget::DomainExact("example.com".into()));
    }

    #[test]
    fn leading_dot_projects_to_suffix() {
        let r = only(".ads.example.net");
        assert_eq!(r.target, RuleTarget::DomainSuffix("ads.example.net".into()));
    }

    #[test]
    fn bare_ip_and_cidr_project_to_ip_rules() {
        assert!(matches!(only("1.2.3.4").target, RuleTarget::Ip(_)));
        assert!(matches!(only("||10.0.0.0/8").target, RuleTarget::Cidr(_)));
    }

    #[test]
    fn regex_and_wildcard_keyword_are_unsupported() {
        let p = parse_decoded("/ads?/banner/\n||a*b.example.com");
        assert_eq!(p.rules.len(), 0);
        assert_eq!(p.unsupported.len(), 2);
    }

    #[test]
    fn idna_domain_is_punycoded() {
        // 例子.测试 → xn--... ; projection must ASCII-normalize like a browser.
        let r = only("||例子.测试");
        match r.target {
            RuleTarget::DomainSuffix(d) => assert!(d.starts_with("xn--"), "got {d}"),
            other => panic!("unexpected target {other:?}"),
        }
    }

    #[test]
    fn comments_and_blanks_counted_not_projected() {
        let p = parse_decoded("[AutoProxy 0.2.9]\n! a comment\n\n||example.com\n");
        assert_eq!(p.stats.comments, 2);
        assert_eq!(p.stats.blank, 1);
        assert_eq!(p.stats.domain_rules, 1);
        assert_eq!(p.rules.len(), 1);
    }

    #[test]
    fn compile_applies_exception_priority() {
        let p = parse_decoded("||google.com\n@@||plus.google.com");
        let src = p.compile("gfwlist-official");
        assert_eq!(src.lookup_domain("mail.google.com").unwrap().direction, RuleDirection::Proxy);
        assert_eq!(src.lookup_domain("plus.google.com").unwrap().direction, RuleDirection::Direct);
    }
}
