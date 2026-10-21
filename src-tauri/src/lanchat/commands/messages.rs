use super::readiness::ensure_ready;
use crate::lanchat::messaging;
use crate::lanchat::store::Conversation;
use crate::lanchat::store::Group;
use crate::lanchat::store::LanMessage;
use crate::state::AppState;
use serde::Deserialize;
use tauri::AppHandle;
use tauri::State;

/// Arguments for [`lanchat_send_text`].
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendTextArgs {
    pub peer_id: String,
    pub text: String,
    #[serde(default)]
    pub mentions: Vec<String>,
}

/// Send a one-to-one text message to a peer. Returns the locally persisted
/// message (state transitions to delivered/failed via `lanchat://message`).
#[tauri::command]
pub async fn lanchat_send_text(
    app: AppHandle,
    state: State<'_, AppState>,
    args: SendTextArgs,
) -> Result<LanMessage, String> {
    ensure_ready(&state).await?;
    if args.text.trim().is_empty() {
        return Err("message text is empty".into());
    }
    messaging::send_text(
        &app,
        &state.lanchat,
        &args.peer_id,
        args.text,
        args.mentions,
    )
    .await
}

/// Re-send a failed/pending direct message (e.g. after the peer reconnects).
#[tauri::command]
pub async fn lanchat_resend_message(
    app: AppHandle,
    state: State<'_, AppState>,
    msg_id: String,
) -> Result<LanMessage, String> {
    ensure_ready(&state).await?;
    messaging::resend(&app, &state.lanchat, &msg_id).await
}

/// List conversations, most-recently-active first.
#[tauri::command]
pub async fn lanchat_list_conversations(
    state: State<'_, AppState>,
) -> Result<Vec<Conversation>, String> {
    state
        .lanchat
        .store
        .list_conversations()
        .map_err(|e| e.to_string())
}

/// List recent messages for a conversation (oldest-first, last `limit`).
#[tauri::command]
pub async fn lanchat_list_messages(
    state: State<'_, AppState>,
    conv_id: String,
    limit: Option<i64>,
) -> Result<Vec<LanMessage>, String> {
    ensure_ready(&state).await?;
    state
        .lanchat
        .store
        .list_messages(&conv_id, limit.unwrap_or(200))
        .map_err(|e| e.to_string())
}

/// Clear a conversation's unread counter (opened/read).
#[tauri::command]
pub async fn lanchat_mark_read(state: State<'_, AppState>, conv_id: String) -> Result<(), String> {
    state
        .lanchat
        .store
        .reset_unread(&conv_id)
        .map_err(|e| e.to_string())
}

/// Arguments for [`lanchat_create_group`].
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateGroupArgs {
    pub name: String,
    #[serde(default)]
    pub members: Vec<String>,
}

/// Create a named group/channel and announce it to the given members.
#[tauri::command]
pub async fn lanchat_create_group(
    app: AppHandle,
    state: State<'_, AppState>,
    args: CreateGroupArgs,
) -> Result<Group, String> {
    ensure_ready(&state).await?;
    if args.name.trim().is_empty() {
        return Err("group name is empty".into());
    }
    messaging::create_group(&app, &state.lanchat, &args.name, args.members).await
}

/// Arguments for [`lanchat_send_group_text`].
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendGroupTextArgs {
    pub group_id: String,
    pub text: String,
    #[serde(default)]
    pub mentions: Vec<String>,
}

/// Send a text message to all online members of a group.
#[tauri::command]
pub async fn lanchat_send_group_text(
    app: AppHandle,
    state: State<'_, AppState>,
    args: SendGroupTextArgs,
) -> Result<LanMessage, String> {
    ensure_ready(&state).await?;
    if args.text.trim().is_empty() {
        return Err("message text is empty".into());
    }
    messaging::send_group_text(
        &app,
        &state.lanchat,
        &args.group_id,
        args.text,
        args.mentions,
    )
    .await
}

/// List all known groups (with their members).
#[tauri::command]
pub async fn lanchat_list_groups(state: State<'_, AppState>) -> Result<Vec<Group>, String> {
    state.lanchat.store.list_groups().map_err(|e| e.to_string())
}

/// Leave a group locally and notify its members.
#[tauri::command]
pub async fn lanchat_leave_group(
    app: AppHandle,
    state: State<'_, AppState>,
    group_id: String,
) -> Result<(), String> {
    ensure_ready(&state).await?;
    messaging::leave_group(&app, &state.lanchat, &group_id).await
}
