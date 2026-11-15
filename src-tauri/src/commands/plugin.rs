use serde_json::Value;
use std::path::PathBuf;
use tauri::State;

use crate::{plugin::PluginRecord, state::AppState};

#[tauri::command]
pub fn plugin_list(state: State<'_, AppState>) -> Result<Vec<PluginRecord>, String> {
    Ok(state.plugins.list())
}

#[tauri::command]
pub fn plugin_set_enabled(
    slug: String,
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<PluginRecord, String> {
    state
        .plugins
        .set_enabled(&slug, enabled)
        .map_err(|error| error.to_string())
}

/// Install a package directory after the download/verification layer has
/// completed. The native installer stages an immutable version and atomically
/// activates it before refreshing the registry projection.
#[tauri::command]
pub fn plugin_install_staged(
    slug: String,
    version: String,
    package_dir: String,
    state: State<'_, AppState>,
) -> Result<PluginRecord, String> {
    state
        .plugins
        .install_staged(&slug, &version, &PathBuf::from(package_dir))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn plugin_rollback(slug: String, state: State<'_, AppState>) -> Result<PluginRecord, String> {
    state
        .plugins
        .rollback(&slug)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn plugin_uninstall(
    slug: String,
    delete_data: Option<bool>,
    state: State<'_, AppState>,
) -> Result<PluginRecord, String> {
    state
        .plugins
        .uninstall(&slug, delete_data.unwrap_or(false))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn plugin_refresh(state: State<'_, AppState>) -> Result<Vec<PluginRecord>, String> {
    state.plugins.scan().map_err(|error| error.to_string())?;
    Ok(state.plugins.list())
}

#[tauri::command]
pub fn plugin_invoke(
    slug: String,
    command: String,
    payload: Option<Value>,
    request_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    // request_id is accepted at the IPC boundary for cancellation/retry
    // correlation while the host supervisor is rolled out.
    let _request_id = request_id;
    state
        .plugins
        .invoke(&slug, &command, payload.unwrap_or(Value::Null))
        .map_err(|error| error.to_string())
}

pub(super) fn handle(invoke: tauri::ipc::Invoke<tauri::Wry>) -> bool {
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        crate::commands::plugin::plugin_list,
        crate::commands::plugin::plugin_set_enabled,
        crate::commands::plugin::plugin_install_staged,
        crate::commands::plugin::plugin_rollback,
        crate::commands::plugin::plugin_uninstall,
        crate::commands::plugin::plugin_refresh,
        crate::commands::plugin::plugin_invoke,
    ];
    handler(invoke)
}
