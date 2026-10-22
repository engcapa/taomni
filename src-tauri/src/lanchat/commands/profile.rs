use super::readiness::ensure_ready;
use crate::lanchat::protocol::PeerRecord;
use crate::lanchat::protocol::PresenceStatus;
use crate::lanchat::store::Profile;
use crate::lanchat::store::decode_avatar_base64;
use crate::state::AppState;
use serde::Deserialize;
use serde::Serialize;
use tauri::State;

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
        running: state
            .lanchat
            .running
            .load(std::sync::atomic::Ordering::SeqCst),
        node_id: state.lanchat.node_id().await,
        peer_count: state.lanchat.peer_count().await,
    })
}

/// Current roster: live peers plus cached offline peers so historical chats can
/// still display the last known name.
#[tauri::command]
pub async fn lanchat_list_peers(state: State<'_, AppState>) -> Result<Vec<PeerRecord>, String> {
    let mut by_id = std::collections::HashMap::new();
    for peer in state
        .lanchat
        .store
        .list_peers()
        .map_err(|e| e.to_string())?
    {
        by_id.insert(peer.id.clone(), peer);
    }
    for peer in state.lanchat.peers.read().await.values().cloned() {
        by_id.insert(peer.id.clone(), peer);
    }
    let mut roster: Vec<PeerRecord> = by_id.into_values().collect();
    roster.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(roster)
}

/// Read this node's local profile.
#[tauri::command]
pub async fn lanchat_get_profile(state: State<'_, AppState>) -> Result<Profile, String> {
    ensure_ready(&state).await?;
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
    ensure_ready(&state).await?;
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

/// A pinned peer identity record (trust-on-first-use).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PinnedPeer {
    pub node_id: String,
    pub first_seen: i64,
    pub last_seen: i64,
}

/// List pinned peer identities (the verified-on-first-use record).
#[tauri::command]
pub async fn lanchat_list_pinned(state: State<'_, AppState>) -> Result<Vec<PinnedPeer>, String> {
    Ok(state
        .lanchat
        .store
        .list_pins()
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|(node_id, first_seen, last_seen)| PinnedPeer {
            node_id,
            first_seen,
            last_seen,
        })
        .collect())
}

/// Forget a peer's pinned identity so the next connection re-pins it (use after a
/// peer legitimately reinstalled and now presents a new identity).
#[tauri::command]
pub async fn lanchat_retrust_peer(
    state: State<'_, AppState>,
    node_id: String,
) -> Result<(), String> {
    state
        .lanchat
        .store
        .clear_pin(&node_id)
        .map_err(|e| e.to_string())
}
