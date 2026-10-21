use crate::agent::acp_bridge::protocol;
use regex::Regex;
use std::sync::Arc;
use std::sync::OnceLock;
use tokio::io::BufReader;
use tokio::sync::Mutex;

pub(super) fn spawn_stderr_reader(
    stderr: tokio::process::ChildStderr,
    buffer: Arc<Mutex<String>>,
    limit: usize,
) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let sanitized = sanitize_diagnostic(&line);
            let mut buffer = buffer.lock().await;
            append_bounded(&mut buffer, &sanitized, limit);
            append_bounded(&mut buffer, "\n", limit);
        }
    });
}

pub(super) fn append_bounded(buffer: &mut String, value: &str, limit: usize) {
    buffer.push_str(value);
    if buffer.len() <= limit {
        return;
    }
    let mut start = buffer.len().saturating_sub(limit);
    while start < buffer.len() && !buffer.is_char_boundary(start) {
        start += 1;
    }
    buffer.drain(..start);
}

pub(super) fn sanitize_diagnostic(value: &str) -> String {
    static JSON_SECRET: OnceLock<Regex> = OnceLock::new();
    static URL_USERINFO: OnceLock<Regex> = OnceLock::new();
    let (redacted, _) = crate::chat::redact::redact(value);
    let redacted = JSON_SECRET
        .get_or_init(|| {
            Regex::new(
                r#"(?i)("(?:password|passwd|pwd|token|api[_-]?key|secret|authorization)"\s*:\s*")[^"]*"#,
            )
            .expect("valid ACP JSON secret regex")
        })
        .replace_all(&redacted, "$1[REDACTED]")
        .into_owned();
    let redacted = URL_USERINFO
        .get_or_init(|| {
            Regex::new(r"(?i)(https?://)[^/@\s:]+:[^/@\s]+@")
                .expect("valid ACP URL credential regex")
        })
        .replace_all(&redacted, "$1[REDACTED]@")
        .into_owned();
    protocol::truncate_display_text(&redacted, 1000)
}

pub(super) fn truncate_method(method: &str) -> String {
    protocol::truncate_display_text(method, 120)
}
use tokio::io::AsyncBufReadExt;
