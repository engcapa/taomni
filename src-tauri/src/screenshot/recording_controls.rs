use super::RECORDER_LABEL;
use super::capture;
use super::overlay_session::watch_session_window;
use super::runtime::tool_state;
use super::scroll_controls::capture_control_position;
#[cfg(target_os = "linux")]
use super::surface_backend;
use super::surfaces;
use super::window_lifecycle::focus_capture_window;
use super::window_lifecycle::window_builder;
use crate::screenshot::capture::DisplayInfo;
use std::sync::Mutex;
use std::time::Duration;
use tauri::AppHandle;
use tauri::Manager;
use tauri::PhysicalPosition;
use tauri::PhysicalSize;
use tauri::WebviewUrl;
// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

pub(super) fn recording_region(
    x: Option<u32>,
    y: Option<u32>,
    width: Option<u32>,
    height: Option<u32>,
) -> Result<Option<(u32, u32, u32, u32)>, String> {
    match (x, y, width, height) {
        (None, None, None, None) => Ok(None),
        (Some(x), Some(y), Some(w), Some(h)) if w >= 2 && h >= 2 => Ok(Some((x, y, w, h))),
        (Some(_), Some(_), Some(_), Some(_)) => {
            Err("recording region must be at least 2x2 pixels".into())
        }
        _ => Err("recording region requires x, y, width and height together".into()),
    }
}

pub(crate) fn recording_ended(app: &AppHandle, id: &str) {
    if tool_state().recording.as_deref() != Some(id) {
        return;
    }
    surfaces::close_borders(app);
    if let Some(window) = app.get_webview_window(RECORDER_LABEL) {
        let _ = window.show();
        tauri::async_runtime::spawn(async move {
            focus_capture_window(&window).await;
        });
    }
}

pub(super) async fn open_recorder_bar(
    app: &AppHandle,
    display: &DisplayInfo,
    region: (u32, u32, u32, u32),
) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(RECORDER_LABEL) {
        let _ = existing.close();
    }
    let url = WebviewUrl::App("index.html#screenshot-recorder".into());
    // Compact while recording; the bar grows itself for the preview.
    let (lw, lh) = (surfaces::CONTROL_WIDTH, surfaces::CONTROL_HEIGHT);
    let rect = surfaces::region_rect(
        display,
        capture::clamp_region(display.width, display.height, region),
    );
    let position = capture_control_position(app, display, rect)?;
    surfaces::open_borders(app, display, rect)?;
    let (loaded_tx, loaded_rx) = tokio::sync::oneshot::channel();
    let loaded_tx = Mutex::new(Some(loaded_tx));
    let window = window_builder(app, RECORDER_LABEL, url)
        .title("Recording")
        .inner_size(lw, lh)
        .visible(false)
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .content_protected(surfaces::PROTECT_CAPTURE_SURFACES)
        .on_page_load(move |_, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                if let Some(tx) = loaded_tx.lock().unwrap().take() {
                    let _ = tx.send(());
                }
            }
        })
        .build()
        .map_err(|e| format!("open recorder bar: {e}"))?;
    crate::webview_recovery::install_capture_control(&window);
    #[cfg(target_os = "linux")]
    surface_backend::webview(&window)?;
    watch_session_window(&window);
    // Bottom-center of the recorded display.
    let s = display.scale_factor.max(0.5);
    let (pw, ph) = position
        .map(|p| (p.rect.w, p.rect.h))
        .unwrap_or(((lw * s) as i32, (lh * s) as i32));
    let x = display.x + (display.width as i32 - pw) / 2;
    // Leave room above for the grown preview (240 logical px).
    let y = display.y + display.height as i32 - ph - (240.0 * s) as i32;
    let (x, y) = position.map(|p| (p.rect.x, p.rect.y)).unwrap_or((x, y));
    #[cfg(target_os = "linux")]
    if let Some(position) = position {
        surface_backend::place_webview(&window, position)?;
    } else {
        window
            .set_size(PhysicalSize::new(pw as u32, ph as u32))
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "linux"))]
    {
        window
            .set_position(PhysicalPosition::new(x, y))
            .map_err(|e| format!("position recording controls: {e}"))?;
        window
            .set_size(PhysicalSize::new(pw as u32, ph as u32))
            .map_err(|e| format!("size recording controls: {e}"))?;
    }
    // Finish loading and mapping the controls before the first recording
    // snapshot. Creating a hidden WebView does not finish its navigation;
    // showing it after capture starts can stall WindowServer and lose motion.
    if position.is_some() {
        window
            .show()
            .map_err(|e| format!("show recording controls: {e}"))?;
    }
    tokio::time::timeout(Duration::from_secs(15), loaded_rx)
        .await
        .map_err(|_| "recording controls did not load within 15 s".to_string())?
        .map_err(|_| "recording controls closed before loading".to_string())?;
    Ok(())
}
