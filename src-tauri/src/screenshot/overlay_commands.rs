use super::initialization::init;
use super::labels::OVERLAY_LABEL;
use crate::screenshot::capture;
use crate::screenshot::edit;
use crate::screenshot::model::OverlayInit;
use crate::screenshot::overlay_session::close_session;
use crate::screenshot::overlay_session::open_overlay_with_window;
use crate::screenshot::pins;
use crate::screenshot::runtime::SESSION_GENERATION;
use crate::screenshot::runtime::blocking;
use crate::screenshot::runtime::capture_lease;
use crate::screenshot::runtime::internal_error;
use crate::screenshot::runtime::tool_state;
use crate::screenshot::window_lifecycle::HIDE_SETTLE;
use crate::screenshot::window_lifecycle::cover_display;
use crate::screenshot::window_lifecycle::focus_capture_window;
use std::sync::atomic::Ordering;
use tauri::AppHandle;
use tauri::Manager;
use tauri::WebviewWindow;

/// Tauri command wrapper for [`open_overlay`].
#[tauri::command]
pub async fn screenshot_open_overlay(
    app: AppHandle,
    window: WebviewWindow,
    display_id: Option<String>,
    include_current_window: Option<bool>,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    let display_id =
        if display_id.as_ref().is_none_or(|id| id.trim().is_empty()) && pins::native_wayland() {
            let worker = app.clone();
            let caller = window.clone();
            Some(
                blocking("invoking display", move || {
                    capture::display_for_window(&worker, &caller)
                })
                .await?
                .id,
            )
        } else {
            display_id
        };
    open_overlay_with_window(
        &app,
        display_id,
        include_current_window.unwrap_or(false).then_some(window),
    )
    .await
}

/// The pending overlay payload, set by [`open_overlay`].
#[tauri::command]
pub async fn screenshot_overlay_init() -> Result<OverlayInit, String> {
    tool_state()
        .overlay
        .clone()
        .ok_or_else(|| "no pending screenshot overlay".to_string())
}

/// Switch the selection surface to another physical display without ending
/// the screenshot session or requiring Taomni itself to move there.
#[tauri::command]
pub async fn screenshot_switch_display(
    app: AppHandle,
    window: WebviewWindow,
    display_id: String,
) -> Result<OverlayInit, String> {
    let _lease = capture_lease()?;
    {
        let state = tool_state();
        if window.label() != OVERLAY_LABEL
            || state.overlay.as_ref().is_none_or(|o| o.document)
            || state.scroll.is_some()
        {
            return Err("not a display selection session".into());
        }
    }
    let generation = SESSION_GENERATION.load(Ordering::SeqCst);
    let worker = app.clone();
    let display = blocking("display lookup", move || {
        capture::resolve_display(&worker, Some(&display_id))
    })
    .await?;
    window.hide().map_err(|e| e.to_string())?;
    tokio::time::sleep(HIDE_SETTLE).await;
    let worker = app.clone();
    let captured_display = display.clone();
    let captured = blocking("capture display", move || {
        capture::save_png(
            &capture::capture_display(&worker, &captured_display)?,
            "shot",
        )
    })
    .await;
    if SESSION_GENERATION.load(Ordering::SeqCst) != generation {
        return Err("screenshot opening was cancelled".into());
    }
    let result = captured.map(|(path, width, height)| OverlayInit {
        path: path.to_string_lossy().into_owned(),
        display_id: display.id.clone(),
        width,
        height,
        scale_factor: display.scale_factor,
        window_region: None,
        document: false,
        source_pin: None,
    });
    if let Ok(init) = &result {
        edit::reset_hidden_surface(&window).await?;
        if let Err(error) = cover_display(&window, &display).await {
            let _ = window.show();
            return Err(error);
        }
        tool_state().overlay = Some(init.clone());
    }
    let _ = window.show();
    focus_capture_window(&window).await;
    result
}

/// The overlay replaced its background (scroll capture result).
#[tauri::command]
pub async fn screenshot_overlay_update(
    path: String,
    width: u32,
    height: u32,
) -> Result<(), String> {
    capture::ensure_artifact_path(&path).map_err(internal_error)?;
    if let Some(overlay) = tool_state().overlay.as_mut() {
        overlay.path = path;
        overlay.width = width;
        overlay.height = height;
        overlay.document = true;
    }
    Ok(())
}

/// End the capture session: close the overlay and recorder bar, reshow the
/// hidden app windows and delete the session's temp files.
#[tauri::command]
pub async fn screenshot_close_overlay(app: AppHandle) -> Result<(), String> {
    close_session(&app);
    Ok(())
}
