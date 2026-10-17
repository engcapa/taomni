//! Download staging and strict range validation, shared by future HTTP providers.
use super::{control, network, provider::TransferContext};
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use std::path::Path;
use tokio::io::AsyncWriteExt;

#[derive(Serialize, Deserialize)]
struct Checkpoint {
    locator: String,
    etag: String,
    total: Option<u64>,
}

pub fn content_range(value: &str, offset: u64) -> Result<(u64, u64), String> {
    let (range, total) = value
        .strip_prefix("bytes ")
        .and_then(|s| s.split_once('/'))
        .ok_or("Invalid Content-Range")?;
    let (start, end) = range.split_once('-').ok_or("Invalid Content-Range")?;
    let start: u64 = start.parse().map_err(|_| "Invalid Content-Range")?;
    let end: u64 = end.parse().map_err(|_| "Invalid Content-Range")?;
    let total: u64 = total.parse().map_err(|_| "Unknown range total")?;
    if start != offset || end < start || end >= total {
        return Err("Unexpected Content-Range; partial data was not appended".into());
    }
    Ok((end + 1 - start, total))
}

pub async fn download(
    client: &reqwest::Client,
    url: &str,
    bearer: &str,
    locator: &str,
    path: &Path,
    ctx: &TransferContext,
) -> Result<(), String> {
    download_with_refresh(client, url, bearer, locator, path, ctx, |_| async {
        Err(super::failure::tagged(
            super::failure::FailureKind::Authorization,
            "Reconnect Feishu to download this backup",
        ))
    })
    .await
}

pub async fn download_with_refresh<R, Fut>(
    client: &reqwest::Client,
    url: &str,
    bearer: &str,
    locator: &str,
    path: &Path,
    ctx: &TransferContext,
    refresh: R,
) -> Result<(), String>
where
    R: Fn(String) -> Fut,
    Fut: std::future::Future<Output = Result<String, String>>,
{
    let partial = path.with_extension("part");
    let checkpoint_path = path.with_extension("download.json");
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| e.to_string())?;
    }
    let previous: Option<Checkpoint> = std::fs::read(&checkpoint_path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok());
    let mut offset = std::fs::metadata(&partial).map(|m| m.len()).unwrap_or(0);
    let previous = previous
        .filter(|p| p.locator == locator && !p.etag.is_empty() && !p.etag.starts_with("W/"));
    if previous.is_none() {
        offset = 0;
    }
    ctx.progress(
        "connecting",
        offset,
        previous.as_ref().and_then(|p| p.total),
    );
    let build = |token: &str| {
        let mut request = client
            .get(url)
            .bearer_auth(token)
            .header("Accept-Encoding", "identity");
        if offset > 0 {
            request = request
                .header("Range", format!("bytes={offset}-"))
                .header("If-Range", &previous.as_ref().unwrap().etag);
        }
        request
    };
    let response = super::feishu::request::download(build, bearer.into(), refresh, ctx).await?;
    // Never forward bearer credentials to a redirect host. Public Feishu downloads
    // currently stream directly; a changed service contract requires an adapter change.
    if response.status() == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
        let _ = tokio::fs::remove_file(&checkpoint_path).await;
        return Err(
            "Remote range is no longer valid; retry will download from the beginning".into(),
        );
    }
    let (expected_response_bytes, total) =
        if response.status() == reqwest::StatusCode::PARTIAL_CONTENT {
            let range = response
                .headers()
                .get("content-range")
                .and_then(|v| v.to_str().ok())
                .ok_or("Missing Content-Range")?;
            let (length, total) = content_range(range, offset)?;
            if offset > 0
                && previous
                    .as_ref()
                    .and_then(|p| p.total)
                    .is_some_and(|t| t != total)
            {
                return Err("Remote file changed; restart download".into());
            }
            (Some(length), Some(total))
        } else if response.status() == reqwest::StatusCode::OK {
            if offset > 0 {
                ctx.progress("restarting", 0, response.content_length());
            }
            offset = 0;
            (response.content_length(), response.content_length())
        } else {
            return Err(format!(
                "Backup download failed (HTTP {})",
                response.status().as_u16()
            ));
        };
    let _cache_reservation = super::cache::reserve(path, expected_response_bytes.unwrap_or(0))?;
    let etag = response
        .headers()
        .get("etag")
        .and_then(|s| s.to_str().ok())
        .unwrap_or("")
        .to_owned();
    if offset > 0 && etag != previous.as_ref().unwrap().etag {
        let _ = tokio::fs::remove_file(&checkpoint_path).await;
        return Err("Remote revision changed; retry will download from the beginning".into());
    }
    let mut output = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(offset == 0)
        .append(offset > 0)
        .open(&partial)
        .await
        .map_err(|e| e.to_string())?;
    control::write_json(
        &checkpoint_path,
        &Checkpoint {
            locator: locator.into(),
            etag,
            total,
        },
    )?;
    let mut stream = response.bytes_stream();
    let mut received = 0u64;
    loop {
        let chunk = tokio::select! {
            _ = ctx.cancel.cancelled() => {
                // Tokio's file writes may still be buffered when write_all
                // resolves. Finish them before exposing the resumable prefix.
                output.flush().await.map_err(|e| e.to_string())?;
                output.sync_data().await.map_err(|e| e.to_string())?;
                return Err("BACKUP_CANCELLED".into());
            },
            next = stream.next() => next
        };
        let Some(chunk) = chunk else { break };
        let bytes = match chunk {
            Ok(bytes) => bytes,
            Err(error) => {
                output.flush().await.map_err(|e| e.to_string())?;
                return Err(network::network_error(error));
            }
        };
        let _chunk_reservation = if expected_response_bytes.is_none() {
            super::cache::reserve(path, bytes.len() as u64)?
        } else {
            None
        };
        received += bytes.len() as u64;
        if expected_response_bytes.is_some_and(|expected| received > expected) {
            return Err("Download exceeded its declared size".into());
        }
        output.write_all(&bytes).await.map_err(|e| e.to_string())?;
        ctx.progress("downloading", offset + received, total);
    }
    output.sync_all().await.map_err(|e| e.to_string())?;
    drop(output);
    if expected_response_bytes.is_some_and(|size| size != received)
        || total.is_some_and(|size| size != offset + received)
    {
        return Err("Incomplete download; retry to resume".into());
    }
    ctx.check()?;
    // This is only a transport-complete candidate. The caller authenticates the
    // archive before exposing any restore action or publishing a backup receipt.
    tokio::fs::rename(&partial, path)
        .await
        .map_err(|e| e.to_string())?;
    let _ = tokio::fs::remove_file(checkpoint_path).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_wrong_ranges_before_appending() {
        assert_eq!(content_range("bytes 5-9/10", 5).unwrap(), (5, 10));
        for s in [
            "bytes 0-9/10",
            "bytes 5-10/10",
            "bytes 6-5/10",
            "bytes 5-9/*",
            "items 5-9/10",
        ] {
            assert!(content_range(s, 5).is_err(), "{s}");
        }
    }
    #[tokio::test]
    async fn cancellation_preserves_working_file_and_range_resume_publishes_full_bytes() {
        use std::sync::Arc;
        use tokio::io::AsyncReadExt;
        use tokio_util::sync::CancellationToken;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("archive.taobak");
        std::fs::write(&path, b"working").unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/file", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = [0; 4096];
            socket.read(&mut bytes).await.unwrap();
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nETag: \"v1\"\r\nConnection: close\r\n\r\nabcd").await.unwrap();
            // The first request stays open until cancellation drops the response.
            let _ = socket.read(&mut bytes).await;
            drop(socket);
            let (mut socket, _) = listener.accept().await.unwrap();
            let n = socket.read(&mut bytes).await.unwrap();
            let request = String::from_utf8_lossy(&bytes[..n]).to_lowercase();
            assert!(request.contains("range: bytes=4-"));
            assert!(request.contains("if-range: \"v1\""));
            socket.write_all(b"HTTP/1.1 206 Partial Content\r\nContent-Length: 4\r\nContent-Range: bytes 4-7/8\r\nETag: \"v1\"\r\nConnection: close\r\n\r\nefgh").await.unwrap();
        });
        let cancel = CancellationToken::new();
        let signal = cancel.clone();
        let ctx = TransferContext {
            cancel,
            report: Arc::new(move |phase, bytes, _| {
                if phase == "downloading" && bytes >= 4 {
                    signal.cancel();
                }
            }),
        };
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        assert_eq!(
            download(&client, &url, "fixture", "file", &path, &ctx)
                .await
                .unwrap_err(),
            "BACKUP_CANCELLED"
        );
        assert_eq!(std::fs::read(&path).unwrap(), b"working");
        assert_eq!(std::fs::read(path.with_extension("part")).unwrap(), b"abcd");
        let ctx = TransferContext {
            cancel: CancellationToken::new(),
            report: Arc::new(|_, _, _| {}),
        };
        download(&client, &url, "fixture", "file", &path, &ctx)
            .await
            .unwrap();
        server.await.unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"abcdefgh");
        assert!(!path.with_extension("part").exists());
    }
}
