use crate::state::AppState;
use serde::Serialize;
use tauri::AppHandle;
use tauri::State;

/// Service enablement state for the UI: whether the background service is
/// currently running, and whether it is configured to start on app launch.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanChatServiceState {
    pub running: bool,
    pub start_on_launch: bool,
}

/// Read whether the service is running + the start-on-launch policy.
#[tauri::command]
pub async fn lanchat_get_service_state(
    state: State<'_, AppState>,
) -> Result<LanChatServiceState, String> {
    Ok(LanChatServiceState {
        running: state
            .lanchat
            .running
            .load(std::sync::atomic::Ordering::SeqCst),
        start_on_launch: state
            .lanchat
            .store
            .get_start_on_launch()
            .map_err(|e| e.to_string())?,
    })
}

/// Start the background service on demand (manual enable from the chat UI).
/// Idempotent and one-way: once started it runs until the app exits. The work
/// The service's long-running loops are spawned internally; lock or bind
/// failures are returned to the caller and also published via the service event.
#[tauri::command]
pub async fn lanchat_start_service(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if state
        .lanchat
        .running
        .load(std::sync::atomic::Ordering::SeqCst)
    {
        return Ok(());
    }
    crate::lanchat::start_service(app).await
}

/// Set the "start LanChat on app launch" policy. Does not start/stop the
/// running service — only affects the next launch.
#[tauri::command]
pub async fn lanchat_set_start_on_launch(
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<(), String> {
    state
        .lanchat
        .store
        .set_start_on_launch(enabled)
        .map_err(|e| e.to_string())
}
