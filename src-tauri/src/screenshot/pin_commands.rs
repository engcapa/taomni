use super::labels::PIN_LABEL_PREFIX;
use crate::screenshot::capture;
use crate::screenshot::model::PinInit;
use crate::screenshot::pin_window::open_pin;
use crate::screenshot::pins;
use crate::screenshot::runtime::blocking;
use crate::screenshot::runtime::tool_state;
use crate::screenshot::window_lifecycle::restore_app_windows;
use std::time::Duration;
use tauri::AppHandle;
use tauri::Manager;
use tauri::WebviewWindow;

// ---------------------------------------------------------------------------
// Pin to screen
// ---------------------------------------------------------------------------

/// Open a frameless always-on-top window showing a copy of the given
/// artifact (the copy outlives the capture session). Returns its label.
#[tauri::command]
pub async fn screenshot_pin_to_screen(app: AppHandle, path: String) -> Result<String, String> {
    let (pinned, width, height) = blocking("pin", move || {
        let src = capture::ensure_artifact_path(&path)?;
        let (width, height) = image::image_dimensions(&src)?;
        let dest = capture::untracked_artifact_path("pin", "png")?;
        std::fs::copy(&src, &dest)?;
        Ok((dest, width, height))
    })
    .await?;
    // A floating XWayland pin takes keyboard focus away from the Wayland
    // selection surface. Restore main while that surface can still authorize
    // activation, then let the new pin receive focus as usual.
    #[cfg(target_os = "linux")]
    if pins::native_wayland() {
        restore_app_windows(&app);
    }
    open_pin(&app, pinned, width, height, None)
}

/// The calling pin window's payload.
#[tauri::command]
pub async fn screenshot_pin_init(window: WebviewWindow) -> Result<PinInit, String> {
    tool_state()
        .pins
        .get(window.label())
        .cloned()
        .ok_or_else(|| "no pinned screenshot for this window".to_string())
}

/// GTK otherwise raises a non-resizable window to its 200px natural size.
/// Set the compact request on the UI thread and clear it before restoring.
#[tauri::command]
pub async fn screenshot_set_pin_compact(
    window: WebviewWindow,
    compact: bool,
) -> Result<(), String> {
    if !window.label().starts_with(PIN_LABEL_PREFIX) {
        return Err("not a pin window".into());
    }
    #[cfg(target_os = "linux")]
    {
        let pin = window.clone();
        let (tx, rx) = tokio::sync::oneshot::channel();
        window
            .run_on_main_thread(move || {
                use webkit2gtk::glib::prelude::ObjectExt;
                let result = pin
                    .gtk_window()
                    .map(|gtk| {
                        let size = if compact { 64 } else { -1 };
                        gtk.set_property("width-request", size);
                        gtk.set_property("height-request", size);
                        if compact {
                            gtk.set_property("default-width", 64);
                            gtk.set_property("default-height", 64);
                        }
                    })
                    .map_err(|e| e.to_string());
                let _ = tx.send(result);
            })
            .map_err(|e| e.to_string())?;
        tokio::time::timeout(Duration::from_secs(5), rx)
            .await
            .map_err(|_| "configure compact pin timed out".to_string())?
            .map_err(|e| e.to_string())??;
    }
    #[cfg(not(target_os = "linux"))]
    let _ = compact;
    Ok(())
}

/// Close a pinned screenshot window by label.
#[tauri::command]
pub async fn screenshot_close_pin(app: AppHandle, label: String) -> Result<(), String> {
    if !label.starts_with(PIN_LABEL_PREFIX) {
        return Err("not a pin window".to_string());
    }
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.close();
    }
    Ok(())
}
