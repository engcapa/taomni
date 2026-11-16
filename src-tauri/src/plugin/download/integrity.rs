//! Validation and publication are shared by fresh and resumed native transfers.

use std::path::Path;

use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;
use tokio_util::sync::CancellationToken;

use super::{DownloadError, DownloadRequest, ResumeDecision, parse_content_range};

pub(super) const MAX_PACKAGE_BYTES: u64 = 4 * 1024 * 1024 * 1024;

pub(super) fn validate_request(request: &DownloadRequest) -> Result<(), DownloadError> {
    if request.id.trim().is_empty() {
        return Err(DownloadError::InvalidPath(
            "download task id is empty".into(),
        ));
    }
    let url = reqwest::Url::parse(&request.url)
        .map_err(|_| DownloadError::InvalidUrl("malformed package URL".into()))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(DownloadError::InvalidUrl(
            "expected HTTP(S) package URL without credentials or fragment".into(),
        ));
    }
    if request
        .expected_total
        .is_some_and(|size| size > MAX_PACKAGE_BYTES)
    {
        return Err(DownloadError::Integrity(
            "package exceeds 4 GiB limit".into(),
        ));
    }
    if request.expected_sha256.as_ref().is_some_and(|digest| {
        digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit())
    }) {
        return Err(DownloadError::Integrity("invalid expected SHA-256".into()));
    }
    Ok(())
}

/// An ignored Range restarts at zero; the old prefix must not inflate total.
pub(super) fn response_sizes(
    expected_total: Option<u64>,
    decision: ResumeDecision,
    range: Option<&str>,
    content_length: Option<u64>,
) -> Result<(u64, Option<u64>, Option<u64>), DownloadError> {
    let offset = match decision {
        ResumeDecision::Append { offset } => offset,
        ResumeDecision::Fresh | ResumeDecision::Restart => 0,
    };
    let (total, response_bytes) = match decision {
        ResumeDecision::Append { .. } => {
            let range = parse_content_range(range.ok_or(DownloadError::MissingContentRange)?)?;
            // Content-Length describes this segment, never the whole artifact.
            (expected_total.or(range.total), Some(range.len()))
        }
        ResumeDecision::Fresh | ResumeDecision::Restart => {
            (expected_total.or(content_length), content_length)
        }
    };
    if offset > MAX_PACKAGE_BYTES
        || total.is_some_and(|size| size > MAX_PACKAGE_BYTES)
        || response_bytes.is_some_and(|size| size > MAX_PACKAGE_BYTES.saturating_sub(offset))
    {
        return Err(DownloadError::Integrity(
            "package exceeds 4 GiB limit".into(),
        ));
    }
    Ok((offset, total, response_bytes))
}

pub(super) fn check_cancelled(cancellation: &CancellationToken) -> Result<(), DownloadError> {
    if cancellation.is_cancelled() {
        Err(DownloadError::Cancelled)
    } else {
        Ok(())
    }
}

pub(super) async fn verify_file(
    path: &Path,
    expected_sha256: Option<&str>,
    cancellation: &CancellationToken,
) -> Result<(), DownloadError> {
    check_cancelled(cancellation)?;
    let Some(expected) = expected_sha256 else {
        return Ok(());
    };
    let mut file = tokio::fs::File::open(path).await?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0u8; 256 * 1024];
    loop {
        check_cancelled(cancellation)?;
        let count = file.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    check_cancelled(cancellation)?;
    if !hex_digest(digest.finalize().as_slice()).eq_ignore_ascii_case(expected) {
        return Err(DownloadError::Integrity(
            "package SHA-256 does not match".into(),
        ));
    }
    Ok(())
}

pub(super) fn hex_digest(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Create the destination atomically without replacing a concurrent publisher.
/// Both paths reside in the staging filesystem. Keep the verified partial if
/// publication fails, so a working artifact is never removed or overwritten.
pub(super) async fn publish(partial: &Path, completed: &Path) -> Result<(), DownloadError> {
    tokio::fs::hard_link(partial, completed)
        .await
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                DownloadError::OutputExists(completed.display().to_string())
            } else {
                DownloadError::Io(error)
            }
        })?;
    // The completed artifact is already valid. A cleanup failure must not turn
    // a published success into a failed transfer or remove the destination.
    if let Err(error) = tokio::fs::remove_file(partial).await {
        log::warn!("completed module download retained its partial link: {error}");
    }
    Ok(())
}

#[cfg(test)]
#[path = "integrity_tests.rs"]
mod tests;
