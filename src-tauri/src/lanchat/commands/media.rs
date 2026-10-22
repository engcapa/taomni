use super::readiness::ensure_ready;
use crate::state::AppState;
use tauri::AppHandle;
use tauri::State;

/* ----------------------------- Native A/V media (v4, Linux stack) ----------------------------- */

/// Start a native media session for `call_id`: spawn its loopback WS relay and
/// return the port the webview connects to. Idempotent — returns the existing
/// port if the session already exists.
#[tauri::command]
pub async fn nmedia_start(
    state: State<'_, AppState>,
    call_id: String,
    window: tauri::WebviewWindow,
) -> Result<u16, String> {
    use tauri::Manager as _;
    let generation =
        crate::webview_recovery::output_generation(window.app_handle(), window.label());
    ensure_ready(&state).await?;
    if !crate::webview_recovery::renderer_is_current(
        window.app_handle(),
        window.label(),
        generation,
    ) {
        return Err("Media owner expired".into());
    }
    let lan = &state.lanchat;
    if let Some(existing) = lan.media_sessions.read().await.get(&call_id) {
        return Ok(existing.ws_port());
    }
    let session =
        crate::lanchat::media::NativeMediaSession::start(lan.clone(), call_id.clone()).await?;
    let port = session.ws_port();
    let mut sessions = lan.media_sessions.write().await;
    if !crate::webview_recovery::renderer_is_current(
        window.app_handle(),
        window.label(),
        generation,
    ) {
        session.stop();
        return Err("Media owner expired".into());
    }
    sessions.insert(call_id, session);
    Ok(port)
}

/// Tear down a native media session (releases the relay + capture/encoders).
#[tauri::command]
pub async fn nmedia_stop(state: State<'_, AppState>, call_id: String) -> Result<(), String> {
    if let Some(session) = state.lanchat.media_sessions.write().await.remove(&call_id) {
        session.stop();
    }
    Ok(())
}

/// The loopback WS port for an active native media session.
#[tauri::command]
pub async fn nmedia_ws_port(state: State<'_, AppState>, call_id: String) -> Result<u16, String> {
    state
        .lanchat
        .media_sessions
        .read()
        .await
        .get(&call_id)
        .map(|s| s.ws_port())
        .ok_or_else(|| format!("no native media session for {call_id}"))
}

/// Register a peer in a native media session (start exchanging media with it).
#[tauri::command]
pub async fn nmedia_add_peer(
    state: State<'_, AppState>,
    call_id: String,
    peer_id: String,
) -> Result<(), String> {
    let session = state
        .lanchat
        .media_sessions
        .read()
        .await
        .get(&call_id)
        .cloned();
    match session {
        Some(s) => {
            s.add_peer(&peer_id).await;
            Ok(())
        }
        None => Err(format!("no native media session for {call_id}")),
    }
}

/// Remove a peer from a native media session (stop media + drop its tile).
#[tauri::command]
pub async fn nmedia_remove_peer(
    state: State<'_, AppState>,
    call_id: String,
    peer_id: String,
) -> Result<(), String> {
    if let Some(s) = state
        .lanchat
        .media_sessions
        .read()
        .await
        .get(&call_id)
        .cloned()
    {
        s.remove_peer(&peer_id).await;
    }
    Ok(())
}

/// Forward a remote peer's mic/cam/screen state into the relay (so the webview
/// updates its tile). Driven by the `media-state` signaling frame.
#[tauri::command]
pub async fn nmedia_peer_state(
    state: State<'_, AppState>,
    call_id: String,
    peer_id: String,
    mic: bool,
    cam: bool,
    screen: bool,
) -> Result<(), String> {
    if let Some(s) = state
        .lanchat
        .media_sessions
        .read()
        .await
        .get(&call_id)
        .cloned()
    {
        s.peer_state(&peer_id, mic, cam, screen);
    }
    Ok(())
}

/// Toggle the local microphone for a native media session (mutes the outgoing
/// Opus stream without stopping capture).
#[tauri::command]
pub async fn nmedia_toggle_mic(
    state: State<'_, AppState>,
    call_id: String,
    on: bool,
) -> Result<(), String> {
    if let Some(s) = state
        .lanchat
        .media_sessions
        .read()
        .await
        .get(&call_id)
        .cloned()
    {
        s.set_mic(on);
    }
    Ok(())
}

/// Start/stop native screen sharing for a call (X11 capture + H.264 to peers).
#[tauri::command]
pub async fn nmedia_toggle_screen(
    app: AppHandle,
    state: State<'_, AppState>,
    call_id: String,
    on: bool,
) -> Result<(), String> {
    let session = state
        .lanchat
        .media_sessions
        .read()
        .await
        .get(&call_id)
        .cloned();
    match session {
        Some(s) => s.set_screen(app, state.lanchat.clone(), on).await,
        None => Err(format!("no native media session for {call_id}")),
    }
}

/// Start/stop the native camera for a call (nokhwa capture + H.264 to peers).
#[tauri::command]
pub async fn nmedia_toggle_cam(
    state: State<'_, AppState>,
    call_id: String,
    on: bool,
) -> Result<(), String> {
    let session = state
        .lanchat
        .media_sessions
        .read()
        .await
        .get(&call_id)
        .cloned();
    match session {
        Some(s) => s.set_cam(state.lanchat.clone(), on).await,
        None => Err(format!("no native media session for {call_id}")),
    }
}
