use super::provider::DestinationProvider;
use super::{
    control, credentials, feishu,
    jobs::{self, BackupJobs},
    model::*,
};
use serde::Serialize;
use tauri::{AppHandle, Manager};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetStatus {
    target_id: String,
    connected: bool,
    password_configured: bool,
}
#[derive(Serialize)]
pub struct Configuration {
    config: ControlConfig,
    statuses: Vec<TargetStatus>,
}
#[tauri::command]
pub async fn backup_remote_get_config(app: AppHandle) -> Result<Configuration, String> {
    let config = control::load(&app)?;
    let mut statuses = vec![];
    for target in &config.targets {
        let secrets = credentials::get(&config.device.id, &target.id)?;
        let connected = if let Some(id) = &target.connection_id {
            feishu::auth::connected(&credentials::get_connection(&config.device.id, id)?)
        } else {
            false
        };
        statuses.push(TargetStatus {
            target_id: target.id.clone(),
            connected,
            password_configured: !secrets.archive_password.is_empty(),
        });
    }
    Ok(Configuration { config, statuses })
}
#[tauri::command]
pub async fn backup_remote_save_config(
    app: AppHandle,
    config: ControlConfig,
    target_id: Option<String>,
    archive_password: Option<String>,
) -> Result<(), String> {
    let jobs = app.state::<BackupJobs>();
    let _gate = jobs.gate.lock().map_err(|e| e.to_string())?;
    if !jobs.running.lock().map_err(|e| e.to_string())?.is_empty() {
        return Err("Wait for active backup tasks before changing target settings".into());
    }
    let current = control::load(&app)?;
    if let Some(id) = target_id {
        let target = config
            .targets
            .iter()
            .find(|t| t.id == id)
            .ok_or("Target not found in configuration")?;
        let mut secrets = credentials::get(&current.device.id, &id)?;
        if let Some(password) = archive_password.filter(|s| !s.trim().is_empty()) {
            secrets.archive_password = password;
        }
        if target.enabled && secrets.archive_password.trim().is_empty() {
            return Err(
                "Configure an independent backup password before enabling cloud backup".into(),
            );
        }
        credentials::put(&current.device.id, &id, &secrets)?;
    }
    for target in config.targets.iter().filter(|t| t.enabled) {
        if credentials::get(&current.device.id, &target.id)?
            .archive_password
            .trim()
            .is_empty()
        {
            return Err(
                "Configure an independent backup password for every enabled cloud target".into(),
            );
        }
    }
    control::save(&app, config)
}
#[tauri::command]
pub async fn backup_feishu_authorize(
    app: AppHandle,
    target_id: String,
    application_selection: Option<String>,
) -> Result<AuthorizationSession, String> {
    feishu::auth::start(&app, &target_id, application_selection)
}
#[tauri::command]
pub async fn backup_feishu_apps() -> Result<Vec<feishu::cli_config::ApplicationChoice>, String> {
    tauri::async_runtime::spawn_blocking(feishu::cli_config::applications)
        .await
        .map_err(|_| "Cannot discover existing Feishu applications")?
}
#[tauri::command]
pub fn backup_feishu_authorization_status(
    app: AppHandle,
) -> Result<Vec<AuthorizationSession>, String> {
    feishu::auth::sessions(&app)
}
#[tauri::command]
pub fn backup_feishu_authorization_cancel(
    app: AppHandle,
    session_id: String,
) -> Result<(), String> {
    feishu::auth::cancel(&app, &session_id)
}
#[tauri::command]
pub async fn backup_remote_list(
    app: AppHandle,
    target_id: String,
) -> Result<Vec<RemoteBackup>, String> {
    let target = control::target(&app, &target_id)?;
    jobs::provider(&app, &target)
        .await?
        .list(&jobs::idle_context())
        .await
}
#[tauri::command]
pub fn backup_remote_start(app: AppHandle, target_id: String) -> Result<String, String> {
    jobs::start(&app, &target_id, None, None)
}
#[tauri::command]
pub fn backup_remote_download(app: AppHandle, remote: RemoteBackup) -> Result<String, String> {
    let id = remote.target_id.clone();
    jobs::start(&app, &id, Some(remote), None)
}
#[tauri::command]
pub fn backup_remote_jobs(app: AppHandle) -> Result<Vec<BackupJob>, String> {
    jobs::list(&app)
}
#[tauri::command]
pub fn backup_remote_cancel(app: AppHandle, job_id: String) -> Result<(), String> {
    if let Some(token) = app
        .state::<BackupJobs>()
        .running
        .lock()
        .map_err(|e| e.to_string())?
        .get(&job_id)
    {
        token.cancel();
    }
    Ok(())
}
#[tauri::command]
pub fn backup_remote_retry(app: AppHandle, job_id: String) -> Result<String, String> {
    let job = jobs::list(&app)?
        .into_iter()
        .find(|j| j.id == job_id)
        .ok_or("Backup job not found")?;
    jobs::start(&app, &job.target_id, job.remote, Some(&job_id))
}
#[tauri::command]
pub async fn backup_remote_history_url(
    app: AppHandle,
    remote: RemoteBackup,
) -> Result<String, String> {
    let target = control::target(&app, &remote.target_id)?;
    let found = jobs::provider(&app, &target)
        .await?
        .list(&jobs::idle_context())
        .await?
        .into_iter()
        .any(|f| f.file_token == remote.file_token && f.device_id == remote.device_id);
    if !found {
        return Err("Backup file no longer belongs to this target".into());
    }
    if !app
        .state::<BackupJobs>()
        .running
        .lock()
        .map_err(|e| e.to_string())?
        .is_empty()
    {
        return Err("Finish or cancel active tasks before opening version recovery".into());
    }
    let mut config = control::load(&app)?;
    if let Some(target) = config.targets.iter_mut().find(|t| t.id == remote.target_id) {
        target.writes_paused = true;
    }
    control::save(&app, config)?;
    Ok(format!("https://my.feishu.cn/file/{}", remote.file_token))
}
