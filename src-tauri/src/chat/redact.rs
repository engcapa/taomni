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
            Regex::new(r"-p\s*\S+").unwrap(),
            Regex::new(r"(?i)Authorization:\s*\S+").unwrap(),
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
    #[test] fn redacts_password() { let (r, n) = redact("mysql -u root password=secret123"); assert!(r.contains("[REDACTED]")); assert!(n > 0); }
    #[test] fn redacts_bearer()   { let (r, n) = redact("Authorization: Bearer eyJhbGc.abc"); assert!(r.contains("[REDACTED]")); assert!(n > 0); }
    #[test] fn safe_text()        { let (r, n) = redact("ls -la /home/user"); assert_eq!(r, "ls -la /home/user"); assert_eq!(n, 0); }
}
