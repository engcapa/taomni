use serde_json::Value;
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
        crate::commands::plugin::plugin_invoke,
    ];
    handler(invoke)
}
