use super::OVERLAY_LABEL;
use super::RECORDER_LABEL;
use super::capture;
use super::model::OverlayInit;
use super::model::PhysicalRegion;
use super::pins;
use super::record;
use super::runtime::OPENING;
use super::runtime::SESSION_GENERATION;
use super::runtime::STARTING_RECORDING;
use super::runtime::blocking;
use super::runtime::internal_error;
use super::runtime::tool_state;
use super::session;
use super::surfaces;
use super::window_lifecycle::HIDE_SETTLE;
use super::window_lifecycle::await_hidden_windows;
use super::window_lifecycle::cover_display;
use super::window_lifecycle::focus_capture_window;
use super::window_lifecycle::hide_app_windows;
use super::window_lifecycle::restore_app_windows;
use super::window_lifecycle::window_builder;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use tauri::AppHandle;
use tauri::Manager;
use tauri::WebviewUrl;
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
        if let Some(window) = app.get_webview_window(OVERLAY_LABEL) {
            let _ = window.close();
        }
        restore_app_windows(app);
        capture::purge_tracked();
        tool_state().session_lease = None;
    }
    result
}

pub(super) async fn open_overlay_inner(
    app: &AppHandle,
    display_id: Option<String>,
    current_window: Option<WebviewWindow>,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    if current_window.is_some() && pins::native_wayland() {
        // GDK returns a synthetic origin on Wayland. It must never be used
        // as a crop of the first output (or rejected only on another output).
        return Err("Wayland does not expose the current window's screen coordinates. Use Screen region and select the window on the desired display.".into());
    }
    let generation = SESSION_GENERATION.load(Ordering::SeqCst);
    capture::request_capture_permission(app)
        .await
        .map_err(internal_error)?;
    if SESSION_GENERATION.load(Ordering::SeqCst) != generation {
        return Err("screenshot opening was cancelled".into());
    }
    let display = {
        let app = app.clone();
        blocking("display lookup", move || match display_id {
            Some(id) if !id.trim().is_empty() => capture::resolve_display(&app, Some(&id)),
            _ => capture::display_at_cursor(&app),
        })
        .await?
    };
    let window_region = if let Some(window) = &current_window {
        let pos = window.outer_position().map_err(|e| e.to_string())?;
        let size = window.outer_size().map_err(|e| e.to_string())?;
        let left = (pos.x - display.x).max(0) as u32;
        let top = (pos.y - display.y).max(0) as u32;
        let right = (pos.x as i64 + size.width as i64 - display.x as i64)
            .clamp(0, display.width as i64) as u32;
        let bottom = (pos.y as i64 + size.height as i64 - display.y as i64)
            .clamp(0, display.height as i64) as u32;
        if right <= left || bottom <= top {
            return Err("current window is outside the selected display".into());
        }
        Some(PhysicalRegion {
            x: left,
            y: top,
            width: right - left,
            height: bottom - top,
        })
    } else {
        None
    };
    tool_state().include_current_window = current_window.is_some();
    if current_window.is_none() && hide_app_windows(app) {
        await_hidden_windows(app).await?;
    } else if current_window.is_some() {
        // Let the invoking options menu disappear before freezing the window.
        tokio::time::sleep(HIDE_SETTLE).await;
    }
    let (path, width, height) = {
        let app = app.clone();
        let display = display.clone();
        blocking("capture", move || {
            let image = capture::capture_display(&app, &display)?;
            capture::save_png(&image, "shot")
        })
        .await?
    };
    if SESSION_GENERATION.load(Ordering::SeqCst) != generation {
        std::fs::remove_file(path).ok();
        return Err("screenshot opening was cancelled".into());
    }
    tool_state().overlay = Some(OverlayInit {
        path: path.to_string_lossy().into_owned(),
        display_id: display.id.clone(),
        width,
        height,
        scale_factor: display.scale_factor,
        window_region,
        document: false,
        source_pin: None,
    });

    let url = WebviewUrl::App("index.html#screenshot-overlay".into());
    let window = window_builder(app, OVERLAY_LABEL, url)
        .title("Screenshot")
        .visible(false)
        .decorations(false)
        .resizable(false)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .build()
        .map_err(|e| format!("open overlay window: {e}"))?;
    watch_session_window(&window);
    cover_display(&window, &display).await?;
    window
        .show()
        .map_err(|e| format!("show overlay window: {e}"))?;
    focus_capture_window(&window).await;
    Ok(())
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
            let _ = window.close();
        }
    }
    restore_app_windows(app);
    capture::purge_tracked();
    tool_state().session_lease = None;
}
