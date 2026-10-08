//! ASR installation is explicit, serialized and verified before atomic publication.
use super::catalog::{self, MODELS};
use crate::{
    proxy::{AppProxyConfig, ResolvedProxy},
    state::AppState,
};
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::Emitter;
use tokio_util::sync::CancellationToken;
static INSTALL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Clone, Serialize, Debug)]
pub struct InstallationProgress {
    revision: u64,
    job_id: String,
    model_id: String,
    bytes: u64,
    total: u64,
    phase: &'static str,
    error: Option<String>,
}
#[derive(Default)]
struct InstallationTracker(std::sync::Mutex<Option<InstallationProgress>>);
impl InstallationTracker {
    fn snapshot(&self) -> Option<InstallationProgress> {
        self.0.lock().unwrap().clone()
    }
    fn update(
        &self,
        model: &catalog::Model,
        job_id: &str,
        phase: &'static str,
        bytes: u64,
        error: Option<String>,
    ) -> InstallationProgress {
        let mut current = self.0.lock().unwrap();
        let next = InstallationProgress {
            revision: current.as_ref().map_or(1, |p| p.revision + 1),
            job_id: job_id.into(),
            model_id: model.id.into(),
            bytes: bytes.min(model.bytes),
            total: model.bytes,
            phase,
            error,
        };
        *current = Some(next.clone());
        next
    }
}
static INSTALLATION: InstallationTracker = InstallationTracker(std::sync::Mutex::new(None));
/// Retained in the backend, independently of the initiating window/component.
#[tauri::command]
pub fn voice_model_installation() -> Option<InstallationProgress> {
    INSTALLATION.snapshot()
}
static CANCELLATION: std::sync::Mutex<Option<(String, CancellationToken)>> =
    std::sync::Mutex::new(None);
#[tauri::command]
pub fn voice_cancel_model_installation(job_id: String) {
    if let Some((current, token)) = CANCELLATION.lock().unwrap().as_ref() {
        if current == &job_id {
            token.cancel();
        }
    }
}
#[tauri::command]
pub fn voice_cancel_sherpa_model_installation(job_id: String) {
    voice_cancel_model_installation(job_id);
}
struct InstallationReporter<'a> {
    app: &'a tauri::AppHandle,
    model: &'static catalog::Model,
    job_id: String,
    bytes: u64,
    finished: bool,
}
impl InstallationReporter<'_> {
    fn report(&mut self, phase: &'static str, bytes: u64, error: Option<String>) {
        self.bytes = bytes;
        self.finished = matches!(phase, "complete" | "failed" | "cancelled");
        let progress = INSTALLATION.update(self.model, &self.job_id, phase, bytes, error);
        let _ = self.app.emit("voice-model-progress", progress);
    }
}
impl Drop for InstallationReporter<'_> {
    fn drop(&mut self) {
        let mut cancellation = CANCELLATION.lock().unwrap();
        if cancellation
            .as_ref()
            .is_some_and(|(id, _)| id == &self.job_id)
        {
            cancellation.take();
        }
        if !self.finished {
            self.report(
                "failed",
                self.bytes,
                Some("Model installation interrupted".into()),
            );
        }
    }
}

/// A download takes one snapshot; changing settings affects the next download.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct DownloadProxyConfig {
    pub mode: String,
    pub custom: AppProxyConfig,
}
impl Default for DownloadProxyConfig {
    fn default() -> Self {
        Self {
            mode: "app".into(),
            custom: AppProxyConfig::default(),
        }
    }
}
fn selected_proxy_config(
    settings: &DownloadProxyConfig,
    app: AppProxyConfig,
) -> Result<Option<AppProxyConfig>, String> {
    let config = match settings.mode.as_str() {
        "none" => return Ok(None),
        "app" => app,
        "custom" => AppProxyConfig {
            enabled: true,
            ..settings.custom.clone()
        },
        _ => return Err("Unknown model download proxy mode".into()),
    };
    if !config.enabled {
        return Ok(None);
    }
    match config.mode.as_str() {
        "session" if !config.session_id.trim().is_empty() => {}
        "manual"
            if !config.host.trim().is_empty()
                && config.port > 0
                && ["http", "socks5"].contains(&config.kind.as_str()) => {}
        _ => return Err("Configure the model download proxy before downloading".into()),
    }
    Ok(Some(config))
}
fn download_client(proxy: Option<&ResolvedProxy>) -> Result<reqwest::Client, String> {
    // Always disable OS/environment auto-proxy. Only the selected route applies.
    let mut builder = reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(std::time::Duration::from_secs(20))
        .timeout(std::time::Duration::from_secs(1800));
    if let Some(proxy) = proxy {
        let url = proxy.to_url();
        // Resolve destination names at the SOCKS proxy, including HF redirects.
        let url = if proxy.kind == "socks5" {
            url.replacen("socks5://", "socks5h://", 1)
        } else {
            url
        };
        builder =
            builder.proxy(reqwest::Proxy::all(&url).map_err(|_| "Invalid model download proxy")?);
    }
    builder
        .build()
        .map_err(|_| "Cannot create model download client".into())
}
fn resolve_download_proxy(
    state: &AppState,
    settings: &DownloadProxyConfig,
) -> Result<Option<ResolvedProxy>, String> {
    let app = if settings.mode == "app" {
        AppProxyConfig::load(&crate::proxy::default_app_proxy_path())
    } else {
        AppProxyConfig::default()
    };
    let Some(config) = selected_proxy_config(settings, app)? else {
        return Ok(None);
    };
    crate::proxy::resolve(state, &config)?
        .map(Some)
        .ok_or_else(|| "Selected model download proxy is unavailable".into())
}

#[derive(Serialize)]
pub struct ModelStatus {
    #[serde(flatten)]
    model: catalog::Model,
    installed: bool,
    download_url: String,
    resumable_bytes: u64,
    license: &'static str,
    catalog_version: &'static str,
    available_version: &'static str,
    installed_version: Option<String>,
    update_available: bool,
    integrity: &'static str,
}

pub const SHERPA_UPSTREAM_REVISION: &str = "98590b7ed6443e77b714204da2757d75e1a642f4";
const SHERPA_MODEL_ID: &str = "sherpa-zipformer-zh-en";
const SHERPA_FILES: &[(&str, u64, &str)] = &[
    (
        "encoder-epoch-99-avg-1.int8.onnx",
        181_895_032,
        "8fa764187a261844f859d7143ebaa563af5d10adfece4c18a8f414c88cba2a9b",
    ),
    (
        "decoder-epoch-99-avg-1.onnx",
        13_876_452,
        "2e3b5ec371f8899ee6acd829fd753ba45772df57a91bdf37cde3136354e7db7d",
    ),
    (
        "joiner-epoch-99-avg-1.int8.onnx",
        3_228_404,
        "1ed689c5ed19dbaa725d9d191bb4822b5f4855a39e1ffd28cbc1f340d25b2ee0",
    ),
    (
        "tokens.txt",
        56_317,
        "a8e0e4ec53810e433789b54a5c0134a7eaa2ffca595a6334d54c00da858841d3",
    ),
];

#[derive(Clone, Serialize)]
pub struct SherpaFileStatus {
    pub filename: &'static str,
    pub bytes: u64,
    pub downloaded: u64,
    pub installed: bool,
    pub sha256: &'static str,
}

#[derive(Clone, Serialize)]
pub struct SherpaModelStatus {
    pub model_id: &'static str,
    pub revision: &'static str,
    pub files: Vec<SherpaFileStatus>,
    pub total_bytes: u64,
    pub downloaded_bytes: u64,
    pub installed: bool,
}

pub(crate) fn sherpa_model_dir() -> std::path::PathBuf {
    if let Ok(path) = std::env::var("TAOMNI_SHERPA_MODEL_DIR") {
        return std::path::PathBuf::from(path);
    }
    crate::resolved_cache_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("taomni/models/sherpa-zipformer-zh-en")
}

fn sherpa_file_status() -> SherpaModelStatus {
    let dir = sherpa_model_dir();
    let files = SHERPA_FILES
        .iter()
        .map(|(filename, bytes, sha256)| {
            let path = dir.join(filename);
            let part = dir.join(format!("{filename}.part"));
            let downloaded = std::fs::metadata(&part)
                .map(|m| m.len())
                .unwrap_or(0)
                .min(*bytes);
            let installed = std::fs::metadata(&path)
                .map(|m| m.len() == *bytes)
                .unwrap_or(false)
                && crate::models::downloader::sha256_file(&path)
                    .map(|hash| hash == *sha256)
                    .unwrap_or(false);
            SherpaFileStatus {
                filename,
                bytes: *bytes,
                downloaded,
                installed,
                sha256,
            }
        })
        .collect::<Vec<_>>();
    SherpaModelStatus {
        model_id: SHERPA_MODEL_ID,
        revision: SHERPA_UPSTREAM_REVISION,
        total_bytes: files.iter().map(|f| f.bytes).sum(),
        downloaded_bytes: files
            .iter()
            .map(|f| if f.installed { f.bytes } else { f.downloaded })
            .sum(),
        installed: files.iter().all(|f| f.installed),
        files,
    }
}

#[tauri::command]
pub fn voice_sherpa_model_status() -> SherpaModelStatus {
    sherpa_file_status()
}

#[derive(Clone, Serialize)]
pub struct SherpaInstallationProgress {
    pub revision: u64,
    pub job_id: String,
    pub model_id: &'static str,
    pub bytes: u64,
    pub total: u64,
    pub phase: &'static str,
    pub file: Option<String>,
    pub error: Option<String>,
}
static SHERPA_PROGRESS: std::sync::Mutex<Option<SherpaInstallationProgress>> =
    std::sync::Mutex::new(None);
fn sherpa_progress(
    app: &tauri::AppHandle,
    job_id: &str,
    phase: &'static str,
    bytes: u64,
    file: Option<String>,
    error: Option<String>,
) {
    let mut guard = SHERPA_PROGRESS.lock().unwrap();
    let progress = SherpaInstallationProgress {
        revision: guard.as_ref().map_or(1, |p| p.revision + 1),
        job_id: job_id.into(),
        model_id: SHERPA_MODEL_ID,
        bytes,
        total: SHERPA_FILES.iter().map(|(_, n, _)| *n).sum(),
        phase,
        file,
        error,
    };
    *guard = Some(progress.clone());
    let _ = app.emit("voice-sherpa-model-progress", progress);
}

#[tauri::command]
pub fn voice_sherpa_model_installation() -> Option<SherpaInstallationProgress> {
    SHERPA_PROGRESS.lock().unwrap().clone()
}

#[tauri::command]
pub async fn voice_install_sherpa_model(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let _lock = INSTALL
        .try_lock()
        .map_err(|_| "A model installation is already running")?;
    let job_id = uuid::Uuid::new_v4().to_string();
    let cancel = CancellationToken::new();
    *CANCELLATION.lock().unwrap() = Some((job_id.clone(), cancel.clone()));
    let dir = sherpa_model_dir();
    let result = async {
        tokio::fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;
        let settings = state.ai_ctx.read().await.config.asr.download_proxy.clone();
        let proxy = resolve_download_proxy(&state, &settings)?;
        let client = download_client(proxy.as_ref())?;
        let mut completed = 0u64;
        for (filename, bytes, sha256) in SHERPA_FILES {
            if cancel.is_cancelled() { return Err("CANCELLED".into()); }
            let target = dir.join(filename);
            if std::fs::metadata(&target).map(|m| m.len() == *bytes).unwrap_or(false)
                && crate::models::downloader::sha256_file(&target).is_ok_and(|hash| hash == *sha256) {
                completed += *bytes;
                continue;
            }
            let part = dir.join(format!("{filename}.part"));
            let url = format!("https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20/resolve/{SHERPA_UPSTREAM_REVISION}/{filename}?download=true");
            sherpa_progress(&app, &job_id, "connecting", completed, Some((*filename).into()), None);
            download_to_part(&client, &url, *bytes, &part, &cancel, |phase, bytes_done| {
                sherpa_progress(&app, &job_id, phase, completed + bytes_done, Some((*filename).into()), None);
            }).await?;
            sherpa_progress(&app, &job_id, "verifying", completed + *bytes, Some((*filename).into()), None);
            let actual = crate::models::downloader::sha256_file(&part)?;
            if actual != *sha256 {
                let _ = tokio::fs::remove_file(&part).await;
                return Err(format!("MODEL_CORRUPT: SHA-256 mismatch for {filename}"));
            }
            tokio::fs::rename(&part, &target).await.map_err(|e| e.to_string())?;
            completed += *bytes;
        }
        Ok::<(), String>(())
    }.await;
    CANCELLATION.lock().unwrap().take();
    match &result {
        Ok(()) => sherpa_progress(
            &app,
            &job_id,
            "complete",
            SHERPA_FILES.iter().map(|(_, n, _)| *n).sum(),
            None,
            None,
        ),
        Err(error) => sherpa_progress(
            &app,
            &job_id,
            if error == "CANCELLED" {
                "cancelled"
            } else {
                "failed"
            },
            sherpa_file_status().downloaded_bytes,
            None,
            (error != "CANCELLED").then(|| error.clone()),
        ),
    }
    result
}
fn inventory(m: &catalog::Model, root: &std::path::Path, verify: bool) -> ModelStatus {
    let target = catalog::version_path(root, m);
    let exists = target.is_file();
    let mut installed = std::fs::metadata(&target)
        .map(|v| v.len() == m.bytes)
        .unwrap_or(false);
    let integrity = if !exists {
        "missing"
    } else if !installed {
        "corrupt"
    } else if verify {
        if catalog::verify(m, &target).is_ok() {
            "verified"
        } else {
            installed = false;
            "corrupt"
        }
    } else {
        "unverified"
    };
    let previous = std::fs::read_dir(root.join(m.id))
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .find_map(|entry| {
            let version = entry.file_name().to_string_lossy().into_owned();
            if version != m.sha256
                && version.len() == 64
                && version.bytes().all(|b| b.is_ascii_hexdigit())
                && entry.path().join(m.filename).is_file()
            {
                Some(version)
            } else {
                None
            }
        });
    let legacy = root.join(m.id).join(m.filename).is_file();
    ModelStatus {
        model: m.clone(),
        download_url: catalog::download_url(m),
        resumable_bytes: std::fs::metadata(target.with_extension("bin.part"))
            .map(|v| v.len())
            .ok()
            .filter(|n| *n <= m.bytes)
            .unwrap_or(0),
        license: "MIT",
        catalog_version: catalog::CATALOG_VERSION,
        available_version: &m.sha256[..12],
        installed_version: if exists {
            Some(m.sha256[..12].into())
        } else {
            previous
                .as_ref()
                .map(|v| v[..12].into())
                .or_else(|| legacy.then(|| "legacy".into()))
        },
        update_available: !installed && (previous.is_some() || legacy),
        installed,
        integrity,
    }
}
#[tauri::command]
pub fn voice_models() -> Vec<ModelStatus> {
    let root = crate::models::store::models_root();
    MODELS.iter().map(|m| inventory(m, &root, false)).collect()
}
/// Explicit integrity/version check uses the catalog shipped with this app.
/// No unreviewed upstream revision or network source silently changes the model.
#[tauri::command]
pub async fn voice_check_models() -> Result<Vec<ModelStatus>, String> {
    let _lock = INSTALL
        .try_lock()
        .map_err(|_| "A model installation is already running")?;
    tokio::task::spawn_blocking(|| {
        let root = crate::models::store::models_root();
        MODELS.iter().map(|m| inventory(m, &root, true)).collect()
    })
    .await
    .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn voice_install_model(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    model_id: String,
    source_path: Option<String>,
) -> Result<(), String> {
    let _lock = INSTALL
        .try_lock()
        .map_err(|_| "A model installation is already running")?;
    let m = catalog::model(&model_id)?;
    let target = catalog::path(m);
    let offline = source_path.is_some();
    let part = target.with_extension(if offline {
        "bin.import.part"
    } else {
        "bin.part"
    });
    let cancel = CancellationToken::new();
    let job_id = uuid::Uuid::new_v4().to_string();
    *CANCELLATION.lock().unwrap() = Some((job_id.clone(), cancel.clone()));
    let mut reporter = InstallationReporter {
        app: &app,
        model: m,
        job_id,
        bytes: 0,
        finished: false,
    };
    reporter.report(
        if source_path.is_some() {
            "importing"
        } else {
            "connecting"
        },
        0,
        None,
    );
    let result: Result<(), String> = async {
        std::fs::create_dir_all(target.parent().ok_or("Invalid model directory")?)
            .map_err(|e| e.to_string())?;
        if let Some(source) = source_path {
            if tokio::fs::metadata(&source)
                .await
                .map_err(|e| e.to_string())?
                .len()
                != m.bytes
            {
                return Err("Incorrect model file size".into());
            }
            // Separate import scratch file preserves a paused network download.
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let mut input = tokio::fs::File::open(source)
                .await
                .map_err(|e| e.to_string())?;
            let mut output = tokio::fs::File::create(&part)
                .await
                .map_err(|e| e.to_string())?;
            let mut buffer = vec![0; 1024 * 1024];
            let mut bytes = 0;
            loop {
                let count = tokio::select! {
                    biased;
                    _ = cancel.cancelled() => return Err("CANCELLED".into()),
                    read = input.read(&mut buffer) => read.map_err(|e| e.to_string())?,
                };
                if count == 0 {
                    break;
                }
                bytes += count as u64;
                if bytes > m.bytes {
                    return Err("Model exceeds expected size".into());
                }
                output
                    .write_all(&buffer[..count])
                    .await
                    .map_err(|e| e.to_string())?;
                reporter.report("importing", bytes, None);
            }
            output.sync_all().await.map_err(|e| e.to_string())?;
        } else {
            let settings = state.ai_ctx.read().await.config.asr.download_proxy.clone();
            let proxy = resolve_download_proxy(&state, &settings)?;
            let client = download_client(proxy.as_ref())?;
            download_to_part(
                &client,
                &catalog::download_url(m),
                m.bytes,
                &part,
                &cancel,
                |phase, bytes| reporter.report(phase, bytes, None),
            )
            .await?;
        }
        if cancel.is_cancelled() {
            return Err("CANCELLED".into());
        }
        reporter.report("verifying", m.bytes, None);
        let install_target = target.clone();
        let install_part = part.clone();
        let verification_cancel = cancel.clone();
        tokio::task::spawn_blocking(move || {
            publish_verified_cancellable(
                m,
                &install_part,
                &install_target,
                Some(&verification_cancel),
            )
        })
        .await
        .map_err(|e| e.to_string())??;
        Ok(())
    }
    .await;
    if let Err(error) = &result {
        // Interrupted network transfers remain resumable; rejected weights do not.
        if offline || error.starts_with("MODEL_CORRUPT") {
            let _ = std::fs::remove_file(&part);
        }
        let bytes = std::fs::metadata(&part).map(|v| v.len()).unwrap_or(0);
        reporter.report(
            if error == "CANCELLED" {
                "cancelled"
            } else {
                "failed"
            },
            bytes,
            (error != "CANCELLED").then(|| error.clone()),
        );
    } else {
        if offline {
            let _ = std::fs::remove_file(target.with_extension("bin.part"));
        }
        reporter.report("complete", m.bytes, None);
    }
    result
}

/// Resume only against the immutable, hash-pinned artifact. Final SHA verification
/// is mandatory even if the server ignores Range and a full restart is needed.
async fn download_to_part(
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
fn publish_verified(
    m: &catalog::Model,
    part: &std::path::Path,
    target: &std::path::Path,
) -> Result<(), String> {
    publish_verified_cancellable(m, part, target, None)
}
fn publish_verified_cancellable(
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stale_download_cancel_does_not_stop_a_new_job() {
        let token = CancellationToken::new();
        *CANCELLATION.lock().unwrap() = Some(("new-job".into(), token.clone()));
        voice_cancel_model_installation("old-job".into());
        assert!(!token.is_cancelled());
        voice_cancel_model_installation("new-job".into());
        assert!(token.is_cancelled());
        CANCELLATION.lock().unwrap().take();
    }

    #[tokio::test]
    async fn download_range_resume_restart_and_invalid_range() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for (status, range, body, valid) in [
            (
                "206 Partial Content",
                "Content-Range: bytes 3-5/6\r\n",
                "def",
                true,
            ),
            ("200 OK", "", "abcdef", true),
            (
                "206 Partial Content",
                "Content-Range: bytes 2-5/6\r\n",
                "cdef",
                false,
            ),
        ] {
            let root = tempfile::tempdir().unwrap();
            let part = root.path().join("model.part");
            std::fs::write(&part, b"abc").unwrap();
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = [0; 4096];
                let count = socket.read(&mut request).await.unwrap();
                assert!(
                    String::from_utf8_lossy(&request[..count])
                        .to_lowercase()
                        .contains("range: bytes=3-")
                );
                socket.write_all(format!("HTTP/1.1 {status}\r\n{range}Content-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            });
            let result = download_to_part(
                &download_client(None).unwrap(),
                &format!("http://{addr}/model"),
                6,
                &part,
                &CancellationToken::new(),
                |_, _| {},
            )
            .await;
            server.await.unwrap();
            assert_eq!(result.is_ok(), valid, "{result:?}");
            assert_eq!(
                std::fs::read(part).unwrap(),
                if valid {
                    b"abcdef".as_slice()
                } else {
                    b"abc".as_slice()
                }
            );
        }
    }

    #[tokio::test]
    async fn cancelling_download_preserves_partial_and_allows_resume() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let root = tempfile::tempdir().unwrap();
        let part = root.path().join("model.part");
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let cancel = CancellationToken::new();
        let release_server = cancel.clone();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 2048];
            socket.read(&mut request).await.unwrap();
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\nabc")
                .await
                .unwrap();
            release_server.cancelled().await;
        });
        let signal = cancel.clone();
        let observed = part.clone();
        let cancellation = tokio::spawn(async move {
            tokio::time::timeout(std::time::Duration::from_secs(5), async {
                while tokio::fs::metadata(&observed)
                    .await
                    .map(|m| m.len())
                    .unwrap_or(0)
                    < 3
                {
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
            signal.cancel();
        });
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(6),
            download_to_part(
                &download_client(None).unwrap(),
                &format!("http://{addr}/model"),
                6,
                &part,
                &cancel,
                |_, _| {},
            ),
        )
        .await
        .unwrap();
        assert_eq!(result.unwrap_err(), "CANCELLED");
        cancellation.await.unwrap();
        server.await.unwrap();
        assert_eq!(std::fs::read(&part).unwrap(), b"abc");
        // The next request resumes the file produced by actual cancellation.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 2048];
            let count = socket.read(&mut request).await.unwrap();
            assert!(
                String::from_utf8_lossy(&request[..count])
                    .to_lowercase()
                    .contains("range: bytes=3-")
            );
            socket.write_all(b"HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 3-5/6\r\nContent-Length: 3\r\nConnection: close\r\n\r\ndef").await.unwrap();
        });
        download_to_part(
            &download_client(None).unwrap(),
            &format!("http://{addr}/model"),
            6,
            &part,
            &CancellationToken::new(),
            |_, _| {},
        )
        .await
        .unwrap();
        server.await.unwrap();
        assert_eq!(std::fs::read(&part).unwrap(), b"abcdef");
        let model = catalog::Model {
            id: "test",
            filename: "model.bin",
            bytes: 6,
            sha256: "bef57ec7f53a6d40beb640a780a639c83bc29ac8a9816f1fc6c5c6dcd93c4721",
        };
        let target = root.path().join("model.bin");
        assert!(publish_verified_cancellable(&model, &part, &target, Some(&cancel)).is_err());
        assert!(!target.exists());
        publish_verified(&model, &part, &target).unwrap();
        assert_eq!(std::fs::read(target).unwrap(), b"abcdef");
    }

    #[test]
    fn installation_snapshot_survives_observers_and_retains_terminal_results() {
        let tracker = InstallationTracker::default();
        let model = catalog::model("whisper-base").unwrap();
        assert!(tracker.snapshot().is_none());
        let connecting = tracker.update(model, "test-job", "connecting", 0, None);
        tracker.update(model, "test-job", "downloading", 1024, None);
        let reopened = tracker.snapshot().unwrap();
        assert_eq!(reopened.bytes, 1024);
        assert_eq!(reopened.phase, "downloading");
        assert!(reopened.revision > connecting.revision);
        let verifying = tracker.update(model, "test-job", "verifying", model.bytes, None);
        assert_eq!(verifying.phase, "verifying"); // 100% transfer is not completion.
        tracker.update(
            model,
            "test-job",
            "failed",
            1024,
            Some("connection lost".into()),
        );
        assert_eq!(
            tracker.snapshot().unwrap().error.as_deref(),
            Some("connection lost")
        );
        let retry = tracker.update(model, "test-job", "connecting", 0, None);
        assert!(retry.revision > verifying.revision);
        assert!(retry.error.is_none());
        tracker.update(model, "test-job", "complete", model.bytes, None);
        let completed = tracker.snapshot().unwrap();
        assert_eq!(completed.phase, "complete");
        assert_eq!(completed.bytes, completed.total);
        let status = inventory(model, tempfile::tempdir().unwrap().path(), false);
        assert_eq!(status.download_url, catalog::download_url(model));
        assert!(status.download_url.contains(catalog::UPSTREAM_REVISION));
        assert!(status.download_url.ends_with("ggml-base.bin?download=true"));
    }

    #[test]
    fn download_proxy_modes_do_not_fall_back_to_another_route() {
        let app = AppProxyConfig {
            enabled: true,
            host: "app-proxy".into(),
            ..Default::default()
        };
        let mut settings = DownloadProxyConfig::default();
        assert_eq!(
            selected_proxy_config(&settings, app.clone())
                .unwrap()
                .unwrap()
                .host,
            "app-proxy"
        );
        assert!(
            selected_proxy_config(&settings, AppProxyConfig::default())
                .unwrap()
                .is_none()
        );
        settings.mode = "none".into();
        assert!(
            selected_proxy_config(&settings, app.clone())
                .unwrap()
                .is_none()
        );
        settings.mode = "custom".into();
        assert!(selected_proxy_config(&settings, app.clone()).is_err());
        settings.custom.host = "custom-proxy".into();
        assert_eq!(
            selected_proxy_config(&settings, app.clone())
                .unwrap()
                .unwrap()
                .host,
            "custom-proxy"
        );
        settings.custom.mode = "session".into();
        assert!(selected_proxy_config(&settings, app.clone()).is_err());
        settings.custom.session_id = "saved-proxy".into();
        assert_eq!(
            selected_proxy_config(&settings, app)
                .unwrap()
                .unwrap()
                .session_id,
            "saved-proxy"
        );
        let legacy: DownloadProxyConfig = serde_json::from_str("{}").unwrap();
        assert_eq!(legacy.mode, "app");
        assert_eq!(
            serde_json::from_str::<DownloadProxyConfig>(&serde_json::to_string(&settings).unwrap())
                .unwrap(),
            settings
        );
    }

    #[tokio::test]
    async fn download_http_proxy_carries_redirected_requests() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            for destination in ["model.invalid", "cdn.invalid"] {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = vec![0; 4096];
                let count = socket.read(&mut request).await.unwrap();
                let request = String::from_utf8_lossy(&request[..count]);
                assert!(
                    request.starts_with(&format!("GET http://{destination}/weights ")),
                    "{request}"
                );
                let response = if destination == "model.invalid" {
                    "HTTP/1.1 302 Found\r\nLocation: http://cdn.invalid/weights\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                } else {
                    "HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nabc"
                };
                socket.write_all(response.as_bytes()).await.unwrap();
            }
        });
        let proxy = ResolvedProxy {
            kind: "http".into(),
            host: "127.0.0.1".into(),
            port,
            username: String::new(),
            password: String::new(),
        };
        let response = download_client(Some(&proxy))
            .unwrap()
            .get("http://model.invalid/weights")
            .send()
            .await
            .unwrap();
        assert_eq!(response.text().await.unwrap(), "abc");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn download_https_uses_connect_and_socks_uses_remote_dns() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            let count = socket.read(&mut request).await.unwrap();
            assert!(
                String::from_utf8_lossy(&request[..count])
                    .starts_with("CONNECT huggingface.co:443 HTTP/1.1")
            );
            socket
                .write_all(
                    b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await
                .unwrap();
        });
        let mut proxy = ResolvedProxy {
            kind: "http".into(),
            host: "127.0.0.1".into(),
            port,
            username: String::new(),
            password: String::new(),
        };
        assert!(
            download_client(Some(&proxy))
                .unwrap()
                .get("https://huggingface.co/weights")
                .send()
                .await
                .is_err()
        );
        server.await.unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        proxy.port = listener.local_addr().unwrap().port();
        proxy.kind = "socks5".into();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut greeting = [0; 2];
            socket.read_exact(&mut greeting).await.unwrap();
            assert_eq!(greeting[0], 5);
            let mut methods = vec![0; greeting[1] as usize];
            socket.read_exact(&mut methods).await.unwrap();
            socket.write_all(&[5, 0]).await.unwrap();
            let mut connect = [0; 5];
            socket.read_exact(&mut connect).await.unwrap();
            assert_eq!(&connect[..4], &[5, 1, 0, 3]); // Domain name, not local DNS.
            let mut host = vec![0; connect[4] as usize];
            socket.read_exact(&mut host).await.unwrap();
            assert_eq!(host, b"model.invalid");
            let mut port = [0; 2];
            socket.read_exact(&mut port).await.unwrap();
            assert_eq!(u16::from_be_bytes(port), 80);
            socket
                .write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 80])
                .await
                .unwrap();
            let mut request = [0; 2048];
            socket.read(&mut request).await.unwrap();
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nabc")
                .await
                .unwrap();
        });
        assert_eq!(
            download_client(Some(&proxy))
                .unwrap()
                .get("http://model.invalid/weights")
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap(),
            "abc"
        );
        server.await.unwrap();
    }

    #[test]
    fn download_no_proxy_ignores_environment() {
        // Isolate process environment from concurrent tests (no unsafe set_var).
        const CHILD: &str = "TAOMNI_TEST_DIRECT_DOWNLOAD_CHILD";
        if std::env::var_os(CHILD).is_none() {
            let result = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "asr::models::tests::download_no_proxy_ignores_environment",
                    "--nocapture",
                ])
                .env(CHILD, "1")
                .env("HTTP_PROXY", "http://127.0.0.1:1")
                .env("http_proxy", "http://127.0.0.1:1")
                .env("ALL_PROXY", "http://127.0.0.1:1")
                .env("all_proxy", "http://127.0.0.1:1")
                .env("NO_PROXY", "")
                .env("no_proxy", "")
                .output()
                .unwrap();
            assert!(
                result.status.success(),
                "{}",
                String::from_utf8_lossy(&result.stderr)
            );
            return;
        }
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut data = [0; 2048];
                socket.read(&mut data).await.unwrap();
                socket
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nabc",
                    )
                    .await
                    .unwrap();
            });
            assert_eq!(
                download_client(None)
                    .unwrap()
                    .get(format!("http://{addr}/weights"))
                    .send()
                    .await
                    .unwrap()
                    .text()
                    .await
                    .unwrap(),
                "abc"
            );
            server.await.unwrap();
        });
    }

    #[test]
    fn detects_catalog_updates_and_corruption_without_removing_old_versions() {
        let root = tempfile::tempdir().unwrap();
        let old = catalog::Model {
            id: "test",
            filename: "model.bin",
            bytes: 3,
            sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        };
        let current = catalog::Model {
            sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            ..old.clone()
        };
        let old_path = catalog::version_path(root.path(), &old);
        std::fs::create_dir_all(old_path.parent().unwrap()).unwrap();
        std::fs::write(&old_path, b"old").unwrap();
        let status = inventory(&current, root.path(), false);
        assert!(status.update_available);
        assert!(!status.installed);
        assert_eq!(status.installed_version.as_deref(), Some("aaaaaaaaaaaa"));
        let path = catalog::version_path(root.path(), &current);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"bad").unwrap();
        assert_eq!(inventory(&current, root.path(), true).integrity, "corrupt");
        assert_eq!(std::fs::read(&old_path).unwrap(), b"old");
        let part = path.with_extension("bin.part");
        std::fs::write(&part, b"bad").unwrap();
        assert!(publish_verified(&current, &part, &path).is_err());
        assert_eq!(std::fs::read(&old_path).unwrap(), b"old");
        assert_eq!(std::fs::read(&path).unwrap(), b"bad");
        std::fs::write(&part, b"abc").unwrap();
        publish_verified(&current, &part, &path).unwrap();
        assert!(!part.exists());
        let status = inventory(&current, root.path(), true);
        assert!(status.installed);
        assert!(!status.update_available);
        assert_eq!(status.integrity, "verified");
        assert_eq!(std::fs::read(&old_path).unwrap(), b"old");
    }
}
