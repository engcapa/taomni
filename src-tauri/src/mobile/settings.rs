use super::{Core, MobileRuntime};
use crate::state::AppState;
use serde_json::{Value, json};
use tauri::State;

async fn status(runtime: &MobileRuntime) -> Result<Value, String> {
    let running = runtime.lifecycle.lock().await;
    let auth = runtime.auth.lock().map_err(|_| "auth_unavailable")?;
    Ok(
        json!({"enabled":running.as_ref().is_some_and(|r| !r.task.is_finished()),
        "address":running.as_ref().map(|r| &r.address), "failed_attempts":auth.failed_attempts,
        "devices":auth.devices.iter().map(|d| json!({"device_id":d.device_id,"label":d.label,"origin":d.origin,"created_at":d.created_at,"last_used_at":d.last_used_at})).collect::<Vec<_>>() }),
    )
}
#[tauri::command]
pub async fn mobile_status(state: State<'_, AppState>) -> Result<Value, String> {
    status(&state.mobile).await
}
#[tauri::command]
pub async fn mobile_start(
    lan: bool,
    port: u16,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    state
        .mobile
        .start(
            Core::Desktop(app.clone()),
            crate::resolved_app_data_dir(&app)?,
            lan,
            port,
        )
        .await?;
    status(&state.mobile).await
}
#[tauri::command]
pub async fn mobile_stop(state: State<'_, AppState>) -> Result<Value, String> {
    state.mobile.stop().await;
    status(&state.mobile).await
}
#[tauri::command]
pub async fn mobile_pairing_code(state: State<'_, AppState>) -> Result<String, String> {
    if !state
        .mobile
        .lifecycle
        .lock()
        .await
        .as_ref()
        .is_some_and(|r| !r.task.is_finished())
    {
        return Err("service_disabled".into());
    }
    Ok(state
        .mobile
        .auth
        .lock()
        .map_err(|_| "auth_unavailable")?
        .pairing_code())
}
#[tauri::command]
pub fn mobile_revoke(device_id: String, state: State<'_, AppState>) -> Result<(), String> {
    state
        .mobile
        .auth
        .lock()
        .map_err(|_| "auth_unavailable")?
        .revoke(&device_id)?;
    state.mobile.devices_changed.notify_waiters();
    Ok(())
}
