//! HTTP transport and resume policy application.

use super::integrity::{self, MAX_PACKAGE_BYTES};
use super::*;
use futures::StreamExt;
use rustls_platform_verifier::BuilderVerifierExt;
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
        let proxy = match route {
            ProxyRoute::NoProxy => None,
            ProxyRoute::Application(endpoint) | ProxyRoute::Feature(endpoint) => {
                validate_endpoint(endpoint)?;
                let scheme = match endpoint.kind {
                    ProxyKind::Http => "http",
                    ProxyKind::Socks5 => "socks5h",
                };
                Some(
                    reqwest::Proxy::all(format!(
                        "{scheme}://{}:{}",
                        endpoint.host.trim(),
                        endpoint.port
                    ))
                    .map_err(|error| DownloadError::Http(error.to_string()))?,
                )
            }
        };
        Self::with_explicit_proxy(proxy)
    }

    /// Settings resolves session/manual credentials in the core. Accept its
    /// explicit proxy without importing Vault or AppState into the transport.
    /// An absent proxy always bypasses environment/system proxy discovery.
    pub fn with_explicit_proxy(proxy: Option<reqwest::Proxy>) -> Result<Self, DownloadError> {
        let mut builder = reqwest::Client::builder()
            .tls_backend_preconfigured(download_tls_config()?)
            .no_proxy()
            .connect_timeout(Duration::from_secs(20))
            .read_timeout(Duration::from_secs(30))
            .no_gzip()
            .no_brotli()
            .no_deflate()
            .no_zstd();
        if let Some(proxy) = proxy {
            builder = builder.proxy(proxy);
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
            .header(reqwest::header::ACCEPT_ENCODING, "identity")
            .send()
            .await
            .map_err(|error| DownloadError::Http(error.to_string()))?;
        let status = response.status();
        if !status.is_success() {
            return Err(DownloadError::UnexpectedStatus(status.as_u16()));
        }
        validate_encoding(&response)?;
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
        let result = self.transfer(&request, &task, &cancellation).await;
        if let Err(error) = &result {
            if matches!(error, DownloadError::Cancelled) {
                cancel_task(&task).await;
            } else {
                let downloaded = task.lock().await.snapshot().downloaded;
                fail_task(&task, downloaded, error).await;
            }
        }
        result
    }

    async fn transfer(
        &self,
        request: &DownloadRequest,
        task: &Arc<Mutex<DownloadTask>>,
        cancellation: &CancellationToken,
    ) -> Result<DownloadResult, DownloadError> {
        integrity::validate_request(request)?;
        integrity::check_cancelled(cancellation)?;
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
        if existing_len > MAX_PACKAGE_BYTES
            || request
                .expected_total
                .is_some_and(|total| existing_len > total)
        {
            return Err(DownloadError::Integrity(
                "partial file exceeds expected package size".into(),
            ));
        }
        // The process may have stopped after the last byte but before verify
        // or publication. Do not request an unsatisfiable Range past EOF.
        if request.expected_total == Some(existing_len)
            && request.expected_sha256.is_some()
            && request.partial_path.exists()
        {
            return self
                .complete(request, task, cancellation, existing_len, true)
                .await;
        }
        let mut builder = self
            .client
            .get(&request.url)
            .header(reqwest::header::ACCEPT_ENCODING, "identity");
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
        validate_encoding(&response)?;
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
        let (offset, total, response_bytes) = integrity::response_sizes(
            request.expected_total,
            decision,
            content_range,
            content_length,
        )?;
        if matches!(decision, ResumeDecision::Append { .. })
            && total.is_none()
            && request.expected_sha256.is_none()
        {
            return Err(DownloadError::Integrity(
                "a partial response with unknown total requires the expected SHA-256".into(),
            ));
        }
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
        let transfer_result = async {
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
                let next = downloaded
                    .checked_add(chunk.len() as u64)
                    .ok_or_else(|| DownloadError::Integrity("package size overflow".into()))?;
                if next > MAX_PACKAGE_BYTES
                    || total.is_some_and(|total| next > total)
                    || response_bytes.is_some_and(|bytes| next - offset > bytes)
                {
                    return Err(DownloadError::Integrity(
                        "response exceeds declared package size".into(),
                    ));
                }
                file.write_all(&chunk).await?;
                downloaded = next;
                set_task_phase(&task, DownloadPhase::Downloading, downloaded, None, total).await?;
            }
            Ok::<(), DownloadError>(())
        }
        .await;
        // Stop the connection before waiting for disk work. Tokio File writes
        // can still be running after write_all; drain them even on cancellation
        // or HTTP failure before the manager releases its reservations.
        drop(body);
        let persisted = match file.flush().await {
            Ok(()) => file.sync_all().await,
            Err(error) => Err(error),
        };
        drop(file);
        transfer_result?;
        persisted?;
        if response_bytes.is_some_and(|bytes| downloaded - offset != bytes) {
            return Err(DownloadError::Integrity(
                "response length does not match Content-Range".into(),
            ));
        }
        if let Some(expected) = total {
            if downloaded != expected {
                let error = DownloadError::IncompleteCompletion {
                    downloaded,
                    total: expected,
                };
                fail_task(&task, downloaded, &error).await;
                return Err(error);
            }
        }
        self.complete(
            request,
            task,
            cancellation,
            downloaded,
            matches!(decision, ResumeDecision::Append { .. }),
        )
        .await
    }

    async fn complete(
        &self,
        request: &DownloadRequest,
        task: &Arc<Mutex<DownloadTask>>,
        cancellation: &CancellationToken,
        downloaded: u64,
        resumed: bool,
    ) -> Result<DownloadResult, DownloadError> {
        let total = task
            .lock()
            .await
            .snapshot()
            .total
            .or(request.expected_total);
        set_task_phase(task, DownloadPhase::Verifying, downloaded, None, total).await?;
        integrity::verify_file(
            &request.partial_path,
            request.expected_sha256.as_deref(),
            cancellation,
        )
        .await?;
        // Cancellation and publication share the task's terminal-state lock.
        // A cancel that observes Completed cannot revoke a valid publication.
        let mut terminal = task.lock().await;
        integrity::check_cancelled(cancellation)?;
        if terminal.is_cancelled() {
            return Err(DownloadError::Cancelled);
        }
        integrity::publish(&request.partial_path, &request.completed_path).await?;
        terminal.update(DownloadPhase::Completed, downloaded, None)?;
        Ok(DownloadResult {
            path: request.completed_path.clone(),
            bytes: downloaded,
            resumed,
        })
    }
}

fn download_tls_config() -> Result<rustls::ClientConfig, DownloadError> {
    // The AWS-LC entropy initializer can abort during a background HTTPS
    // check on macOS Intel VMs. Use ring's OS randomness for this client.
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .and_then(BuilderVerifierExt::with_platform_verifier)
        .map_err(|error| DownloadError::Http(error.to_string()))?
        .with_no_client_auth();
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(config)
}

#[cfg(test)]
#[test]
fn download_tls_uses_ring_even_when_reqwest_includes_aws_lc() {
    let config = download_tls_config().unwrap();
    assert_eq!(
        format!("{:?}", config.crypto_provider().secure_random),
        format!(
            "{:?}",
            rustls::crypto::ring::default_provider().secure_random
        ),
    );
}

fn validate_encoding(response: &reqwest::Response) -> Result<(), DownloadError> {
    for value in response
        .headers()
        .get_all(reqwest::header::CONTENT_ENCODING)
    {
        if !value
            .to_str()
            .is_ok_and(|value| value.trim().eq_ignore_ascii_case("identity"))
        {
            return Err(DownloadError::Integrity(
                "encoded package responses cannot be resumed safely".into(),
            ));
        }
    }
    Ok(())
}
