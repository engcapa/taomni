use super::readiness::ensure_ready;
use crate::lanchat::store::direct_conv_id;
use crate::lanchat::swarm;
use crate::lanchat::transfer;
use crate::state::AppState;
use tauri::AppHandle;
use tauri::State;

/// Capture the primary screen and send it to a peer as a PNG.
#[tauri::command]
pub async fn lanchat_send_screenshot(
    app: AppHandle,
    state: State<'_, AppState>,
    peer_id: String,
) -> Result<String, String> {
    ensure_ready(&state).await?;
    let log = crate::servers::engine::LogEmitter::new(app.clone(), crate::servers::ServerType::Rdp);
    let path = tokio::task::spawn_blocking(move || transfer::capture_screenshot(&log))
        .await
        .map_err(|e| e.to_string())??;
    let conv = direct_conv_id(&peer_id);
    swarm::send(
        &app,
        &state.lanchat,
        vec![peer_id.clone()],
        vec![peer_id],
        path,
        conv,
        None,
    )
    .await
}

/// Send a pre-encoded PNG (base64) to a peer as a file. Used as the webview
/// screenshot fallback when native screen capture (the `screen-capture` build
/// feature) is unavailable — e.g. macOS, or any default build.
#[tauri::command]
pub async fn lanchat_send_image_bytes(
    app: AppHandle,
    state: State<'_, AppState>,
    peer_id: String,
    data: String,
) -> Result<String, String> {
    ensure_ready(&state).await?;
    use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
    let bytes = BASE64
        .decode(data.as_bytes())
        .map_err(|e| format!("decode image: {e}"))?;
    let path = transfer::save_png_bytes(&bytes)?;
    let conv = direct_conv_id(&peer_id);
    swarm::send(
        &app,
        &state.lanchat,
        vec![peer_id.clone()],
        vec![peer_id],
        path,
        conv,
        None,
    )
    .await
}
#[tauri::command]
pub async fn lanchat_send_clipboard_image(
    app: AppHandle,
    state: State<'_, AppState>,
    peer_id: String,
) -> Result<String, String> {
    ensure_ready(&state).await?;
    let path = {
        let mut guard = state
            .clipboard
            .lock()
            .map_err(|_| "clipboard lock".to_string())?;
        if guard.is_none() {
            *guard = Some(arboard::Clipboard::new().map_err(|e| e.to_string())?);
        }
        let cb = guard.as_mut().unwrap();
        let img = cb.get_image().map_err(|_| "剪贴板中没有图片".to_string())?;
        transfer::save_rgba_png(img.width as u32, img.height as u32, &img.bytes)?
    };
    let conv = direct_conv_id(&peer_id);
    swarm::send(
        &app,
        &state.lanchat,
        vec![peer_id.clone()],
        vec![peer_id],
        path,
        conv,
        None,
    )
    .await
}
