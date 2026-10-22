use super::labels::OVERLAY_LABEL;
use crate::screenshot::capture;
use crate::screenshot::edit;
use crate::screenshot::model::PhysicalRegion;
use crate::screenshot::pins;
use crate::screenshot::runtime::SESSION_GENERATION;
use crate::screenshot::runtime::blocking;
use crate::screenshot::runtime::capture_lease;
use crate::screenshot::runtime::internal_error;
use crate::screenshot::runtime::tool_state;
use crate::screenshot::scroll;
use crate::screenshot::scroll::ScrollCaptureResult;
use crate::screenshot::scroll_controls::open_scroll_bar;
use crate::screenshot::scroll_controls::scroll_layout;
use crate::screenshot::scroll_input;
use crate::screenshot::surfaces;
use crate::screenshot::window_lifecycle::focus_capture_window;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use tauri::AppHandle;
use tauri::Manager;

/// Scrolling capture of a display-relative physical region. The overlay is
/// hidden for the duration (it would be captured and swallow the wheel) and
/// shown again afterwards, success or not.
#[tauri::command]
pub async fn screenshot_scroll_capture(
    app: AppHandle,
    display_id: Option<String>,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    mode: Option<scroll::ScrollMode>,
) -> Result<ScrollCaptureResult, String> {
    // Retain ownership until the worker and stop listener have both left, even
    // if closing the overlay clears ToolState while cancellation is pending.
    let _capture_lease = capture_lease()?;
    // Fail while the selection UI can still show the instructions, before
    // hiding it or creating topmost controls. Never prompt from the worker.
    let mode = mode.unwrap_or_default();
    if mode == scroll::ScrollMode::Auto {
        scroll::ensure_control_permission().map_err(internal_error)?;
    }
    let display = capture::resolve_display(&app, display_id.as_deref()).map_err(internal_error)?;
    let requested = capture::clamp_region(display.width, display.height, (x, y, width, height));
    let (region, position) = scroll_layout(&app, &display, requested)?;
    let rect = surfaces::region_rect(&display, region);
    let control = Arc::new(scroll::ScrollControl::new(mode));
    {
        let mut state = tool_state();
        if state.scroll.is_some() || state.recorder_open {
            return Err("a capture is already running".into());
        }
        state.scroll = Some(control.clone());
    }
    // Establish an independent exit before hiding the overlay. Wayland keeps
    // its visible input strip because the compositor owns global input.
    let stop_input = if pins::native_wayland() {
        None
    } else {
        match scroll_input::StopInput::start(&app, control.clone()) {
            Ok(input) => Some(input),
            Err(error) => {
                tool_state().scroll = None;
                return Err(error);
            }
        }
    };
    let generation = SESSION_GENERATION.load(Ordering::SeqCst);
    let overlay = app.get_webview_window(OVERLAY_LABEL);
    if let Some(window) = &overlay {
        let _ = window.hide();
    }
    let surfaces = surfaces::open_borders(&app, &display, rect)
        .and_then(|()| open_scroll_bar(&app, &display, position, control.clone()));
    if let Err(error) = surfaces {
        tool_state().scroll = None;
        surfaces::close_borders(&app);
        if let Some(window) = app.get_webview_window(surfaces::SCROLL_LABEL) {
            let _ = window.close();
        }
        if let Some(window) = &overlay {
            let _ = window.show();
        }
        return Err(error);
    }
    let editor_display = display.clone();
    let worker = app.clone();
    let worker_control = control.clone();
    let result = blocking("scroll capture", move || {
        scroll::scroll_capture_controlled(&worker, &display, region, u32::MAX, &worker_control)
    })
    .await;
    drop(stop_input);
    if SESSION_GENERATION.load(Ordering::SeqCst) != generation {
        return Err("scroll capture cancelled".into());
    }
    tool_state().scroll = None;
    surfaces::close_borders(&app);
    if let Some(window) = app.get_webview_window(surfaces::SCROLL_LABEL) {
        let _ = window.close();
    }
    if let Some(window) = overlay {
        if result.is_ok() {
            edit::reset_hidden_surface(&window).await?;
            edit::configure_document_window(&window, &editor_display)?;
        }
        let _ = window.show();
        if result.is_ok() {
            edit::settle_document_window(&window, &editor_display).await?;
        }
        focus_capture_window(&window).await;
    }
    result
}

#[tauri::command]
pub async fn screenshot_scroll_surface() -> bool {
    false
}

#[tauri::command]
pub async fn screenshot_scroll_plan(
    app: AppHandle,
    display_id: Option<String>,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
) -> Result<PhysicalRegion, String> {
    let display = capture::resolve_display(&app, display_id.as_deref()).map_err(internal_error)?;
    let requested = capture::clamp_region(display.width, display.height, (x, y, width, height));
    let (region, _) = scroll_layout(&app, &display, requested)?;
    Ok(PhysicalRegion {
        x: region.0,
        y: region.1,
        width: region.2,
        height: region.3,
    })
}

#[tauri::command]
pub async fn screenshot_scroll_status() -> Result<Option<serde_json::Value>, String> {
    Ok(tool_state().scroll.as_ref().map(|control| control.status()))
}

#[tauri::command]
pub async fn screenshot_set_scroll_mode(mode: scroll::ScrollMode) -> Result<(), String> {
    if mode == scroll::ScrollMode::Auto {
        scroll::ensure_control_permission().map_err(internal_error)?;
    }
    if let Some(control) = &tool_state().scroll {
        control.set_mode(mode);
    }
    Ok(())
}

#[tauri::command]
pub async fn screenshot_stop_scroll_capture(cancel: bool) -> Result<(), String> {
    if let Some(control) = &tool_state().scroll {
        control.request_stop(cancel);
    }
    Ok(())
}
