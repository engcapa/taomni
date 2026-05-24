//! Session-level safety check: when a session has `disableAiWrite=true` in
//! its `options_json`, the AI subsystem must not execute commands or upload
//! files for that session — only display the preview/dry-run.
//!
//! The flag lives in `options_json.disableAiWrite` (string-typed JSON value
//! in the SQLite session row), set by SessionEditor → Bookmark → AI safety.

use crate::state::AppState;

/// Returns true if the given session has the AI-write-disabled flag set.
/// Returns false on any error (missing session, malformed json, etc.) — the
/// safer-failed-open is intentional only for this read; enforcement points
/// must still fall back to "show preview only" when execution would happen.
pub fn is_ai_write_disabled(state: &AppState, session_id: &str) -> bool {
    let db = match state.db.lock() {
        Ok(g) => g,
        Err(_) => return false,
    };
    let session = match crate::session::db::get_session(&db, session_id) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let parsed: serde_json::Value = match serde_json::from_str(&session.options_json) {
        Ok(v) => v,
        Err(_) => return false,
    };
    parsed
        .get("disableAiWrite")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

/// Tauri command — exposed so the frontend can read the same flag without
/// re-parsing options_json on every CommandPreviewCard mount.
#[tauri::command]
pub async fn is_session_ai_write_disabled(
    session_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<bool, String> {
    Ok(is_ai_write_disabled(state.inner(), &session_id))
}
