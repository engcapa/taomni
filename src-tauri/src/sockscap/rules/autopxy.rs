//! AutoProxy / gfwlist line parser.
//!
//! Supported subset (first phase):
//! - comments: `!` or `[`
//! - whitelist: `@@` prefix → Direct
//! - domain anchor: `||example.com` → Proxy on host or subdomain
//! - left anchor: `|http://…` / `|https://…` → extract host → Proxy
//! - plain keyword / host fragment containing `.` → contains / suffix match
//! - `/regex/` — compiled when cheap; skipped when too complex

use regex::Regex;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParsedRule {
    /// Host or subdomain match (`||example.com` or extracted host).
    DomainSuffix { host: String, direct: bool },
    /// Substring match against host (keyword rules).
    Contains { needle: String, direct: bool },
    /// Full regex against host (limited).
    Regex { pattern: String, direct: bool },
    /// Skip (comment, empty, unsupported).
    Skip { reason: String },
}

/// Parse a single AutoProxy line (already decoded from gfwlist base64).
pub fn parse_autopxy_line(raw: &str) -> ParsedRule {
    let line = raw.trim();
    if line.is_empty() || line.starts_with('!') || line.starts_with('[') {
        return ParsedRule::Skip {
            reason: "comment".into(),
        };
    }

    let (direct, body) = if let Some(rest) = line.strip_prefix("@@") {
        (true, rest.trim())
    } else {
        (false, line)
    };

    if body.is_empty() {
        return ParsedRule::Skip {
            reason: "empty".into(),
        };
    }

    // Regex form /.../
    if body.starts_with('/') && body.ends_with('/') && body.len() > 2 {
        let pat = &body[1..body.len() - 1];
        if pat.len() > 256 || pat.matches('*').count() > 8 {
            return ParsedRule::Skip {
                reason: "regex too complex".into(),
            };
        }
        // Reject catastrophic patterns roughly.
        if pat.contains(".*.*") || pat.contains(".+") && pat.len() > 64 {
            return ParsedRule::Skip {
                reason: "regex rejected".into(),
            };
        }
        if Regex::new(pat).is_err() {
            return ParsedRule::Skip {
                reason: "invalid regex".into(),
            };
        }
        return ParsedRule::Regex {
            pattern: pat.to_string(),
            direct,
        };
    }

    // ||domain
    if let Some(rest) = body.strip_prefix("||") {
        if let Some(host) = normalize_host_pattern(rest) {
            return ParsedRule::DomainSuffix { host, direct };
        }
        return ParsedRule::Skip {
            reason: "bad || host".into(),
        };
    }

    // |http://... or |https://...
    if let Some(rest) = body.strip_prefix('|') {
        if let Some(host) = host_from_urlish(rest) {
            return ParsedRule::DomainSuffix { host, direct };
        }
        // Fall through to contains for other left-anchored paths.
    }

    // Strip scheme if present without leading |
    if let Some(host) = host_from_urlish(body) {
        // If the body looks like a pure host/domain, treat as suffix.
        if !body.contains('/') && !body.contains('*') {
            return ParsedRule::DomainSuffix { host, direct };
        }
        return ParsedRule::DomainSuffix { host, direct };
    }

    // Keyword / contains — gfwlist uses bare strings like `google` or `.example.com`
    let needle = body
        .trim_start_matches('*')
        .trim_end_matches('*')
        .to_ascii_lowercase();
    if needle.is_empty() {
        return ParsedRule::Skip {
            reason: "empty needle".into(),
        };
    }
    // Prefer suffix when it looks like a domain (contains a dot, no path junk).
    if needle.contains('.')
        && !needle.contains('/')
        && !needle.contains('?')
        && !needle.contains('=')
    {
        let host = needle.trim_start_matches('.').to_string();
        if !host.is_empty() {
            return ParsedRule::DomainSuffix { host, direct };
        }
    }
    ParsedRule::Contains { needle, direct }
}

fn host_from_urlish(s: &str) -> Option<String> {
    let s = s.trim();
    let without_scheme = s
        .strip_prefix("https://")
        .or_else(|| s.strip_prefix("http://"))
        .unwrap_or(s);
    let host_port = without_scheme.split('/').next().unwrap_or("");
    let host = host_port.split(':').next().unwrap_or("").trim();
    normalize_host_pattern(host)
}

fn normalize_host_pattern(s: &str) -> Option<String> {
    let s = s
        .trim()
        .trim_start_matches('.')
        .trim_end_matches('*')
        .trim_end_matches('/')
        .to_ascii_lowercase();
    if s.is_empty() || s.contains(' ') {
        return None;
    }
    // Drop path leftovers
    let s = s.split('/').next()?.to_string();
    if s.is_empty() {
        return None;
    }
    Some(s)
}

/// Does `host` match a domain-suffix rule `suffix`?
pub fn host_matches_suffix(host: &str, suffix: &str) -> bool {
    let h = host.trim_end_matches('.').to_ascii_lowercase();
    let s = suffix.trim_end_matches('.').to_ascii_lowercase();
    if h == s {
        return true;
    }
    h.ends_with(&format!(".{s}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn domain_anchor() {
        match parse_autopxy_line("||google.com") {
            ParsedRule::DomainSuffix { host, direct } => {
                assert_eq!(host, "google.com");
                assert!(!direct);
            }
            other => panic!("unexpected {other:?}"),
        }
        assert!(host_matches_suffix("www.google.com", "google.com"));
        assert!(host_matches_suffix("google.com", "google.com"));
        assert!(!host_matches_suffix("notgoogle.com", "google.com"));
    }

    #[test]
    fn whitelist() {
        match parse_autopxy_line("@@||example.com") {
            ParsedRule::DomainSuffix { host, direct } => {
                assert_eq!(host, "example.com");
                assert!(direct);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn comment_skip() {
        assert!(matches!(
            parse_autopxy_line("! foo"),
            ParsedRule::Skip { .. }
        ));
        assert!(matches!(
            parse_autopxy_line("[AutoProxy"),
            ParsedRule::Skip { .. }
        ));
    }

    #[test]
    fn url_left_anchor() {
        match parse_autopxy_line("|https://cdn.example.org/path") {
            ParsedRule::DomainSuffix { host, direct } => {
                assert_eq!(host, "cdn.example.org");
                assert!(!direct);
            }
            other => panic!("unexpected {other:?}"),
        }
    }
}
