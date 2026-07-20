//! Compile and match GFWList / AutoProxy rule sets.

use super::autopxy::{host_matches_suffix, parse_autopxy_line, ParsedRule};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GfwListMeta {
    pub source: String,
    pub rule_count: usize,
    pub skipped: usize,
    pub last_refresh: Option<String>,
    #[serde(default)]
    pub etag: Option<String>,
}

impl GfwListMeta {
    pub fn load(path: &std::path::Path) -> Option<Self> {
        let s = std::fs::read_to_string(path).ok()?;
        serde_json::from_str(&s).ok()
    }

    pub fn save(&self, path: &std::path::Path) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let j = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        std::fs::write(path, j).map_err(|e| e.to_string())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuleMatch {
    /// Host matched a proxy rule in GFWList.
    Proxy { rule: String },
    /// Host matched a whitelist (@@) rule.
    Direct { rule: String },
    /// No GFWList hit.
    Miss,
}

/// Immutable compiled snapshot used on the hot path.
#[derive(Debug, Clone)]
pub struct CompiledRules {
    pub meta: GfwListMeta,
    /// Domain suffixes that should be proxied.
    proxy_suffixes: HashSet<String>,
    /// Domain suffixes that must stay direct (@@).
    direct_suffixes: HashSet<String>,
    proxy_contains: Vec<String>,
    direct_contains: Vec<String>,
    proxy_regex: Vec<(String, Regex)>,
    direct_regex: Vec<(String, Regex)>,
}

impl CompiledRules {
    /// Decode gfwlist base64 payload (or plain AutoProxy text) and compile.
    pub fn compile(raw: &str, source: &str) -> Result<Self, String> {
        let text = decode_gfwlist_payload(raw)?;
        let mut proxy_suffixes = HashSet::new();
        let mut direct_suffixes = HashSet::new();
        let mut proxy_contains = Vec::new();
        let mut direct_contains = Vec::new();
        let mut proxy_regex = Vec::new();
        let mut direct_regex = Vec::new();
        let mut skipped = 0usize;
        let mut rule_count = 0usize;

        for line in text.lines() {
            match parse_autopxy_line(line) {
                ParsedRule::Skip { .. } => skipped += 1,
                ParsedRule::DomainSuffix { host, direct } => {
                    rule_count += 1;
                    if direct {
                        direct_suffixes.insert(host);
                    } else {
                        proxy_suffixes.insert(host);
                    }
                }
                ParsedRule::Contains { needle, direct } => {
                    rule_count += 1;
                    if direct {
                        direct_contains.push(needle);
                    } else {
                        proxy_contains.push(needle);
                    }
                }
                ParsedRule::Regex { pattern, direct } => match Regex::new(&pattern) {
                    Ok(re) => {
                        rule_count += 1;
                        if direct {
                            direct_regex.push((pattern, re));
                        } else {
                            proxy_regex.push((pattern, re));
                        }
                    }
                    Err(_) => skipped += 1,
                },
            }
        }

        let last_refresh = chrono_like_now();
        Ok(Self {
            meta: GfwListMeta {
                source: source.to_string(),
                rule_count,
                skipped,
                last_refresh: Some(last_refresh),
                etag: None,
            },
            proxy_suffixes,
            direct_suffixes,
            proxy_contains,
            direct_contains,
            proxy_regex,
            direct_regex,
        })
    }

    pub fn match_host(&self, host: &str) -> RuleMatch {
        let h = host.trim_end_matches('.').to_ascii_lowercase();
        if h.is_empty() {
            return RuleMatch::Miss;
        }

        // Whitelist first (@@ takes priority within GFWList).
        for s in &self.direct_suffixes {
            if host_matches_suffix(&h, s) {
                return RuleMatch::Direct {
                    rule: format!("@@||{s}"),
                };
            }
        }
        for n in &self.direct_contains {
            if h.contains(n) {
                return RuleMatch::Direct {
                    rule: format!("@@*{n}*"),
                };
            }
        }
        for (pat, re) in &self.direct_regex {
            if re.is_match(&h) {
                return RuleMatch::Direct {
                    rule: format!("@@/{pat}/"),
                };
            }
        }

        for s in &self.proxy_suffixes {
            if host_matches_suffix(&h, s) {
                return RuleMatch::Proxy {
                    rule: format!("||{s}"),
                };
            }
        }
        for n in &self.proxy_contains {
            if h.contains(n) {
                return RuleMatch::Proxy {
                    rule: format!("*{n}*"),
                };
            }
        }
        for (pat, re) in &self.proxy_regex {
            if re.is_match(&h) {
                return RuleMatch::Proxy {
                    rule: format!("/{pat}/"),
                };
            }
        }
        RuleMatch::Miss
    }
}

/// GFWList files are typically base64 of the AutoProxy text. Accept either.
fn decode_gfwlist_payload(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("empty gfwlist payload".into());
    }
    // Heuristic: if it looks like AutoProxy already, use as-is.
    if trimmed.lines().any(|l| {
        let l = l.trim();
        l.starts_with("||") || l.starts_with("@@") || l.starts_with('!') || l.starts_with("[Auto")
    }) {
        return Ok(trimmed.to_string());
    }
    // Otherwise treat as base64 (possibly multi-line).
    let compact: String = trimmed.chars().filter(|c| !c.is_whitespace()).collect();
    let bytes = B64
        .decode(compact.as_bytes())
        .map_err(|e| format!("gfwlist base64 decode: {e}"))?;
    String::from_utf8(bytes).map_err(|e| format!("gfwlist utf8: {e}"))
}

fn chrono_like_now() -> String {
    // Avoid pulling chrono if not needed — RFC3339 via system time.
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Simple ISO-ish UTC; good enough for UI/meta.
    format!("unix:{secs}")
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"[AutoProxy 0.2.9]
! Comment
||google.com
||github.com
@@||local.google.com
|https://cdn.jsdelivr.net/
twitter
.facebook.com
"#;

    #[test]
    fn compile_plain_and_match() {
        let c = CompiledRules::compile(SAMPLE, "test").unwrap();
        assert!(c.meta.rule_count >= 5);
        assert!(matches!(
            c.match_host("www.google.com"),
            RuleMatch::Proxy { .. }
        ));
        assert!(matches!(
            c.match_host("api.github.com"),
            RuleMatch::Proxy { .. }
        ));
        assert!(matches!(
            c.match_host("local.google.com"),
            RuleMatch::Direct { .. }
        ));
        assert!(matches!(
            c.match_host("cdn.jsdelivr.net"),
            RuleMatch::Proxy { .. }
        ));
        assert!(matches!(
            c.match_host("www.facebook.com"),
            RuleMatch::Proxy { .. }
        ));
        assert!(matches!(c.match_host("example.com"), RuleMatch::Miss));
    }

    #[test]
    fn compile_base64() {
        let b64 = B64.encode(SAMPLE.as_bytes());
        let c = CompiledRules::compile(&b64, "b64").unwrap();
        assert!(matches!(
            c.match_host("google.com"),
            RuleMatch::Proxy { .. }
        ));
    }
}
