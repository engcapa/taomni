use super::download::download_to_part;
use super::installation::CANCELLATION;
use super::installation::INSTALL;
use super::proxy::download_client;
use super::proxy::resolve_download_proxy;
use super::sherpa_inventory::SHERPA_FILES;
use super::sherpa_inventory::SHERPA_MODEL_ID;
use super::sherpa_inventory::SHERPA_REVISION_FILE;
use super::sherpa_inventory::SHERPA_UPSTREAM_REVISION;
use super::sherpa_inventory::sherpa_file_status;
use super::sherpa_inventory::sherpa_storage_dir;
use crate::state::AppState;
use futures::StreamExt;
use serde::Serialize;
use tauri::Emitter;
use tokio_util::sync::CancellationToken;

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
pub(super) static SHERPA_PROGRESS: std::sync::Mutex<Option<SherpaInstallationProgress>> =
    std::sync::Mutex::new(None);
pub(super) fn sherpa_progress(
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
    let dir = sherpa_storage_dir().join(SHERPA_UPSTREAM_REVISION);
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
            if !part.exists() {
                let legacy = sherpa_storage_dir().join(filename);
                let legacy_part = sherpa_storage_dir().join(format!("{filename}.part"));
                if std::fs::metadata(&legacy).is_ok_and(|m| m.len() == *bytes)
                    && crate::models::downloader::sha256_file(&legacy).is_ok_and(|hash| hash == *sha256) {
                    tokio::fs::copy(&legacy, &part).await.map_err(|e| e.to_string())?;
                } else if !dir.join(format!("{filename}.legacy-part-imported")).exists()
                    && std::fs::metadata(&legacy_part).is_ok_and(|m| m.len() <= *bytes) {
                    // Copy, never move, so a cancelled migration leaves the old
                    // installer state intact. Final hash still validates the prefix.
                    tokio::fs::copy(&legacy_part, &part).await.map_err(|e| e.to_string())?;
                    // A rejected old prefix must not be copied back on every retry.
                    tokio::fs::write(dir.join(format!("{filename}.legacy-part-imported")), b"")
                        .await.map_err(|e| e.to_string())?;
                }
            }
            let url = format!("{SHERPA_UPSTREAM_REPOSITORY}/resolve/{SHERPA_UPSTREAM_REVISION}/{filename}?download=true");
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
        if cancel.is_cancelled() { return Err("CANCELLED".into()); }
        let marker = dir.join(".revision.part");
        tokio::fs::write(&marker, SHERPA_UPSTREAM_REVISION).await.map_err(|e| e.to_string())?;
        tokio::fs::rename(marker, dir.join(SHERPA_REVISION_FILE)).await.map_err(|e| e.to_string())?;
        let active_part = sherpa_storage_dir().join(".active.part");
        tokio::fs::write(&active_part, SHERPA_UPSTREAM_REVISION).await.map_err(|e| e.to_string())?;
        tokio::fs::rename(active_part, sherpa_storage_dir().join(".active")).await.map_err(|e| e.to_string())?;
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
use super::sherpa_inventory::SHERPA_UPSTREAM_REPOSITORY;
