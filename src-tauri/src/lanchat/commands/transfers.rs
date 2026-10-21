use super::readiness::ensure_ready;
use crate::lanchat::store::direct_conv_id;
use crate::lanchat::swarm;
use crate::lanchat::transfer;
use crate::state::AppState;
use tauri::AppHandle;
use tauri::State;

/* ----------------------------- transfers (task 02) ----------------------------- */

/// Offer a file to a single peer (a swarm of one). Returns the content file id
/// (the transfer id); progress arrives on `lanchat://transfer`.
#[tauri::command]
pub async fn lanchat_send_file(
    app: AppHandle,
    state: State<'_, AppState>,
    peer_id: String,
    path: String,
) -> Result<String, String> {
    ensure_ready(&state).await?;
    let conv = direct_conv_id(&peer_id);
    swarm::send(
        &app,
        &state.lanchat,
        vec![peer_id.clone()],
        vec![peer_id],
        std::path::PathBuf::from(path),
        conv,
        None,
    )
    .await
}

/// Offer a file to every member of a group (swarm fan-out; members also trade
/// pieces with each other). Returns the content file id.
#[tauri::command]
pub async fn lanchat_send_group_file(
    app: AppHandle,
    state: State<'_, AppState>,
    group_id: String,
    path: String,
) -> Result<String, String> {
    ensure_ready(&state).await?;
    swarm::send_to_group(
        &app,
        &state.lanchat,
        &group_id,
        std::path::PathBuf::from(path),
    )
    .await
}

/// Accept an inbound file offer. Pass an empty `save_path` to use the default
/// downloads location. Returns the resolved save path.
#[tauri::command]
pub async fn lanchat_accept_file(
    app: AppHandle,
    state: State<'_, AppState>,
    transfer_id: String,
    save_path: String,
) -> Result<String, String> {
    ensure_ready(&state).await?;
    swarm::accept_offer(
        &app,
        &state.lanchat,
        &transfer_id,
        std::path::PathBuf::from(save_path),
    )
    .await
}

/// Open a received file (or its folder) with the OS default handler.
#[tauri::command]
pub async fn lanchat_open_path(path: String) -> Result<(), String> {
    transfer::open_path(&path)
}

/* ----------------------------- A/V signaling (task 03) ----------------------------- */

/// Send a WebRTC signaling frame to a single peer (call-*/signal-*/media-state).
#[tauri::command]
pub async fn lanchat_send_signal(
    app: AppHandle,
    state: State<'_, AppState>,
    peer_id: String,
    frame_type: String,
    payload: serde_json::Value,
) -> Result<(), String> {
    ensure_ready(&state).await?;
    let my_id = state.lanchat.node_id().await;
    let env = crate::lanchat::protocol::Envelope::new(
        &frame_type,
        &my_id,
        Some(peer_id.clone()),
        payload,
    );
    crate::lanchat::transport::send_to_peer(&app, &state.lanchat, &peer_id, env).await
}

/// Broadcast a signaling frame to all members of a group (meeting fan-out).
#[tauri::command]
pub async fn lanchat_signal_group(
    app: AppHandle,
    state: State<'_, AppState>,
    group_id: String,
    frame_type: String,
    payload: serde_json::Value,
) -> Result<(), String> {
    ensure_ready(&state).await?;
    let my_id = state.lanchat.node_id().await;
    let members = state
        .lanchat
        .store
        .list_group_members(&group_id)
        .map_err(|e| e.to_string())?;
    for member in members {
        if member == my_id {
            continue;
        }
        let env = crate::lanchat::protocol::Envelope::new(
            &frame_type,
            &my_id,
            Some(member.clone()),
            payload.clone(),
        );
        let _ = crate::lanchat::transport::send_to_peer(&app, &state.lanchat, &member, env).await;
    }
    Ok(())
}

/// Reject an inbound file offer.
#[tauri::command]
pub async fn lanchat_reject_file(
    app: AppHandle,
    state: State<'_, AppState>,
    transfer_id: String,
) -> Result<(), String> {
    ensure_ready(&state).await?;
    swarm::reject_offer(&app, &state.lanchat, &transfer_id).await
}
#[tauri::command]
pub async fn lanchat_send_dir(
    app: AppHandle,
    state: State<'_, AppState>,
    peer_id: String,
    path: String,
) -> Result<String, String> {
    ensure_ready(&state).await?;
    let conv = direct_conv_id(&peer_id);
    swarm::send_dir(
        &app,
        &state.lanchat,
        vec![peer_id],
        std::path::PathBuf::from(path),
        conv,
        None,
    )
    .await
}

/// Pause / resume / cancel a transfer (`action`: "pause" | "resume" | "cancel").
#[tauri::command]
pub async fn lanchat_transfer_control(
    app: AppHandle,
    state: State<'_, AppState>,
    transfer_id: String,
    action: String,
) -> Result<(), String> {
    swarm::control(&app, &state.lanchat, &transfer_id, &action).await
}
