mod coordination;
pub mod crypto;
pub mod engine;
pub mod manifest;
pub mod policy;
pub mod restore;
pub mod scheduler;

#[cfg(test)]
mod tests;

use crate::state::AppState;
pub use engine::{BackupCustomOptions, BackupEntryInfo, BackupResult};
pub use manifest::BackupManifest;
pub use policy::BackupPolicy;
pub use restore::StageRestoreResult;

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// Create a new backup archive.
#[tauri::command]
pub async fn backup_create(
    app: AppHandle,
    scope: String,
    custom_options: Option<BackupCustomOptions>,
    target_path: Option<String>,
    password: Option<String>,
) -> Result<BackupResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        engine::create_backup(&state, &app, &scope, custom_options, target_path, password)
    })
    .await
    .map_err(|e| format!("backup task join error: {e}"))?
}

/// Inspect a backup archive and return its manifest.
#[tauri::command]
pub async fn backup_inspect(
    app: AppHandle,
    path: String,
    password: Option<String>,
) -> Result<BackupManifest, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let coordinator = app.state::<scheduler::BackupCoordinator>();
        let _operation = coordinator.operation.lock().map_err(|e| e.to_string())?;
        let _process_operation = coordination::BackupProcessLock::acquire(&app)?;
        let p = PathBuf::from(path);
        restore::inspect_archive(&p, password.as_deref())
    })
    .await
    .map_err(|e| format!("inspect task join error: {e}"))?
}

/// Verify and stage a backup archive for restart restoration.
#[tauri::command]
pub async fn backup_stage_restore(
    app: AppHandle,
    path: String,
    password: Option<String>,
    vault_password: Option<String>,
) -> Result<StageRestoreResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let coordinator = app.state::<scheduler::BackupCoordinator>();
        let _operation = coordinator.operation.lock().map_err(|e| e.to_string())?;
        let _process_operation = coordination::BackupProcessLock::acquire(&app)?;
        let state = app.state::<AppState>();
        state
            .vault
            .verify_master_password(vault_password.as_deref())?;
        let p = PathBuf::from(path);
        restore::stage_restore(&app, &p, password.as_deref())
    })
    .await
    .map_err(|e| format!("stage restore join error: {e}"))?
}

/// Get the current backup policy.
#[tauri::command]
pub async fn backup_get_policy(app: AppHandle) -> Result<BackupPolicy, String> {
    Ok(policy::load_policy(&app))
}

/// Update and save the backup policy.
#[tauri::command]
pub async fn backup_set_policy(app: AppHandle, mut policy: BackupPolicy) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let coordinator = app.state::<scheduler::BackupCoordinator>();
        let _operation = coordinator.operation.lock().map_err(|e| e.to_string())?;
        let _process_operation = coordination::BackupProcessLock::acquire(&app)?;
        // Settings may still hold the timestamp from before a background backup.
        // Only a successful backup is allowed to update this backend-owned value.
        policy.last_backup_at = policy::load_policy(&app).last_backup_at;
        policy::save_policy(&app, &policy)
    })
    .await
    .map_err(|e| format!("save backup policy task join error: {e}"))?
}

/// List all backup entries in the effective backup directory.
#[tauri::command]
pub async fn backup_list_history(app: AppHandle) -> Result<Vec<BackupEntryInfo>, String> {
    let pol = policy::load_policy(&app);
    let dir = policy::resolve_backup_dir(&app, &pol);
    engine::list_backups(&dir)
}

/// Delete a specific backup item from the effective backup directory.
#[tauri::command]
pub async fn backup_delete_item(app: AppHandle, file_name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let coordinator = app.state::<scheduler::BackupCoordinator>();
        let _operation = coordinator.operation.lock().map_err(|e| e.to_string())?;
        let _process_operation = coordination::BackupProcessLock::acquire(&app)?;
        let pol = policy::load_policy(&app);
        let dir = policy::resolve_backup_dir(&app, &pol);
        engine::delete_backup_item(&dir, &file_name)
    })
    .await
    .map_err(|e| format!("delete backup task join error: {e}"))?
}

/// Get the system default backup directory path as string.
#[tauri::command]
pub async fn backup_get_default_dir(app: AppHandle) -> Result<String, String> {
    let def = policy::default_backup_dir(&app);
    Ok(def.to_string_lossy().into_owned())
}
