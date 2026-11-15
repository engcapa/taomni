//! HTTP transport and resume policy application.

use super::*;
use futures::StreamExt;
use std::time::Duration;
use tokio::io::AsyncWriteExt;

/// Native HTTP implementation for plugin packages.
///
/// The client is deliberately constructed from a resolved `ProxyRoute`.
/// `NoProxy` calls reqwest's `no_proxy()` so environment and system proxy
/// variables cannot silently alter the selected route.
#[derive(Clone)]
pub struct HttpDownloadService {
    client: reqwest::Client,
}

impl HttpDownloadService {
    pub fn new(route: &ProxyRoute) -> Result<Self, DownloadError> {
        let mut builder = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(20))
            .timeout(Duration::from_secs(30));
        match route {
            ProxyRoute::NoProxy => {
                builder = builder.no_proxy();
            }
            ProxyRoute::Application(endpoint) | ProxyRoute::Feature(endpoint) => {
                validate_endpoint(endpoint)?;
                let scheme = match endpoint.kind {
                    ProxyKind::Http => "http",
                    ProxyKind::Socks5 => "socks5h",
                };
                let proxy = reqwest::Proxy::all(format!(
                    "{scheme}://{}:{}",
                    endpoint.host.trim(),
                    endpoint.port
                ))
                .map_err(|error| DownloadError::Http(error.to_string()))?;
                builder = builder.no_proxy().proxy(proxy);
            }
        }
        builder
            .build()
            .map(|client| Self { client })
            .map_err(|error| DownloadError::Http(error.to_string()))
    }

    /// Fetch and structurally validate a remote module catalogue. The caller
    /// must still verify the detached `modules.json.minisig` before installing
    /// any package; this method only handles HTTP/proxy transport and schema
    /// validation.
    pub async fn fetch_catalog(
        &self,
        url: &str,
        expected_core_api: &str,
    ) -> Result<ModuleCatalog, DownloadError> {
        let bytes = self.fetch_metadata(url, 4 * 1024 * 1024).await?;
        let catalog: ModuleCatalog = serde_json::from_slice(&bytes)
            .map_err(|error| DownloadError::InvalidCatalog(error.to_string()))?;
        catalog.validate(expected_core_api)?;
        Ok(catalog)
    }

    /// Bound metadata before buffering even when Content-Length is absent.
    /// Package downloads use the streaming path below instead.
    pub async fn fetch_metadata(&self, url: &str, limit: usize) -> Result<Vec<u8>, DownloadError> {
        let parsed = reqwest::Url::parse(url)
            .map_err(|error| DownloadError::InvalidUrl(error.to_string()))?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err(DownloadError::InvalidUrl(format!(
                "unsupported catalogue URL scheme: {}",
                parsed.scheme()
            )));
        }
        let response = self
            .client
            .get(parsed)
            .send()
            .await
            .map_err(|error| DownloadError::Http(error.to_string()))?;
        let status = response.status();
        if !status.is_success() {
            return Err(DownloadError::UnexpectedStatus(status.as_u16()));
        }
        if response
            .content_length()
            .is_some_and(|length| length > limit as u64)
        {
            return Err(DownloadError::InvalidCatalog(
                "metadata exceeds size limit".into(),
            ));
        }
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| DownloadError::Http(error.to_string()))?;
            if bytes.len().saturating_add(chunk.len()) > limit {
                return Err(DownloadError::InvalidCatalog(
                    "metadata exceeds size limit".into(),
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }

    /// Download a package in the current async task, retaining a partial file
    /// when cancelled or when the response fails validation.
    pub async fn download(
        &self,
        request: DownloadRequest,
        task: Arc<Mutex<DownloadTask>>,
        cancellation: CancellationToken,
    ) -> Result<DownloadResult, DownloadError> {
        validate_download_paths(&request.partial_path, &request.completed_path)?;
        if request.completed_path.exists() {
            return Err(DownloadError::OutputExists(
                request.completed_path.display().to_string(),
            ));
        }
        if let Some(parent) = request.partial_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        if let Some(parent) = request.completed_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let existing_len = match tokio::fs::metadata(&request.partial_path).await {
            Ok(metadata) => metadata.len(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
            Err(error) => return Err(error.into()),
        };
        let mut builder = self.client.get(&request.url);
        if existing_len > 0 {
            builder = builder.header(reqwest::header::RANGE, format!("bytes={existing_len}-"));
        }
        set_task_phase(
            &task,
            DownloadPhase::Connecting,
            existing_len,
            None,
            request.expected_total,
        )
        .await?;
        let response = tokio::select! {
            _ = cancellation.cancelled() => {
                cancel_task(&task).await;
                return Err(DownloadError::Cancelled);
            }
            result = builder.send() => result.map_err(|error| DownloadError::Http(error.to_string()))?,
        };
        let status = response.status().as_u16();
        let content_length = response.content_length();
        let content_range = response
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|value| value.to_str().ok());
        let decision = match validate_resume_response(
            existing_len,
            request.expected_total,
            status,
            content_range,
            content_length,
        ) {
            Ok(decision) => decision,
            Err(error) => {
                fail_task(&task, existing_len, &error).await;
                return Err(error);
            }
        };
        let total = request.expected_total.or_else(|| {
            content_range
                .and_then(|header| parse_content_range(header).ok())
                .and_then(|range| range.total)
                .or_else(|| content_length.map(|length| existing_len.saturating_add(length)))
        });
        let offset = match decision {
            ResumeDecision::Append { offset } => offset,
            ResumeDecision::Restart | ResumeDecision::Fresh => 0,
        };
        set_task_phase(&task, DownloadPhase::Downloading, offset, None, total).await?;
        let append = matches!(decision, ResumeDecision::Append { .. });
        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(!append)
            .append(append)
            .open(&request.partial_path)
            .await?;
        let mut downloaded = offset;
        let mut body = response.bytes_stream();
        while let Some(chunk) = tokio::select! {
            _ = cancellation.cancelled() => {
                cancel_task(&task).await;
                return Err(DownloadError::Cancelled);
            }
            chunk = body.next() => chunk,
        } {
            let chunk = match chunk {
                Ok(chunk) => chunk,
                Err(error) => {
                    let wrapped = DownloadError::Http(error.to_string());
                    fail_task(&task, downloaded, &wrapped).await;
                    return Err(wrapped);
                }
            };
            if cancellation.is_cancelled() {
                cancel_task(&task).await;
                return Err(DownloadError::Cancelled);
            }
            file.write_all(&chunk).await?;
            downloaded = downloaded.saturating_add(chunk.len() as u64);
            set_task_phase(&task, DownloadPhase::Downloading, downloaded, None, total).await?;
        }
        file.flush().await?;
        file.sync_all().await?;
        if let Some(expected) = total {
            if downloaded < expected {
                let error = DownloadError::IncompleteCompletion {
                    downloaded,
                    total: expected,
                };
                fail_task(&task, downloaded, &error).await;
                return Err(error);
            }
        }
        set_task_phase(&task, DownloadPhase::Verifying, downloaded, None, total).await?;
        if request.completed_path.exists() {
            return Err(DownloadError::OutputExists(
                request.completed_path.display().to_string(),
            ));
        }
        tokio::fs::rename(&request.partial_path, &request.completed_path).await?;
        set_task_phase(&task, DownloadPhase::Completed, downloaded, None, total).await?;
        Ok(DownloadResult {
            path: request.completed_path,
            bytes: downloaded,
            resumed: matches!(decision, ResumeDecision::Append { .. }),
        })
    }
}
