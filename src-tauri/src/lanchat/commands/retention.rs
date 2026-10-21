use crate::lanchat::store::RetentionSettings;
use crate::state::AppState;
use tauri::State;

/* ----------------------------- retention & security (phase 4) ----------------------------- */

/// Read the message-retention policy.
#[tauri::command]
pub async fn lanchat_get_retention(
    state: State<'_, AppState>,
) -> Result<RetentionSettings, String> {
    state
        .lanchat
        .store
        .get_retention()
        .map_err(|e| e.to_string())
}

/// Update the message-retention policy and apply it immediately.
#[tauri::command]
pub async fn lanchat_set_retention(
    state: State<'_, AppState>,
    settings: RetentionSettings,
) -> Result<(), String> {
    state
        .lanchat
        .store
        .set_retention(&settings)
        .map_err(|e| e.to_string())?;
    let _ = state.lanchat.store.apply_retention();
    Ok(())
}

/// Delete a single message from local history.
#[tauri::command]
pub async fn lanchat_delete_message(
    state: State<'_, AppState>,
    msg_id: String,
) -> Result<(), String> {
    state
        .lanchat
        .store
        .delete_message(&msg_id)
        .map_err(|e| e.to_string())
}

/// Clear all messages in a conversation.
#[tauri::command]
pub async fn lanchat_clear_conversation(
    state: State<'_, AppState>,
    conv_id: String,
) -> Result<(), String> {
    state
        .lanchat
        .store
        .clear_conversation(&conv_id)
        .map_err(|e| e.to_string())
}

/// Delete all local chat history and reclaim disk space.
#[tauri::command]
pub async fn lanchat_clear_all_history(state: State<'_, AppState>) -> Result<(), String> {
    state
        .lanchat
        .store
        .clear_all_history()
        .map_err(|e| e.to_string())?;
    let _ = state.lanchat.store.vacuum();
    Ok(())
}
