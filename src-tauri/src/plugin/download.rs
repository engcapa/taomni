//! Pure download policy and progress primitives for module installation.
//!
//! The actual HTTP client is intentionally outside this module.  These types
//! decide which proxy route may be used, whether a response can resume a
//! partial file, and what progress/cancellation state the UI should observe.

use std::fmt;

use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProxyMode {
    #[serde(alias = "application", alias = "app")]
    Application,
    #[serde(alias = "independent", alias = "custom")]
    Feature,
    #[serde(alias = "direct", alias = "none")]
    NoProxy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProxyEndpoint {
    pub kind: ProxyKind,
    pub host: String,
    pub port: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProxyKind {
    Http,
    Socks5,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProxyRoute {
    Application(ProxyEndpoint),
    Feature(ProxyEndpoint),
    NoProxy,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum DownloadError {
    #[error("unknown module proxy mode: {0}")]
    UnknownProxyMode(String),
    #[error("the selected module proxy is not configured")]
    ProxyNotConfigured,
    #[error("module proxy host is empty")]
    EmptyProxyHost,
    #[error("module proxy port must be between 1 and 65535")]
    InvalidProxyPort,
    #[error("module proxy kind is unsupported")]
    InvalidProxyKind,
    #[error("invalid Content-Range header: {0}")]
    InvalidContentRange(String),
    #[error("HTTP status {0} cannot resume this module download")]
    UnexpectedStatus(u16),
    #[error("server returned a partial response without a valid Content-Range")]
    MissingContentRange,
    #[error("partial response starts at byte {actual}, expected byte {expected}")]
    RangeStartMismatch { expected: u64, actual: u64 },
    #[error("partial response total is {actual:?}, expected {expected:?}")]
    RangeTotalMismatch {
        expected: Option<u64>,
        actual: Option<u64>,
    },
    #[error("partial response length is {actual}, expected {expected}")]
    RangeLengthMismatch { expected: u64, actual: u64 },
    #[error("download is already complete")]
    AlreadyComplete,
    #[error("download task has already failed")]
    AlreadyFailed,
    #[error("download completed with {downloaded} of {total} bytes")]
    IncompleteCompletion { downloaded: u64, total: u64 },
    #[error("download task is cancelled")]
    Cancelled,
}

/// Parse the persisted setting names used by existing download preferences.
///
/// `app`/`custom`/`none` are the names used by the current settings schema;
/// the longer names are accepted for forwards/backwards compatibility.  An
/// unknown value is rejected instead of silently falling back to the
/// application proxy.
pub fn parse_proxy_mode(value: &str) -> Result<ProxyMode, DownloadError> {
    match value.trim().to_ascii_lowercase().as_str() {
        "app" | "application" | "inherit" => Ok(ProxyMode::Application),
        "custom" | "feature" | "independent" => Ok(ProxyMode::Feature),
        "none" | "direct" | "no-proxy" => Ok(ProxyMode::NoProxy),
        other => Err(DownloadError::UnknownProxyMode(other.to_owned())),
    }
}

pub fn parse_proxy_kind(value: &str) -> Result<ProxyKind, DownloadError> {
    match value.trim().to_ascii_lowercase().as_str() {
        "http" => Ok(ProxyKind::Http),
        "socks5" | "socks5h" => Ok(ProxyKind::Socks5),
        _ => Err(DownloadError::InvalidProxyKind),
    }
}

/// Select exactly one route.  `NoProxy` intentionally returns no endpoint;
/// the eventual HTTP client must also disable environment/system proxy lookup.
pub fn resolve_proxy_route(
    mode: ProxyMode,
    application: Option<ProxyEndpoint>,
    feature: Option<ProxyEndpoint>,
) -> Result<ProxyRoute, DownloadError> {
    let route = match mode {
        ProxyMode::NoProxy => ProxyRoute::NoProxy,
        ProxyMode::Application => {
            ProxyRoute::Application(application.ok_or(DownloadError::ProxyNotConfigured)?)
        }
        ProxyMode::Feature => {
            ProxyRoute::Feature(feature.ok_or(DownloadError::ProxyNotConfigured)?)
        }
    };
    match &route {
        ProxyRoute::NoProxy => Ok(route),
        ProxyRoute::Application(endpoint) | ProxyRoute::Feature(endpoint) => {
            validate_endpoint(endpoint)?;
            Ok(route)
        }
    }
}

fn validate_endpoint(endpoint: &ProxyEndpoint) -> Result<(), DownloadError> {
    if endpoint.host.trim().is_empty() {
        return Err(DownloadError::EmptyProxyHost);
    }
    if endpoint.port == 0 {
        return Err(DownloadError::InvalidProxyPort);
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ContentRange {
    pub start: u64,
    pub end: u64,
    pub total: Option<u64>,
}

impl ContentRange {
    pub fn len(self) -> u64 {
        self.end.saturating_sub(self.start).saturating_add(1)
    }
}

impl fmt::Display for ContentRange {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "bytes {}-{}/", self.start, self.end)?;
        match self.total {
            Some(total) => write!(f, "{total}"),
            None => write!(f, "*"),
        }
    }
}

pub fn parse_content_range(value: &str) -> Result<ContentRange, DownloadError> {
    let value = value.trim();
    let has_bytes_unit = value.len() >= 6 && value.as_bytes()[..6].eq_ignore_ascii_case(b"bytes ");
    let Some(value) = has_bytes_unit.then(|| &value[6..]) else {
        return Err(DownloadError::InvalidContentRange(value.to_owned()));
    };
    let Some((range, total)) = value.split_once('/') else {
        return Err(DownloadError::InvalidContentRange(value.to_owned()));
    };
    let Some((start, end)) = range.split_once('-') else {
        return Err(DownloadError::InvalidContentRange(value.to_owned()));
    };
    let start =
        parse_u64(start).ok_or_else(|| DownloadError::InvalidContentRange(value.to_owned()))?;
    let end = parse_u64(end).ok_or_else(|| DownloadError::InvalidContentRange(value.to_owned()))?;
    if end < start {
        return Err(DownloadError::InvalidContentRange(value.to_owned()));
    }
    let total = if total == "*" {
        None
    } else {
        Some(parse_u64(total).ok_or_else(|| DownloadError::InvalidContentRange(value.to_owned()))?)
    };
    if total.is_some_and(|total| total <= end) {
        return Err(DownloadError::InvalidContentRange(value.to_owned()));
    }
    Ok(ContentRange { start, end, total })
}

fn parse_u64(value: &str) -> Option<u64> {
    (!value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()))
        .then(|| value.parse().ok())
        .flatten()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResumeDecision {
    /// Append the response body to the existing partial file.
    Append { offset: u64 },
    /// The server ignored Range; truncate the partial file and restart safely.
    Restart,
    /// No bytes were present, so write the response from byte zero.
    Fresh,
}

/// Validate an HTTP response before writing any body bytes to disk.
pub fn validate_resume_response(
    existing_len: u64,
    expected_total: Option<u64>,
    status: u16,
    content_range: Option<&str>,
    content_length: Option<u64>,
) -> Result<ResumeDecision, DownloadError> {
    match status {
        200 => {
            if let (Some(expected), Some(length)) = (expected_total, content_length) {
                if expected != length {
                    return Err(DownloadError::RangeLengthMismatch {
                        expected,
                        actual: length,
                    });
                }
            }
            if existing_len > 0 {
                Ok(ResumeDecision::Restart)
            } else {
                Ok(ResumeDecision::Fresh)
            }
        }
        206 => {
            let Some(header) = content_range else {
                return Err(DownloadError::MissingContentRange);
            };
            let range = parse_content_range(header)?;
            if range.start != existing_len {
                return Err(DownloadError::RangeStartMismatch {
                    expected: existing_len,
                    actual: range.start,
                });
            }
            if let Some(expected) = expected_total {
                if range.total != Some(expected) {
                    return Err(DownloadError::RangeTotalMismatch {
                        expected: Some(expected),
                        actual: range.total,
                    });
                }
            }
            if let Some(length) = content_length {
                let expected = range.len();
                if length != expected {
                    return Err(DownloadError::RangeLengthMismatch {
                        expected,
                        actual: length,
                    });
                }
            }
            Ok(ResumeDecision::Append {
                offset: existing_len,
            })
        }
        other => Err(DownloadError::UnexpectedStatus(other)),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DownloadPhase {
    Connecting,
    Downloading,
    Verifying,
    Completed,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DownloadProgress {
    pub revision: u64,
    pub downloaded: u64,
    pub total: Option<u64>,
    pub phase: DownloadPhase,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadTask {
    id: String,
    cancelled: bool,
    progress: DownloadProgress,
}

impl DownloadTask {
    pub fn new(id: impl Into<String>, total: Option<u64>) -> Self {
        Self {
            id: id.into(),
            cancelled: false,
            progress: DownloadProgress {
                revision: 1,
                downloaded: 0,
                total,
                phase: DownloadPhase::Connecting,
                error: None,
            },
        }
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn snapshot(&self) -> &DownloadProgress {
        &self.progress
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled
    }

    pub fn cancel(&mut self) {
        if !matches!(
            self.progress.phase,
            DownloadPhase::Completed | DownloadPhase::Failed
        ) {
            self.cancelled = true;
            self.set(DownloadPhase::Cancelled, self.progress.downloaded, None);
        }
    }

    pub fn update(
        &mut self,
        phase: DownloadPhase,
        downloaded: u64,
        error: Option<String>,
    ) -> Result<(), DownloadError> {
        if self.cancelled && !matches!(phase, DownloadPhase::Cancelled) {
            return Err(DownloadError::Cancelled);
        }
        if matches!(self.progress.phase, DownloadPhase::Completed) {
            return Err(DownloadError::AlreadyComplete);
        }
        if matches!(self.progress.phase, DownloadPhase::Failed) {
            return Err(DownloadError::AlreadyFailed);
        }
        if let (DownloadPhase::Completed, Some(total)) = (phase, self.progress.total) {
            if downloaded < total {
                return Err(DownloadError::IncompleteCompletion { downloaded, total });
            }
        }
        self.set(phase, downloaded, error);
        Ok(())
    }

    fn set(&mut self, phase: DownloadPhase, downloaded: u64, error: Option<String>) {
        self.progress.revision = self.progress.revision.saturating_add(1);
        self.progress.downloaded = self
            .progress
            .total
            .map_or(downloaded, |total| downloaded.min(total));
        self.progress.phase = phase;
        self.progress.error = error;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn endpoint() -> ProxyEndpoint {
        ProxyEndpoint {
            kind: ProxyKind::Http,
            host: "proxy.example".into(),
            port: 8080,
        }
    }

    #[test]
    fn proxy_modes_are_explicit_and_do_not_fallback() {
        assert_eq!(parse_proxy_mode("app").unwrap(), ProxyMode::Application);
        assert_eq!(parse_proxy_mode("CUSTOM").unwrap(), ProxyMode::Feature);
        assert_eq!(parse_proxy_mode("none").unwrap(), ProxyMode::NoProxy);
        assert_eq!(parse_proxy_kind("HTTP").unwrap(), ProxyKind::Http);
        assert_eq!(parse_proxy_kind("socks5h").unwrap(), ProxyKind::Socks5);
        assert!(matches!(
            parse_proxy_kind("ftp"),
            Err(DownloadError::InvalidProxyKind)
        ));
        assert!(matches!(
            parse_proxy_mode("unexpected"),
            Err(DownloadError::UnknownProxyMode(_))
        ));
        assert_eq!(
            resolve_proxy_route(ProxyMode::NoProxy, None, None).unwrap(),
            ProxyRoute::NoProxy
        );
        assert_eq!(
            resolve_proxy_route(ProxyMode::Application, Some(endpoint()), None).unwrap(),
            ProxyRoute::Application(endpoint())
        );
        assert!(matches!(
            resolve_proxy_route(ProxyMode::Feature, None, None),
            Err(DownloadError::ProxyNotConfigured)
        ));
        assert!(matches!(
            resolve_proxy_route(ProxyMode::Application, None, Some(endpoint())),
            Err(DownloadError::ProxyNotConfigured)
        ));
        let mut invalid = endpoint();
        invalid.host = "  ".into();
        assert!(matches!(
            resolve_proxy_route(ProxyMode::Application, Some(invalid), None),
            Err(DownloadError::EmptyProxyHost)
        ));
        let mut invalid = endpoint();
        invalid.port = 0;
        assert!(matches!(
            resolve_proxy_route(ProxyMode::Feature, None, Some(invalid)),
            Err(DownloadError::InvalidProxyPort)
        ));
    }

    #[test]
    fn content_range_requires_exact_resume_offset_and_length() {
        assert_eq!(parse_content_range("bytes 3-5/9").unwrap().len(), 3);
        assert_eq!(
            validate_resume_response(3, Some(9), 206, Some("bytes 3-5/9"), Some(3)).unwrap(),
            ResumeDecision::Append { offset: 3 }
        );
        assert!(matches!(
            validate_resume_response(2, Some(9), 206, Some("bytes 3-5/9"), Some(3)),
            Err(DownloadError::RangeStartMismatch { .. })
        ));
        assert!(matches!(
            validate_resume_response(3, Some(9), 206, Some("bytes 3-5/9"), Some(2)),
            Err(DownloadError::RangeLengthMismatch { .. })
        ));
    }

    #[test]
    fn ignored_range_restarts_instead_of_appending() {
        assert_eq!(
            validate_resume_response(3, Some(9), 200, None, Some(9)).unwrap(),
            ResumeDecision::Restart
        );
        assert_eq!(
            validate_resume_response(0, Some(9), 200, None, Some(9)).unwrap(),
            ResumeDecision::Fresh
        );
        assert!(matches!(
            validate_resume_response(3, Some(9), 206, None, None),
            Err(DownloadError::MissingContentRange)
        ));
        assert!(matches!(
            validate_resume_response(3, Some(9), 200, None, Some(8)),
            Err(DownloadError::RangeLengthMismatch { .. })
        ));
    }

    #[test]
    fn progress_is_retained_after_cancel_and_rejects_future_writes() {
        let mut task = DownloadTask::new("module-1", Some(10));
        task.update(DownloadPhase::Downloading, 4, None).unwrap();
        task.cancel();
        assert_eq!(task.snapshot().phase, DownloadPhase::Cancelled);
        assert!(task.is_cancelled());
        assert!(matches!(
            task.update(DownloadPhase::Verifying, 4, None),
            Err(DownloadError::Cancelled)
        ));
    }

    #[test]
    fn failed_and_incomplete_tasks_are_terminal() {
        let mut task = DownloadTask::new("module-1", Some(10));
        assert!(matches!(
            task.update(DownloadPhase::Completed, 9, None),
            Err(DownloadError::IncompleteCompletion { .. })
        ));
        task.update(DownloadPhase::Failed, 9, Some("network".into()))
            .unwrap();
        assert!(matches!(
            task.update(DownloadPhase::Downloading, 9, None),
            Err(DownloadError::AlreadyFailed)
        ));
    }

    #[test]
    fn task_snapshot_can_be_persisted_for_background_resume() {
        let mut task = DownloadTask::new("module-1", None);
        task.update(DownloadPhase::Downloading, 128, None).unwrap();
        let restored: DownloadTask =
            serde_json::from_str(&serde_json::to_string(&task).expect("download task serializes"))
                .expect("download task restores");
        assert_eq!(restored.id(), "module-1");
        assert_eq!(restored.snapshot(), task.snapshot());
    }
}
