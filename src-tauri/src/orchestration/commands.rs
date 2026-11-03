use super::{OrchestrationRuntime, core::model::*};
use tauri::{AppHandle, Manager, State};

#[tauri::command]
pub fn orchestration_get_settings(
    app: AppHandle,
    runtime: State<'_, OrchestrationRuntime>,
) -> Result<AgentSettings, String> {
    runtime.with(&app, |i| i.settings())
}
#[tauri::command]
pub fn orchestration_save_settings(
    app: AppHandle,
    runtime: State<'_, OrchestrationRuntime>,
    settings: AgentSettings,
    expected_revision: u64,
) -> Result<AgentSettings, String> {
    runtime.with(&app, |i| i.save_settings(&settings, expected_revision))
}
#[tauri::command]
pub fn orchestration_list_runs(
    app: AppHandle,
    runtime: State<'_, OrchestrationRuntime>,
) -> Result<Vec<AgentRun>, String> {
    runtime.with(&app, |i| i.store.list())
}
#[tauri::command]
pub fn orchestration_get_run(
    app: AppHandle,
    runtime: State<'_, OrchestrationRuntime>,
    run_id: String,
) -> Result<AgentRun, String> {
    runtime.with(&app, |i| i.store.get(&run_id))
}
#[tauri::command]
pub fn orchestration_create_run(
    app: AppHandle,
    runtime: State<'_, OrchestrationRuntime>,
    submission: AgentSubmission,
) -> Result<AgentRun, String> {
    runtime.with(&app, |i| i.create(submission))
}
#[tauri::command]
pub fn orchestration_preview_context(
    project_path: String,
    source_paths: Vec<String>,
) -> Result<ContextPreview, String> {
    super::context::compile(&project_path, &source_paths)
}
#[tauri::command]
pub fn orchestration_active_count(
    app: AppHandle,
    runtime: State<'_, OrchestrationRuntime>,
) -> Result<usize, String> {
    runtime.with(&app, |i| i.store.active_count())
}
#[tauri::command]
pub fn orchestration_start_run(
    app: AppHandle,
    runtime: State<'_, OrchestrationRuntime>,
    run_id: String,
    expected_revision: u64,
) -> Result<AgentRun, String> {
    start(app, &runtime, run_id, expected_revision, false)
}
#[tauri::command]
pub fn orchestration_recover_run(
    app: AppHandle,
    runtime: State<'_, OrchestrationRuntime>,
    run_id: String,
    expected_revision: u64,
) -> Result<AgentRun, String> {
    start(app, &runtime, run_id, expected_revision, true)
}
#[tauri::command]
pub fn orchestration_cancel_run(
    app: AppHandle,
    runtime: State<'_, OrchestrationRuntime>,
    run_id: String,
) -> Result<AgentRun, String> {
    runtime.with(&app, |inner| inner.request_cancel(&run_id))
}

fn start(
    app: AppHandle,
    runtime: &OrchestrationRuntime,
    id: String,
    revision: u64,
    recovery: bool,
) -> Result<AgentRun, String> {
    let lease = runtime.with(&app, |inner| {
        let run = inner.store.get(&id)?;
        let resource = run.settings_snapshot.resource(&run.intent)?;
        let config =
            crate::ai::config::AiConfig::load(&crate::ai::config::default_ai_config_path());
        super::core::service::ensure_policy(&config, &resource)?;
        inner.reserve(&id, revision, recovery)
    })?;
    let output = lease.run.clone();
    tauri::async_runtime::spawn(async move {
        let runtime = app.state::<OrchestrationRuntime>();
        let result = match runtime.with(&app, |inner| inner.begin(&id)) {
            Err(error) => Err(error),
            Ok(()) if lease.cancel.is_cancelled() => Err("CANCELLED".into()),
            Ok(()) => execute(&app, &lease, recovery).await,
        };
        if let Err(error) = runtime.with(&app, |inner| inner.finish(&lease, &result)) {
            // Keep the live reservation and token on persistence failure. A later
            // app restart reconciles to unknown; never report a completed task.
            log::error!("orchestration terminal persistence failed for {id}: {error}");
        }
    });
    Ok(output)
}

async fn execute(
    app: &AppHandle,
    lease: &super::core::lifecycle::RunLease,
    recovery: bool,
) -> Result<(), String> {
    if lease.resource.kind == "api" {
        super::execution::api::execute(
            app.clone(),
            lease.run.clone(),
            lease.resource.clone(),
            lease.request.clone(),
            lease.cancel.clone(),
            recovery,
        )
        .await
    } else {
        super::execution::worker::execute(
            app.clone(),
            lease.run.clone(),
            lease.resource.clone(),
            lease.request.clone(),
            lease.cancel.clone(),
        )
        .await
    }
}
