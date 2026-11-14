use regex::Regex;
use std::sync::OnceLock;

/// Redact sensitive patterns from text before sending to LLM.
/// Replaces matched values with [REDACTED].
pub fn redact(text: &str) -> (String, usize) {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| {
        vec![
            Regex::new(r"(?i)(password|passwd|pwd)\s*[=:]\s*\S+").unwrap(),
            Regex::new(r"(?i)(token|api[_-]?key|secret|auth)\s*[=:]\s*\S+").unwrap(),
            Regex::new(r"Bearer\s+[A-Za-z0-9\-._~+/]+=*").unwrap(),
            // Keep `ls -p` and other flag-only commands usable while still
            // removing `mysql -psecret` and `mysql -p secret` credentials.
            Regex::new(r"(?i)(?:^|\s)-p(?:=\S+|\s+\S+|\S+)").unwrap(),
            Regex::new(r"(?i)Authorization:\s*\S+").unwrap(),
            Regex::new(
                r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----",
            )
            .unwrap(),
            Regex::new(r"\bAKIA[0-9A-Z]{16}\b").unwrap(),
            Regex::new(r"\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b")
                .unwrap(),
            Regex::new(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+\b").unwrap(),
            Regex::new(r"(?i)\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?)://[^\s]+").unwrap(),
            Regex::new(r"(?i)\bX-Api-Key\s*:\s*[^\s]+").unwrap(),
        ]
    });

    let mut result = text.to_string();
    let mut count = 0;
    for re in patterns {
        let new = re.replace_all(&result, "[REDACTED]").to_string();
        if new != result {
            count += 1;
            result = new;
        }
    }
    (result, count)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn redacts_password() {
        let (r, n) = redact("mysql -u root password=secret123");
        assert!(r.contains("[REDACTED]"));
        assert!(n > 0);
    }
    #[test]
    fn redacts_bearer() {
        let (r, n) = redact("Authorization: Bearer eyJhbGc.abc");
        assert!(r.contains("[REDACTED]"));
        assert!(n > 0);
    }
    #[test]
    fn safe_text() {
        let (r, n) = redact("ls -la /home/user");
        assert_eq!(r, "ls -la /home/user");
        assert_eq!(n, 0);
    }

    #[test]
    fn redacts_modern_credentials_without_hiding_plain_flags() {
        let (r, n) = redact(
            "aws AKIA1234567890ABCDEF token ghp_1234567890123456789012345678901234567890 jwt eyJabc.def.ghi db postgres://user:pass@example.test/x ls -p",
        );
        assert!(!r.contains("AKIA1234567890ABCDEF"));
        assert!(!r.contains("ghp_1234567890123456789012345678901234567890"));
        assert!(!r.contains("postgres://user:pass@example.test/x"));
        assert!(r.contains("ls -p"));
        assert!(n >= 4);
    }

    #[test]
    fn redacts_private_key_block() {
        let (r, n) = redact("-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----");
        assert_eq!(r, "[REDACTED]");
        assert_eq!(n, 1);
    }
}
