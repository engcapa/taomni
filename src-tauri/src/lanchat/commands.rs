//! LanChat Tauri command surface (`lanchat_*`).
//!
//! Single backend entry point for the frontend IPC layer (`src/lib/ipc.ts`).
//! Commands are added per phase; phase 1 ships only a lightweight status probe
//! used by the status bar / web-preview banner.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::lanchat::protocol::PresenceStatus;
use crate::lanchat::store::{decode_avatar_base64, Conversation, Group, LanMessage, Profile};
use crate::lanchat::messaging;
use crate::lanchat::protocol::PeerRecord;
use crate::lanchat::store::direct_conv_id;
use crate::lanchat::transfer;
use crate::state::AppState;

/// Snapshot of the LanChat service for the status bar.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanChatStatus {
    /// Whether the background service task is running.
    pub running: bool,
    /// This node's stable id.
    pub node_id: String,
    /// Number of peers currently discovered on the LAN.
    pub peer_count: usize,
}

/// Report current LanChat service status (running + node id + peer count).
#[tauri::command]
pub async fn lanchat_status(state: State<'_, AppState>) -> Result<LanChatStatus, String> {
    Ok(LanChatStatus {
        running: true,
        node_id: state.lanchat.node_id().await,
        peer_count: state.lanchat.peer_count().await,
    })
}

/// Current discovered peers (live roster snapshot). Lets a freshly-opened or
/// detached window populate immediately instead of waiting for the next
/// debounced roster event.
#[tauri::command]
pub async fn lanchat_list_peers(state: State<'_, AppState>) -> Result<Vec<PeerRecord>, String> {
    Ok(state.lanchat.peers.read().await.values().cloned().collect())
}

/// Read this node's local profile.
#[tauri::command]
pub async fn lanchat_get_profile(state: State<'_, AppState>) -> Result<Profile, String> {
    state
        .lanchat
        .store
        .get_profile()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "lanchat profile not initialized".to_string())
}

/// Arguments for [`lanchat_update_profile`]. `avatarBase64` may be a raw
/// base64 string or a `data:<mime>;base64,...` URL; omit/empty to keep the
/// current avatar unchanged.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProfileArgs {
    pub name: String,
    #[serde(default)]
    pub avatar_base64: Option<String>,
    #[serde(default)]
    pub signature: String,
    pub status: String,
}

/// Update this node's local profile (display name / avatar / signature /
/// status). Persists to SQLite and returns the updated profile. mDNS TXT
/// re-advertise + `profile-update` broadcast are wired in later phases.
#[tauri::command]
pub async fn lanchat_update_profile(
    state: State<'_, AppState>,
    args: UpdateProfileArgs,
) -> Result<Profile, String> {
    let avatar = match args.avatar_base64.as_deref() {
        Some(s) if !s.trim().is_empty() => Some(decode_avatar_base64(s)?),
        _ => None,
    };
    let status = PresenceStatus::from_txt(&args.status);
    let profile = state
        .lanchat
        .store
        .update_profile(&args.name, avatar, &args.signature, status)
        .map_err(|e| e.to_string())?;
    // Re-announce the mDNS TXT so peers see the new name/avatar/status. The
    // control-channel `profile-update` broadcast is added with messaging.
    if let Err(e) = crate::lanchat::discovery::reregister(&state.lanchat) {
        log::warn!("lanchat: re-register after profile update failed: {e}");
    }
    Ok(profile)
}

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
    if args.text.trim().is_empty() {
        return Err("message text is empty".into());
    }
    messaging::send_text(&app, &state.lanchat, &args.peer_id, args.text, args.mentions).await
}

/// Re-send a failed/pending direct message (e.g. after the peer reconnects).
#[tauri::command]
pub async fn lanchat_resend_message(
    app: AppHandle,
    state: State<'_, AppState>,
    msg_id: String,
) -> Result<LanMessage, String> {
    messaging::resend(&app, &state.lanchat, &msg_id).await
}

/// List conversations, most-recently-active first.
#[tauri::command]
pub async fn lanchat_list_conversations(
    state: State<'_, AppState>,
) -> Result<Vec<Conversation>, String> {
    state.lanchat.store.list_conversations().map_err(|e| e.to_string())
}

/// List recent messages for a conversation (oldest-first, last `limit`).
#[tauri::command]
pub async fn lanchat_list_messages(
    state: State<'_, AppState>,
    conv_id: String,
    limit: Option<i64>,
) -> Result<Vec<LanMessage>, String> {
    state
        .lanchat
        .store
        .list_messages(&conv_id, limit.unwrap_or(200))
        .map_err(|e| e.to_string())
}

/// Clear a conversation's unread counter (opened/read).
#[tauri::command]
pub async fn lanchat_mark_read(
    state: State<'_, AppState>,
    conv_id: String,
) -> Result<(), String> {
    state.lanchat.store.reset_unread(&conv_id).map_err(|e| e.to_string())
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
    if args.text.trim().is_empty() {
        return Err("message text is empty".into());
    }
    messaging::send_group_text(&app, &state.lanchat, &args.group_id, args.text, args.mentions).await
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
    messaging::leave_group(&app, &state.lanchat, &group_id).await
}

/* ----------------------------- transfers (task 02) ----------------------------- */

/// Offer a file to a peer. Returns the transfer id (progress via
/// `lanchat://transfer`).
#[tauri::command]
pub async fn lanchat_send_file(
    app: AppHandle,
    state: State<'_, AppState>,
    peer_id: String,
    path: String,
) -> Result<String, String> {
    let conv = direct_conv_id(&peer_id);
    transfer::send_file(&app, &state.lanchat, &peer_id, std::path::PathBuf::from(path), conv).await
}

/// Accept an inbound file offer, saving to `save_path`.
#[tauri::command]
pub async fn lanchat_accept_file(
    app: AppHandle,
    state: State<'_, AppState>,
    transfer_id: String,
    save_path: String,
) -> Result<(), String> {
    transfer::accept_offer(&app, &state.lanchat, &transfer_id, std::path::PathBuf::from(save_path)).await
}

/// Reject an inbound file offer.
#[tauri::command]
pub async fn lanchat_reject_file(
    app: AppHandle,
    state: State<'_, AppState>,
    transfer_id: String,
) -> Result<(), String> {
    transfer::reject_offer(&app, &state.lanchat, &transfer_id).await
}

/// Pause / resume / cancel a transfer (`action`: "pause" | "resume" | "cancel").
#[tauri::command]
pub async fn lanchat_transfer_control(
    app: AppHandle,
    state: State<'_, AppState>,
    transfer_id: String,
    action: String,
) -> Result<(), String> {
    transfer::control(&app, &state.lanchat, &transfer_id, &action).await
}
