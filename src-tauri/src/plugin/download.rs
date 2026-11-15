//! Pure download policy and progress primitives for module installation.
//!
//! The actual HTTP client is intentionally outside this module.  These types
//! decide which proxy route may be used, whether a response can resume a
//! partial file, and what progress/cancellation state the UI should observe.

use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

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

#[derive(Debug, Error)]
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
    #[error("module download URL is invalid: {0}")]
    InvalidUrl(String),
    #[error("module download HTTP request failed: {0}")]
    Http(String),
    #[error("module download file operation failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("module download output already exists: {0}")]
    OutputExists(String),
    #[error("module download task is already active: {0}")]
    AlreadyActive(String),
    #[error("module download path is invalid: {0}")]
    InvalidPath(String),
    #[error("module catalogue is invalid: {0}")]
    InvalidCatalog(String),
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

    fn set_total(&mut self, total: Option<u64>) {
        if self.progress.total.is_none() {
            self.progress.total = total;
        }
    }
}

/// A verified, resumable module download request.
///
/// `partial_path` and `completed_path` must be separate files.  The service
/// only renames the partial file after the response has been fully consumed,
/// so an interrupted or cancelled transfer cannot replace a working module.
#[derive(Debug, Clone)]
pub struct DownloadRequest {
    pub id: String,
    pub url: String,
    pub partial_path: PathBuf,
    pub completed_path: PathBuf,
    pub expected_total: Option<u64>,
    pub proxy: ProxyRoute,
}

pub mod catalog;
pub use catalog::{ModuleCatalog, ModuleCatalogAsset, ModuleCatalogPlugin};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DownloadResult {
    pub path: PathBuf,
    pub bytes: u64,
    pub resumed: bool,
}

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
        let bytes = response
            .bytes()
            .await
            .map_err(|error| DownloadError::Http(error.to_string()))?;
        let catalog: ModuleCatalog = serde_json::from_slice(&bytes)
            .map_err(|error| DownloadError::InvalidCatalog(error.to_string()))?;
        catalog.validate(expected_core_api)?;
        Ok(catalog)
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

/// Background task manager used by native commands and future renderer task
/// restoration.  A task remains in the map after completion so the UI can
/// reopen its final state; callers can explicitly forget it later.
#[derive(Clone)]
pub struct DownloadManager {
    service: HttpDownloadService,
    tasks: Arc<Mutex<std::collections::HashMap<String, Arc<Mutex<DownloadTask>>>>>,
    cancellations: Arc<Mutex<std::collections::HashMap<String, CancellationToken>>>,
}

impl DownloadManager {
    pub fn new(service: HttpDownloadService) -> Self {
        Self {
            service,
            tasks: Arc::new(Mutex::new(std::collections::HashMap::new())),
            cancellations: Arc::new(Mutex::new(std::collections::HashMap::new())),
        }
    }

    pub async fn start(&self, request: DownloadRequest) -> Result<DownloadHandle, DownloadError> {
        self.start_with_service(request, self.service.clone()).await
    }

    pub async fn start_with_route(
        &self,
        request: DownloadRequest,
        route: ProxyRoute,
    ) -> Result<DownloadHandle, DownloadError> {
        let service = HttpDownloadService::new(&route)?;
        self.start_with_service(request, service).await
    }

    async fn start_with_service(
        &self,
        request: DownloadRequest,
        service: HttpDownloadService,
    ) -> Result<DownloadHandle, DownloadError> {
        let mut tasks = self.tasks.lock().await;
        if tasks.contains_key(&request.id) {
            return Err(DownloadError::AlreadyActive(request.id));
        }
        let total = request.expected_total;
        let task = Arc::new(Mutex::new(DownloadTask::new(request.id.clone(), total)));
        tasks.insert(request.id.clone(), Arc::clone(&task));
        drop(tasks);
        let token = CancellationToken::new();
        self.cancellations
            .lock()
            .await
            .insert(request.id.clone(), token.clone());
        let task_for_worker = Arc::clone(&task);
        let token_for_worker = token.clone();
        let join = tokio::spawn(async move {
            service
                .download(request, task_for_worker, token_for_worker)
                .await
        });
        let id = task.lock().await.id.clone();
        Ok(DownloadHandle {
            id,
            task,
            cancellation: token,
            join,
        })
    }

    pub async fn snapshot(&self, id: &str) -> Option<DownloadProgress> {
        let task = self.tasks.lock().await.get(id).cloned()?;
        Some(task.lock().await.snapshot().clone())
    }

    pub async fn forget(&self, id: &str) {
        self.tasks.lock().await.remove(id);
        self.cancellations.lock().await.remove(id);
    }

    pub async fn cancel(&self, id: &str) -> Result<DownloadProgress, DownloadError> {
        let token = self
            .cancellations
            .lock()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| DownloadError::InvalidPath(format!("unknown download task: {id}")))?;
        token.cancel();
        self.snapshot(id)
            .await
            .ok_or_else(|| DownloadError::InvalidPath(format!("unknown download task: {id}")))
    }
}

pub struct DownloadHandle {
    pub id: String,
    task: Arc<Mutex<DownloadTask>>,
    cancellation: CancellationToken,
    join: JoinHandle<Result<DownloadResult, DownloadError>>,
}

impl DownloadHandle {
    pub async fn snapshot(&self) -> DownloadProgress {
        self.task.lock().await.snapshot().clone()
    }

    pub fn cancel(&self) {
        self.cancellation.cancel();
    }

    pub async fn wait(self) -> Result<DownloadResult, DownloadError> {
        match self.join.await {
            Ok(result) => result,
            Err(error) => Err(DownloadError::Http(format!(
                "download task join failed: {error}"
            ))),
        }
    }
}

fn validate_download_paths(partial: &Path, completed: &Path) -> Result<(), DownloadError> {
    if partial.as_os_str().is_empty() || completed.as_os_str().is_empty() {
        return Err(DownloadError::InvalidPath(
            "download paths must be non-empty".into(),
        ));
    }
    if partial == completed {
        return Err(DownloadError::InvalidPath(
            "partial and completed paths must differ".into(),
        ));
    }
    Ok(())
}

async fn set_task_phase(
    task: &Arc<Mutex<DownloadTask>>,
    phase: DownloadPhase,
    downloaded: u64,
    error: Option<String>,
    total: Option<u64>,
) -> Result<(), DownloadError> {
    let mut guard = task.lock().await;
    guard.set_total(total);
    guard.update(phase, downloaded, error)
}

async fn cancel_task(task: &Arc<Mutex<DownloadTask>>) {
    task.lock().await.cancel();
}

async fn fail_task(task: &Arc<Mutex<DownloadTask>>, downloaded: u64, error: &DownloadError) {
    let mut guard = task.lock().await;
    let _ = guard.update(DownloadPhase::Failed, downloaded, Some(error.to_string()));
}

#[cfg(test)]
#[path = "download_tests.rs"]
mod tests;
