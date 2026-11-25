//! Screenshot-specific choice of the invoking display.
pub use crate::capture::displays::DisplayInfo;
use crate::capture::displays::{list_displays, primary_of, resolve_display};
use anyhow::Context;
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// The display under the mouse pointer (hotkey / button trigger), falling
/// back to the primary display.
pub fn display_at_cursor(app: &AppHandle) -> anyhow::Result<DisplayInfo> {
    #[cfg(target_os = "linux")]
    if taomni_capture::engine::wayland::is_wayland_session() {
        // Wayland cannot expose the global cursor; Tao returns a synthetic
        // (0,0). Choose the invoking/main window's monitor before hiding it.
        if let Some(window) = app.get_webview_window("main") {
            return display_for_window(app, &window);
        }
        return resolve_display(app, None);
    }
    let displays = list_displays(app)?;
    if let Ok(pos) = app.cursor_position() {
        if let Some(d) = displays.iter().find(|d| d.contains(pos.x, pos.y)) {
            return Ok(d.clone());
        }
    }
    Ok(primary_of(displays))
}

#[cfg(target_os = "linux")]
pub(in crate::screenshot) fn display_for_window(
    app: &AppHandle,
    window: &tauri::WebviewWindow,
) -> anyhow::Result<DisplayInfo> {
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    let window = window.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(window.current_monitor().map(|m| {
            m.map(|m| {
                let p = m.position();
                format!("{},{}", p.x, p.y)
            })
        }));
    })
    .context("dispatch invoking monitor lookup to GTK")?;
    let id = rx
        .recv_timeout(Duration::from_secs(5))
        .context("wait for invoking monitor")??;
    resolve_display(app, id.as_deref())
}
