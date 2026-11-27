//! Re-read pending prompts addressed to a newly mounted or reloaded window.

use crate::state::AppState;
use serde_json::Value;
use tauri::{State, WebviewWindow};

#[tauri::command]
pub async fn cc_pending_permission_prompts(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<Vec<Value>, String> {
    Ok(state
        .core
        .agent
        .pending_approvals
        .replay(window.label(), "agent-cc-permission"))
}

#[tauri::command]
pub async fn acp_pending_permission_prompts(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<Vec<Value>, String> {
    Ok(state
        .core
        .agent
        .pending_approvals
        .replay(window.label(), "agent-acp-permission"))
}
