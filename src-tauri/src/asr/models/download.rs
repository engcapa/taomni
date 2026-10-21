use crate::asr::catalog;
use futures::StreamExt;
use tokio_util::sync::CancellationToken;

pub(super) fn retire_replaced_model(
    root: &std::path::Path,
    old: &catalog::Model,
    new: &catalog::Model,
) -> Result<(), String> {
    catalog::verify(new, &catalog::version_path(root, new))?;
    for old_path in [
        catalog::version_path(root, old),
        root.join(old.id).join(old.filename),
    ] {
        if old_path.is_file() {
            std::fs::remove_file(old_path)
                .map_err(|e| format!("Replacement ready; old model removal failed: {e}"))?;
        }
    }
    Ok(())
}

/// Resume only against the immutable, hash-pinned artifact. Final SHA verification
/// is mandatory even if the server ignores Range and a full restart is needed.
pub(super) async fn download_to_part(
    client: &reqwest::Client,
    url: &str,
    total: u64,
    part: &std::path::Path,
    cancel: &CancellationToken,
    mut progress: impl FnMut(&'static str, u64),
) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;
    if cancel.is_cancelled() {
        return Err("CANCELLED".into());
    }
    let mut offset = tokio::fs::metadata(part)
        .await
        .map(|v| v.len())
        .unwrap_or(0);
    if offset > total {
        offset = 0;
    }
    progress("connecting", offset);
    if offset == total {
        return Ok(());
    }
    let mut request = client
        .get(url)
        .header(reqwest::header::ACCEPT_ENCODING, "identity");
    if offset > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={offset}-"));
    }
    let response = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err("CANCELLED".into()),
        response = request.send() => response.map_err(|e| e.to_string())?.error_for_status().map_err(|e| e.to_string())?,
    };
    if response
        .headers()
        .get(reqwest::header::CONTENT_ENCODING)
        .is_some_and(|v| v != "identity")
    {
        return Err("Unsupported encoded model response".into());
    }
    if response.status() == reqwest::StatusCode::PARTIAL_CONTENT {
        let expected = format!("bytes {offset}-{}/{total}", total - 1);
        if response
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            != Some(expected.as_str())
        {
            return Err("Invalid model Content-Range; partial download retained".into());
        }
    } else if response.status() == reqwest::StatusCode::OK {
        offset = 0; // Range unsupported: truncate, never append a full response.
    } else {
        return Err("Unexpected model download response".into());
    }
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(offset > 0)
        .truncate(offset == 0)
        .open(part)
        .await
        .map_err(|e| e.to_string())?;
    progress("downloading", offset);
    let mut stream = response.bytes_stream();
    let mut last = std::time::Instant::now();
    let result = async {
        loop {
            let chunk = tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err("CANCELLED".into()),
                chunk = stream.next() => chunk,
            };
            let Some(chunk) = chunk else {
                break;
            };
            let chunk = chunk.map_err(|e| e.to_string())?;
            if offset + chunk.len() as u64 > total {
                return Err("Model exceeds expected size".into());
            }
            file.write_all(&chunk).await.map_err(|e| e.to_string())?;
            offset += chunk.len() as u64;
            if last.elapsed().as_millis() >= 200 || offset == total {
                progress("downloading", offset);
                last = std::time::Instant::now();
            }
        }
        if offset != total {
            return Err("Incomplete model download; retry to resume".into());
        }
        Ok(())
    }
    .await;
    // Flush pending Tokio writes before reporting a pause/error or reopening.
    file.flush().await.map_err(|e| e.to_string())?;
    file.sync_all().await.map_err(|e| e.to_string())?;
    result
}

#[cfg(test)]
pub(super) fn publish_verified(
    m: &catalog::Model,
    part: &std::path::Path,
    target: &std::path::Path,
) -> Result<(), String> {
    publish_verified_cancellable(m, part, target, None)
}
pub(super) fn publish_verified_cancellable(
    m: &catalog::Model,
    part: &std::path::Path,
    target: &std::path::Path,
    cancel: Option<&CancellationToken>,
) -> Result<(), String> {
    catalog::verify(m, part)?;
    if cancel.is_some_and(CancellationToken::is_cancelled) {
        return Err("CANCELLED".into());
    }
    if target.exists() {
        if catalog::verify(m, target).is_ok() {
            // Never delete a valid current file on reinstall, including Windows.
            return std::fs::remove_file(part).map_err(|e| e.to_string());
        }
        // This is only the corrupt current revision; previous revisions have
        // different directories and are never modified by this transaction.
        std::fs::remove_file(target).map_err(|e| e.to_string())?;
    }
    std::fs::rename(part, target).map_err(|e| e.to_string())
}
