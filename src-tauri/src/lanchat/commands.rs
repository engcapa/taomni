//! LanChat Tauri command surface (`lanchat_*`).
//!
//! Single backend entry point for the frontend IPC layer (`src/lib/ipc.ts`).
//! Commands are added per phase; phase 1 ships only a lightweight status probe
//! used by the status bar / web-preview banner.

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::lanchat::protocol::PresenceStatus;
use crate::lanchat::store::{decode_avatar_base64, Profile};
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
    state
        .lanchat
        .store
        .update_profile(&args.name, avatar, &args.signature, status)
        .map_err(|e| e.to_string())
}
