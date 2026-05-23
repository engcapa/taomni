// Three-source mirror probe + Range-resumable streaming download + SHA-256
// verification. Emits progress events for the frontend.

use super::manifest::ModelMeta;
use futures::StreamExt;
use reqwest::Client;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs::OpenOptions;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::time::Duration;
use tokio::time::timeout;

const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_RETRIES_PER_URL: usize = 2;

#[derive(Debug, Clone, Serialize)]
pub struct DownloadProgress {
    pub bytes_done: u64,
    pub bytes_total: u64,
    pub source_url: String,
    pub stage: &'static str,
    pub message: Option<String>,
}

/// Probe all mirrors in parallel, picking the first one that returns 200.
async fn probe(client: &Client, urls: &[String]) -> Option<String> {
    let probes = urls.iter().cloned().map(|u| {
        let client = client.clone();
        async move {
            let send = timeout(PROBE_TIMEOUT, client.head(&u).send()).await.ok()?;
            let resp = send.ok()?;
            if resp.status().is_success() {
                Some(u)
            } else {
                None
            }
        }
    });

    let results = futures::future::join_all(probes).await;
    results.into_iter().flatten().next()
}

/// Download a single mirror URL into `target` with Range-resume.
/// Returns the byte count actually read in this call (excluding any pre-existing partial).
async fn download_from(
    client: &Client,
    url: &str,
    target: &Path,
    expected_total: Option<u64>,
    on_progress: &mut (dyn FnMut(DownloadProgress) + Send),
) -> Result<(), String> {
    let part_path = target.with_extension(
        target.extension()
            .map(|e| format!("{}.part", e.to_string_lossy()))
            .unwrap_or_else(|| "part".into()),
    );

    let mut file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(&part_path)
        .map_err(|e| format!("open part file: {e}"))?;

    let already_have = file.metadata().map(|m| m.len()).unwrap_or(0);
    file.seek(SeekFrom::End(0)).ok();

    let mut req = client.get(url);
    if already_have > 0 {
        req = req.header("Range", format!("bytes={}-", already_have));
    }

    let resp = req.send().await.map_err(|e| format!("GET {url}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {} from {url}", resp.status()));
    }

    let total = resp
        .content_length()
        .map(|len| already_have + len)
        .or(expected_total);

    let mut bytes_done = already_have;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("stream: {e}"))?;
        file.write_all(&chunk).map_err(|e| format!("write: {e}"))?;
        bytes_done += chunk.len() as u64;

        on_progress(DownloadProgress {
            bytes_done,
            bytes_total: total.unwrap_or(0),
            source_url: url.to_string(),
            stage: "downloading",
            message: None,
        });
    }
    file.flush().map_err(|e| format!("flush: {e}"))?;
    drop(file);

    // Atomically rename .part to final path.
    std::fs::rename(&part_path, target).map_err(|e| format!("rename: {e}"))?;
    Ok(())
}

/// Verify a file's SHA-256 against the expected digest.
pub fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = std::fs::File::open(path).map_err(|e| format!("open {path:?}: {e}"))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 8192];
    loop {
        let n = file.read(&mut buf).map_err(|e| format!("read: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex(&hasher.finalize()))
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(s, "{:02x}", b);
    }
    s
}

/// High-level download: probe mirrors → download with resume → verify SHA-256.
/// Tries each mirror up to MAX_RETRIES_PER_URL times before falling back.
pub async fn download_model(
    meta: &ModelMeta,
    target: &Path,
    mut on_progress: impl FnMut(DownloadProgress) + Send,
) -> Result<(), String> {
    let client = Client::builder()
        .timeout(Duration::from_secs(60))
        .user_agent("NewMob/0.1 (model-downloader)")
        .build()
        .map_err(|e| e.to_string())?;

    on_progress(DownloadProgress {
        bytes_done: 0,
        bytes_total: meta.size_mb * 1024 * 1024,
        source_url: String::new(),
        stage: "probing",
        message: Some(format!("Probing {} mirror(s)...", meta.urls.len())),
    });

    // Try probed mirrors first, then fall through to others if probe failed.
    let mut tried: Vec<String> = Vec::new();
    let probed = probe(&client, &meta.urls).await;
    let order: Vec<String> = match probed {
        Some(first) => {
            let mut rest: Vec<String> = meta.urls.iter().filter(|u| **u != first).cloned().collect();
            let mut all = vec![first];
            all.append(&mut rest);
            all
        }
        None => meta.urls.clone(),
    };

    let mut last_err: Option<String> = None;
    for url in &order {
        tried.push(url.clone());
        let mut url_err = None;
        for attempt in 1..=MAX_RETRIES_PER_URL {
            match download_from(
                &client,
                url,
                target,
                Some(meta.size_mb * 1024 * 1024),
                &mut on_progress,
            )
            .await
            {
                Ok(()) => {
                    on_progress(DownloadProgress {
                        bytes_done: 0,
                        bytes_total: 0,
                        source_url: url.clone(),
                        stage: "verifying",
                        message: Some("Verifying SHA-256...".into()),
                    });

                    let placeholder = "0".repeat(64);
                    if meta.sha256 == placeholder {
                        // Manifest is a placeholder — skip strict verification.
                        on_progress(DownloadProgress {
                            bytes_done: 0,
                            bytes_total: 0,
                            source_url: url.clone(),
                            stage: "done",
                            message: Some("Downloaded (no checksum in manifest)".into()),
                        });
                        return Ok(());
                    }

                    let digest = sha256_file(target)?;
                    if digest.eq_ignore_ascii_case(&meta.sha256) {
                        on_progress(DownloadProgress {
                            bytes_done: 0,
                            bytes_total: 0,
                            source_url: url.clone(),
                            stage: "done",
                            message: Some("Verified".into()),
                        });
                        return Ok(());
                    } else {
                        // Bad digest — delete and try next mirror.
                        let _ = std::fs::remove_file(target);
                        url_err = Some(format!(
                            "SHA-256 mismatch (got {digest}, expected {})",
                            meta.sha256
                        ));
                        break; // do not retry same URL on digest mismatch
                    }
                }
                Err(e) => {
                    url_err = Some(format!("{url} attempt {attempt}: {e}"));
                    if attempt < MAX_RETRIES_PER_URL {
                        tokio::time::sleep(Duration::from_secs(1)).await;
                    }
                }
            }
        }
        last_err = url_err.clone().or(last_err);
    }

    Err(format!(
        "All {} mirror(s) failed. Last error: {}",
        tried.len(),
        last_err.unwrap_or_else(|| "unknown".into())
    ))
}
