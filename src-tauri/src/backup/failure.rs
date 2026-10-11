//! Stable failure categories shared by transport, persisted jobs and the UI.
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureKind {
    Transient,
    Authorization,
    Permission,
    Storage,
    Permanent,
}

pub fn tagged(kind: FailureKind, message: &str) -> String {
    let code = match kind {
        FailureKind::Transient => "BACKUP_TRANSIENT",
        FailureKind::Authorization => "BACKUP_AUTHORIZATION",
        FailureKind::Permission => "BACKUP_PERMISSION",
        FailureKind::Storage => "BACKUP_STORAGE",
        FailureKind::Permanent => "BACKUP_PERMANENT",
    };
    format!("{code}: {message}")
}

pub fn classify(message: &str) -> FailureKind {
    match message.split(':').next().unwrap_or_default() {
        "BACKUP_TRANSIENT" => FailureKind::Transient,
        "BACKUP_AUTHORIZATION" => FailureKind::Authorization,
        "BACKUP_PERMISSION" => FailureKind::Permission,
        "BACKUP_STORAGE" => FailureKind::Storage,
        _ => FailureKind::Permanent,
    }
}

pub fn http_kind(status: reqwest::StatusCode, code: i64) -> FailureKind {
    if status == reqwest::StatusCode::UNAUTHORIZED
        || matches!(code, 99991663 | 99991664 | 99991665 | 99991668)
    {
        FailureKind::Authorization
    } else if status == reqwest::StatusCode::FORBIDDEN || code == 99991672 {
        FailureKind::Permission
    } else if status == reqwest::StatusCode::TOO_MANY_REQUESTS
        || status == reqwest::StatusCode::REQUEST_TIMEOUT
        || status.is_server_error()
        || code == 99991400
    {
        FailureKind::Transient
    } else {
        FailureKind::Permanent
    }
}

/// Bound server hints, including HTTP dates, to keep cancellation and retry UI useful.
pub fn retry_after(headers: &reqwest::header::HeaderMap) -> Option<Duration> {
    let value = headers.get(reqwest::header::RETRY_AFTER)?.to_str().ok()?;
    let seconds = value.parse::<u64>().ok().or_else(|| {
        chrono::DateTime::parse_from_rfc2822(value)
            .ok()
            .map(|at| (at.timestamp() - chrono::Utc::now().timestamp()).max(0) as u64)
    })?;
    Some(Duration::from_secs(seconds.min(300)))
}

pub async fn wait(delay: Duration, cancel: &CancellationToken) -> Result<(), String> {
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err("BACKUP_CANCELLED".into()),
        _ = tokio::time::sleep(delay) => Ok(()),
    }
}

pub const MAX_JOB_ATTEMPTS: u32 = 6;
pub fn next_retry(kind: FailureKind, attempts: u32, now: i64) -> Option<i64> {
    if kind != FailureKind::Transient || attempts >= MAX_JOB_ATTEMPTS {
        return None;
    }
    Some(now.saturating_add(60_000i64 * (1i64 << attempts.saturating_sub(1).min(5))))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permanent_failures_are_never_automatically_replayed() {
        for kind in [
            FailureKind::Authorization,
            FailureKind::Permission,
            FailureKind::Storage,
            FailureKind::Permanent,
        ] {
            assert_eq!(next_retry(kind, 1, 0), None);
            assert_eq!(classify(&tagged(kind, "safe message")), kind);
        }
        assert_eq!(next_retry(FailureKind::Transient, 1, 100), Some(60_100));
        assert_eq!(next_retry(FailureKind::Transient, 5, 100), Some(960_100));
        assert_eq!(next_retry(FailureKind::Transient, 6, 100), None);
    }

    #[tokio::test]
    async fn cancellation_interrupts_server_backoff() {
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert_eq!(
            wait(Duration::from_secs(300), &cancel).await.unwrap_err(),
            "BACKUP_CANCELLED"
        );
    }
}
