use super::OVERLAY_LABEL;
use super::RECORDER_LABEL;
use super::capture;
use super::overlay_open::open_overlay_inner;
#[cfg(target_os = "linux")]
use super::pins;
use super::record;
use super::runtime::OPENING;
use super::runtime::SESSION_GENERATION;
use super::runtime::STARTING_RECORDING;
use super::runtime::internal_error;
use super::runtime::tool_state;
use super::session;
use super::surfaces;
use super::window_lifecycle::restore_app_windows;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use tauri::AppHandle;
use tauri::Manager;
use tauri::WebviewWindow;
/// Hide app windows, capture `display_id` (default: the display under the
/// pointer) and open the annotation overlay on it. Re-entrant calls while an
/// overlay is opening/open just focus the existing one; while a recording
/// runs they focus the recorder bar.
pub async fn open_overlay(app: &AppHandle, display_id: Option<String>) -> Result<(), String> {
    open_overlay_with_window(app, display_id, None).await
}

pub(super) async fn open_overlay_with_window(
    app: &AppHandle,
    display_id: Option<String>,
    current_window: Option<WebviewWindow>,
) -> Result<(), String> {
    if STARTING_RECORDING.load(Ordering::SeqCst) {
        return Ok(());
    }
    let recording = {
        let state = tool_state();
        if state.scroll.is_some() {
            // Start is not Stop. Another instance can own this global chord.
            return Ok(());
        }
        state.recording.clone()
    };
    if let Some(id) = recording {
        // Finish before showing any controls: full-display capture has no
        // safe location for a visible bar, even when content protection is unavailable.
        record::request_stop(&id).map_err(internal_error)?;
        return Ok(());
    }
    if let Some(label) = {
        let state = tool_state();
        if state.recording.is_some() || state.recorder_open {
            Some(RECORDER_LABEL)
        } else if state.overlay.is_some() {
            Some(OVERLAY_LABEL)
        } else {
            None
        }
    } {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.show();
            let _ = window.set_focus();
        }
        return Ok(());
    }
    if OPENING.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let lease = session::SessionLease::acquire();
    match lease {
        Ok(Some(lease)) => tool_state().session_lease = Some(Arc::new(lease)),
        Ok(None) => {
            OPENING.store(false, Ordering::SeqCst);
            return Ok(());
        }
        Err(error) => {
            OPENING.store(false, Ordering::SeqCst);
            return Err(error);
        }
    }
    let result = open_overlay_inner(app, display_id, current_window).await;
    OPENING.store(false, Ordering::SeqCst);
    if result.is_err() {
        // Never leave the user with no visible window.
        tool_state().overlay = None;
        super::overlay_resident::forget();
        if let Some(window) = app.get_webview_window(OVERLAY_LABEL) {
            let _ = window.close();
        }
        restore_app_windows(app);
        capture::purge_tracked();
        tool_state().session_lease = None;
    }
    result
}

pub(super) fn watch_session_window(window: &WebviewWindow) {
    let app = window.app_handle().clone();
    let label = window.label().to_string();
    window.on_window_event(move |event| {
        if !matches!(
            event,
            tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed
        ) {
            return;
        }
        let active = {
            let state = tool_state();
            if label == OVERLAY_LABEL {
                state.overlay.is_some()
            } else {
                state.recorder_open
            }
        };
        if label == OVERLAY_LABEL {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if let Some(cleanup) = super::overlay_resident::intercept_close() {
                    api.prevent_close();
                    if cleanup {
                        let app = app.clone();
                        tauri::async_runtime::spawn_blocking(move || close_session(&app));
                    }
                    return;
                }
            }
            if matches!(event, tauri::WindowEvent::Destroyed) {
                super::overlay_resident::forget();
            }
        }
        #[cfg(target_os = "linux")]
        if matches!(event, tauri::WindowEvent::CloseRequested { .. }) && pins::native_wayland() {
            let ends_session = label != OVERLAY_LABEL || active;
            log::info!("capture close requested: label={label}, ends_session={ends_session}");
            // GTK still has the focused source surface here. Destroyed is too
            // late to authorize activation of a minimized Wayland toplevel.
            // A selection overlay closed after starting recording has already
            // transferred ownership to the recorder; it must not restore yet.
            if ends_session {
                restore_app_windows(&app);
            }
        }
        if matches!(event, tauri::WindowEvent::Destroyed) {
            if active {
                let app = app.clone();
                // Joining recorder threads must not block the event loop.
                tauri::async_runtime::spawn_blocking(move || close_session(&app));
            }
        }
    });
}

pub(crate) fn close_session(app: &AppHandle) {
    SESSION_GENERATION.fetch_add(1, Ordering::SeqCst);
    let recording = {
        let mut state = tool_state();
        state.overlay = None;
        state.recorder_open = false;
        state.recording_region = None;
        state.include_current_window = false;
        if let Some(control) = state.scroll.take() {
            control.request_stop(true);
        }
        state
            .recording
            .take()
            .or_else(|| state.recording_preview.take())
    };
    if let Some(id) = recording {
        let _ = record::cancel_recording(&id);
    }
    // Wayland activation tokens need the currently focused selection surface.
    // Request restoration before destroying that surface and its input serial.
    #[cfg(target_os = "linux")]
    if pins::native_wayland() {
        restore_app_windows(app);
    }
    surfaces::close_borders(app);
    for label in [OVERLAY_LABEL, RECORDER_LABEL, surfaces::SCROLL_LABEL] {
        if let Some(window) = app.get_webview_window(label) {
            if label == OVERLAY_LABEL {
                match super::overlay_resident::retire(&window) {
                    Ok(true) => continue,
                    Ok(false) => {}
                    Err(error) => log::warn!("resident screenshot reset failed; closing: {error}"),
                }
                super::overlay_resident::forget();
            }
            let _ = window.close();
        }
    }
    restore_app_windows(app);
    capture::purge_tracked();
    tool_state().session_lease = None;
}
