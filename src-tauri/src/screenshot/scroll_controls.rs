use super::capture;
use super::runtime::internal_error;
use super::scroll;
use super::shortcut;
#[cfg(target_os = "linux")]
use super::surface_backend;
use super::surfaces;
use super::window_lifecycle::window_builder;
use crate::screenshot::capture::DisplayInfo;
use std::sync::Arc;
use tauri::AppHandle;
use tauri::PhysicalPosition;
use tauri::PhysicalSize;
use tauri::WebviewUrl;
/// Keep controls outside captured pixels. Platforms with session-owned stop
/// input can hide them; Wayland reserves a strip so finishing remains possible.
pub(super) fn scroll_layout(
    app: &AppHandle,
    display: &DisplayInfo,
    requested: (u32, u32, u32, u32),
) -> Result<((u32, u32, u32, u32), Option<surfaces::ControlPosition>), String> {
    let rect = surfaces::region_rect(display, requested);
    let mut displays = capture::list_displays(app).map_err(internal_error)?;
    displays.sort_by_key(|d| d.id != display.id);
    // A full-display or near-full-display selection has no useful place for
    // an auxiliary prompt. Keep every selected pixel and use the session-owned
    // Esc/right-click stop input even when another monitor has spare space.
    let near_full = (rect.w as i64 * 10 >= display.width as i64 * 9)
        && (rect.h as i64 * 10 >= display.height as i64 * 9);
    if near_full {
        #[cfg(target_os = "linux")]
        if crate::servers::rdp::capture::wayland::is_wayland_session() {
            let (capture, controls) =
                surfaces::inside_control_strip(display, rect, scroll::MIN_REGION_HEIGHT as i32)
                    .ok_or_else(|| {
                        "Select a taller region to leave room for scroll capture controls."
                            .to_string()
                    })?;
            return Ok((
                (
                    (capture.x - display.x) as u32,
                    (capture.y - display.y) as u32,
                    capture.w as u32,
                    capture.h as u32,
                ),
                Some(surfaces::ControlPosition {
                    rect: controls,
                    scale: display.scale_factor.max(1.0),
                }),
            ));
        }
        return Ok((requested, None));
    }
    Ok((
        requested,
        surfaces::control_placement(&displays, display, rect),
    ))
}

pub(super) fn capture_control_position(
    app: &AppHandle,
    display: &DisplayInfo,
    region: surfaces::Rect,
) -> Result<Option<surfaces::ControlPosition>, String> {
    let mut displays = capture::list_displays(app).map_err(internal_error)?;
    displays.sort_by_key(|d| d.id != display.id);
    let position = surfaces::control_placement(&displays, display, region);
    if position.is_none() && !shortcut::current_status().registered {
        return Err("No room for controls outside the capture. Select a smaller region or enable the system screenshot hotkey before capturing the whole display.".into());
    }
    Ok(position)
}

pub(super) fn open_scroll_bar(
    app: &AppHandle,
    display: &DisplayInfo,
    position: Option<surfaces::ControlPosition>,
    control: Arc<scroll::ScrollControl>,
) -> Result<(), String> {
    let window = window_builder(
        app,
        surfaces::SCROLL_LABEL,
        WebviewUrl::App("index.html#screenshot-scroll".into()),
    )
    .title("Scroll capture")
    .inner_size(surfaces::CONTROL_WIDTH, surfaces::CONTROL_HEIGHT)
    .visible(false)
    .decorations(false)
    .resizable(false)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .content_protected(surfaces::PROTECT_CAPTURE_SURFACES)
    .focused(false)
    .build()
    .map_err(|e| e.to_string())?;
    crate::webview_recovery::install_capture_control(&window);
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            control.request_stop(true);
        }
    });
    #[cfg(target_os = "linux")]
    surface_backend::webview(&window)?;
    if let Some(position) = position {
        #[cfg(target_os = "linux")]
        surface_backend::place_webview(&window, position)?;
        #[cfg(not(target_os = "linux"))]
        {
            let rect = position.rect;
            window
                .set_size(PhysicalSize::new(rect.w as u32, rect.h as u32))
                .map_err(|e| e.to_string())?;
            window
                .set_position(PhysicalPosition::new(rect.x, rect.y))
                .map_err(|e| e.to_string())?;
        }
        window.show().map_err(|e| e.to_string())?;
    }
    let _ = display;
    Ok(())
}
