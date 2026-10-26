//! Local exports and automatic backups share the observable cancellable job owner.
use super::{
    engine,
    jobs::{self, BackupJobs},
    model::*,
    provider::TransferContext,
    scheduler::BackupTrigger,
    snapshot_context::SnapshotContext,
};
use std::sync::{Arc, Mutex};
use tauri::Manager;

pub(crate) struct LocalRequest {
    path: Option<String>,
    password: Option<String>,
    trigger: Option<BackupTrigger>,
}

pub(crate) fn start(
    app: &tauri::AppHandle,
    source: SourceSpec,
    path: Option<String>,
    password: Option<String>,
    trigger: Option<BackupTrigger>,
) -> Result<String, String> {
    let owner = jobs::claim(app)?;
    let service = app.state::<BackupJobs>();
    let _gate = service.gate.lock().map_err(|e| e.to_string())?;
    let active = service.active.lock().map_err(|e| e.to_string())?;
    if let Some(job) = active
        .values()
        .find(|j| j.lock().is_ok_and(|j| j.operation == "local"))
    {
        let id = job.lock().map_err(|e| e.to_string())?.id.clone();
        if trigger.is_some() {
            return Ok(id);
        }
        return Err("Another local backup is running; finish or cancel it first".into());
    }
    drop(active);
    let job = BackupJob {
        id: uuid::Uuid::new_v4().to_string(),
        revision: 1,
        target_id: "local".into(),
        operation: "local".into(),
        phase: "queued".into(),
        bytes: 0,
        total: None,
        error: None,
        artifact: None,
        remote: None,
        receipt: None,
        created_at: now_ms(),
        updated_at: now_ms(),
        attempts: 1,
        next_retry_at: None,
        failure_kind: None,
        execution_source: Some(source),
        cancel_requested: false,
        local_path: None,
    };
    jobs::launch(
        app,
        job,
        owner,
        None,
        Some(LocalRequest {
            path,
            password,
            trigger,
        }),
    )
}

pub(crate) async fn execute(
    app: &tauri::AppHandle,
    job: Arc<Mutex<BackupJob>>,
    transfer: &TransferContext,
    request: LocalRequest,
) -> Result<(), String> {
    let source = job
        .lock()
        .map_err(|e| e.to_string())?
        .execution_source
        .clone()
        .ok_or("Missing local backup categories")?;
    let context = SnapshotContext::new(Some(transfer.clone()));
    let app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        context.begin("preparing", None)?;
        if let Some(trigger) = request.trigger {
            engine::create_scheduled_backup_with_context(&app, trigger, &context, Some(&source))
        } else {
            engine::create_backup_with_context(
                &app.state::<crate::state::AppState>(),
                &app,
                &source.scope,
                source.custom_options,
                request.path,
                request.password,
                &context,
            )
            .map(Some)
        }
    })
    .await
    .map_err(|e| format!("Local backup task: {e}"))??;
    if let Some(result) = result {
        let mut job = job.lock().map_err(|e| e.to_string())?;
        job.local_path = Some(result.file_path);
        job.bytes = result.size_bytes;
        job.total = Some(result.size_bytes);
    }
    Ok(())
}

pub(crate) async fn scheduled(
    app: &tauri::AppHandle,
    trigger: BackupTrigger,
) -> Result<(), String> {
    let mut policy = super::policy::load_policy_result(app)?;
    if !policy.local_channel_enabled {
        return Ok(());
    }
    if let Some(job) = jobs::list(app)?.iter().find(|j| j.operation == "local") {
        if ["cancelled", "failed"].contains(&job.phase.as_str()) {
            if matches!(trigger, BackupTrigger::Exit)
                && now_ms().saturating_sub(job.updated_at) < 3_600_000
            {
                return Ok(());
            }
            policy.last_backup_at = Some(policy.last_backup_at.unwrap_or(0).max(job.updated_at));
        }
    }
    if !super::scheduler::is_backup_due(&policy, now_ms(), trigger) {
        return Ok(());
    }
    let range = policy
        .local_range_override
        .clone()
        .unwrap_or_else(|| super::range::global(&policy));
    let id = start(app, range.source(), None, None, Some(trigger))?;
    loop {
        let active = app
            .state::<BackupJobs>()
            .active
            .lock()
            .map_err(|e| e.to_string())?
            .contains_key(&id);
        if !active {
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
}
