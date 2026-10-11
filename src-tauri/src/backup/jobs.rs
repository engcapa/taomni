//! Backend-owned persisted transfers; views only observe them.
use super::{
    control, credentials,
    feishu::{self, FeishuProvider},
    model::*,
    network,
    provider::{DestinationProvider, TransferContext},
    source::{BackupSource, TaomniSource},
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tauri::{Emitter, Manager};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
pub struct BackupJobs {
    pub running: Mutex<HashMap<String, CancellationToken>>,
    pub gate: Mutex<()>,
}

pub fn list(app: &tauri::AppHandle) -> Result<Vec<BackupJob>, String> {
    let dir = control::root(app)?.join("jobs");
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut jobs = vec![];
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().is_some_and(|e| e == "json") {
            let job: BackupJob =
                serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
                    .map_err(|_| "Backup job journal is damaged")?;
            jobs.push(job);
        }
    }
    jobs.sort_by_key(|job| std::cmp::Reverse(job.created_at));
    Ok(jobs)
}
fn save(app: &tauri::AppHandle, job: &BackupJob) -> Result<(), String> {
    validate_id(&job.id)?;
    control::write_json(
        &control::root(app)?
            .join("jobs")
            .join(format!("{}.json", job.id)),
        job,
    )?;
    let _ = app.emit("backup-job-progress", job);
    Ok(())
}
fn context(
    app: &tauri::AppHandle,
    job: Arc<Mutex<BackupJob>>,
    cancel: CancellationToken,
) -> TransferContext {
    let app = app.clone();
    TransferContext {
        cancel,
        report: Arc::new(move |phase, bytes, total| {
            if let Ok(mut job) = job.lock() {
                job.revision += 1;
                job.phase = phase.into();
                job.bytes = bytes;
                job.total = total;
                // Persist phase changes and every progress update so reopened views are authoritative.
                if let Err(error) = save(&app, &job) {
                    tracing::error!(target:"backup", %error, "Could not persist backup progress");
                }
            }
        }),
    }
}
pub async fn provider(
    app: &tauri::AppHandle,
    target: &BackupTarget,
) -> Result<FeishuProvider, String> {
    provider_with_cancel(app, target, &CancellationToken::new()).await
}
async fn provider_with_cancel(
    app: &tauri::AppHandle,
    target: &BackupTarget,
    cancel: &CancellationToken,
) -> Result<FeishuProvider, String> {
    if target.kind != ProviderKind::Feishu {
        return Err("PROVIDER_NOT_IMPLEMENTED".into());
    }
    let client = network::client(&app.state::<crate::state::AppState>(), &target.proxy)?;
    let bearer = feishu::auth::access_token(app, target, &client, cancel).await?;
    Ok(FeishuProvider {
        client,
        bearer,
        target: target.clone(),
    })
}
pub fn idle_context() -> TransferContext {
    TransferContext {
        cancel: CancellationToken::new(),
        report: Arc::new(|_, _, _| {}),
    }
}

pub fn start(
    app: &tauri::AppHandle,
    target_id: &str,
    remote: Option<RemoteBackup>,
    retry: Option<&str>,
) -> Result<String, String> {
    let service = app.state::<BackupJobs>();
    let _gate = service.gate.lock().map_err(|e| e.to_string())?;
    let target = control::target(app, target_id)?;
    if remote.is_none() && (!target.enabled || target.writes_paused) {
        return Err("Backup target uploads are disabled or paused".into());
    }
    let existing = list(app)?;
    let running = service.running.lock().map_err(|e| e.to_string())?;
    if running.keys().any(|key| key.starts_with("auth:")) {
        return Err(
            "Finish or cancel Feishu authorization before starting a backup transfer".into(),
        );
    }
    if let Some(job) = existing
        .iter()
        .find(|j| j.target_id == target_id && running.contains_key(&j.id))
    {
        if job.remote.as_ref().map(|r| &r.file_token) == remote.as_ref().map(|r| &r.file_token) {
            return Ok(job.id.clone());
        }
        return Err(
            "Another transfer is running for this target; finish or cancel it first".into(),
        );
    }
    drop(running);
    let mut job = if let Some(id) = retry {
        let old = existing
            .into_iter()
            .find(|j| j.id == id && j.target_id == target_id)
            .ok_or("Backup job not found")?;
        if !["failed", "cancelled", "interrupted", "queued"].contains(&old.phase.as_str()) {
            return Err("This job cannot be retried".into());
        }
        old
    } else {
        BackupJob {
            id: uuid::Uuid::new_v4().to_string(),
            revision: 0,
            target_id: target_id.into(),
            operation: if remote.is_some() {
                "download"
            } else {
                "upload"
            }
            .into(),
            phase: "queued".into(),
            bytes: 0,
            total: None,
            error: None,
            artifact: None,
            remote,
            receipt: None,
            created_at: now_ms(),
        }
    };
    job.phase = "queued".into();
    job.error = None;
    job.revision += 1;
    save(app, &job)?;
    let id = job.id.clone();
    let returned_id = id.clone();
    let cancel = CancellationToken::new();
    service
        .running
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id.clone(), cancel.clone());
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let job = Arc::new(Mutex::new(job));
        let ctx = context(&app, job.clone(), cancel.clone());
        let result = execute(&app, &target, job.clone(), &ctx).await;
        if let Ok(mut state) = job.lock() {
            state.revision += 1;
            match result {
                Ok(()) => {
                    state.phase = "completed".into();
                    state.error = None;
                }
                Err(error) => {
                    state.phase = if cancel.is_cancelled() {
                        "cancelled"
                    } else {
                        "failed"
                    }
                    .into();
                    state.error = Some(error);
                }
            }
            if let Err(error) = save(&app, &state) {
                tracing::error!(target:"backup",%error,"Failed to persist transfer result");
            }
        }
        if let Ok(mut running) = app.state::<BackupJobs>().running.lock() {
            running.remove(&id);
        }
    });
    Ok(returned_id)
}

async fn execute(
    app: &tauri::AppHandle,
    target: &BackupTarget,
    job: Arc<Mutex<BackupJob>>,
    ctx: &TransferContext,
) -> Result<(), String> {
    let state = job.lock().map_err(|e| e.to_string())?.clone();
    let dir = control::root(app)?.join("artifacts").join(&state.id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("archive.taobak");
    ctx.check()?;
    if state.operation == "upload" {
        let device = control::load(app)?.device;
        let secrets = credentials::get(&device.id, &target.id)?;
        let artifact = if let Some(artifact) = state.artifact {
            artifact
        } else {
            ctx.progress("preparing", 0, None);
            let snapshot_app = app.clone();
            let source = target.source.clone();
            let path = path.clone();
            let artifact = tauri::async_runtime::spawn_blocking(move || {
                TaomniSource.snapshot(&snapshot_app, &source, &path, &secrets.archive_password)
            })
            .await
            .map_err(|_| "Backup snapshot task failed")??;
            let mut state = job.lock().map_err(|e| e.to_string())?;
            state.artifact = Some(artifact.clone());
            state.revision += 1;
            save(app, &state)?;
            artifact
        };
        ctx.check()?;
        let adapter = provider_with_cancel(app, target, &ctx.cancel).await?;
        let receipt = adapter
            .upload(&artifact, &device, &dir.join("upload.json"), ctx)
            .await?;
        let mut state = job.lock().map_err(|e| e.to_string())?;
        state.receipt = Some(receipt);
    } else {
        let remote = state.remote.ok_or("Missing remote backup locator")?;
        let adapter = provider_with_cancel(app, target, &ctx.cancel).await?;
        adapter.download(&remote, &path, ctx).await?;
        let mut input = std::fs::File::open(&path).map_err(|e| e.to_string())?;
        if !super::crypto::is_encrypted_stream(&mut input) {
            return Err("Cloud backup is not an encrypted Taomni archive".into());
        }
        // Authentication/decryption is done by the unified restore preview with
        // the password supplied for the source device, not this device's password.
        let artifact = Artifact {
            path: path.to_string_lossy().into_owned(),
            snapshot_id: String::new(),
            size: std::fs::metadata(&path).map_err(|e| e.to_string())?.len(),
            sha256: super::manifest::file_sha256(&path).map_err(|e| e.to_string())?,
            source_kind: remote.source_kind,
        };
        job.lock().map_err(|e| e.to_string())?.artifact = Some(artifact);
    }
    Ok(())
}

pub fn initialize(app: &tauri::AppHandle) {
    app.manage(BackupJobs::default());
    feishu::auth::initialize(app);
    match list(app) {
        Ok(jobs) => {
            for mut job in jobs {
                if !["completed", "failed", "cancelled", "interrupted"]
                    .contains(&job.phase.as_str())
                {
                    job.phase = "interrupted".into();
                    job.revision += 1;
                    job.error = Some("Application stopped; retry to continue this transfer".into());
                    let _ = save(app, &job);
                }
            }
        }
        Err(error) => tracing::error!(target:"backup",%error,"Cannot load backup transfers"),
    }
}

/// Reuses the local schedule while keeping cloud delivery timestamps independent.
pub async fn scheduled(app: &tauri::AppHandle, trigger: super::scheduler::BackupTrigger) {
    let policy = super::policy::load_policy(app);
    if !policy.auto_backup_enabled {
        return;
    }
    let config = match control::load(app) {
        Ok(c) => c,
        Err(e) => {
            tracing::error!(target:"backup",error=%e,"Cannot load cloud backup schedule");
            return;
        }
    };
    let jobs = match list(app) {
        Ok(j) => j,
        Err(_) => return,
    };
    for target in config
        .targets
        .iter()
        .filter(|t| t.enabled && !t.writes_paused && config.selected_target_ids.contains(&t.id))
    {
        let previous = jobs
            .iter()
            .find(|j| j.target_id == target.id && j.operation == "upload");
        // Failed/cancelled jobs need explicit retry; do not create a minute-by-minute upload loop.
        if previous.is_some_and(|j| ["failed", "cancelled"].contains(&j.phase.as_str())) {
            continue;
        }
        let mut cloud_policy = policy.clone();
        cloud_policy.last_backup_at = previous.map(|j| j.created_at);
        let retry = previous.filter(|j| j.phase == "interrupted" || j.phase == "queued");
        if retry.is_none() && !super::scheduler::is_backup_due(&cloud_policy, now_ms(), trigger) {
            continue;
        }
        let started = start(app, &target.id, None, retry.map(|j| j.id.as_str()));
        if let Err(error) = &started {
            tracing::error!(target:"backup",%error,"Cloud backup could not start");
        }
        // Exit waits only until a durable encrypted artifact exists. Uploads can resume
        // on the next launch; the local payload must not depend on future live DB state.
        if matches!(trigger, super::scheduler::BackupTrigger::Exit) {
            if let Ok(id) = started {
                loop {
                    match list(app)
                        .ok()
                        .and_then(|v| v.into_iter().find(|j| j.id == id))
                    {
                        Some(j)
                            if j.artifact.is_some()
                                || ["failed", "cancelled", "completed"]
                                    .contains(&j.phase.as_str()) =>
                        {
                            break;
                        }
                        None => break,
                        _ => tokio::time::sleep(std::time::Duration::from_millis(100)).await,
                    }
                }
            }
        }
    }
}
