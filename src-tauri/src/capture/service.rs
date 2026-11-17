//! Core-owned still service. Window hiding and permission attribution remain
//! here when consumers such as MFA move to a plugin host.

use std::time::Duration;
use taomni_capture::still::{LumaFrame, StillError};

/// Lets the compositor remove the hidden Taomni window before capturing.
const HIDE_SETTLE: Duration = Duration::from_millis(350);

#[derive(Debug)]
pub(crate) enum StillServiceError {
    ScreenPermission,
    Focus(String),
    Capture(StillError),
}

/// Hide the invoking window, capture every display, then restore its visibility
/// and focus on success or failure. Invoke this service on a blocking worker.
/// The future host RPC must call this core owner rather than capturing in MFA's
/// host, so macOS permission continues to belong to the application.
pub(crate) fn capture_luma_hiding<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Result<Vec<LumaFrame>, StillServiceError> {
    capture_luma_hiding_bounded(window, usize::MAX)
}

pub(crate) fn capture_luma_hiding_bounded<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    max_luma_bytes: usize,
) -> Result<Vec<LumaFrame>, StillServiceError> {
    #[cfg(target_os = "macos")]
    if !taomni_capture::permissions::screen_permission_granted() {
        let _ = taomni_capture::permissions::request_screen_permission();
        return Err(StillServiceError::ScreenPermission);
    }
    let was_visible = window.is_visible().unwrap_or(true);
    #[cfg(target_os = "linux")]
    if was_visible && taomni_capture::still::native_wayland() {
        // GNOME permits the Screenshot access dialog only for the focused app.
        // Obtain the grant before hiding; discard that permission screenshot.
        window
            .set_focus()
            .map_err(|error| StillServiceError::Focus(error.to_string()))?;
        std::thread::sleep(HIDE_SETTLE);
        drop(
            taomni_capture::still::capture_luma_bounded(
                taomni_capture::still::StillPolicy::PortalScreenshot,
                max_luma_bytes,
            )
            .map_err(StillServiceError::Capture)?,
        );
    }
    if was_visible {
        let _ = window.hide();
        std::thread::sleep(HIDE_SETTLE);
    }
    let restore = scopeguard::guard((), |_| {
        if was_visible {
            let _ = window.show();
            let _ = window.set_focus();
        }
    });
    let frames = taomni_capture::still::capture_all_luma_bounded(max_luma_bytes)
        .map_err(StillServiceError::Capture);
    drop(restore);
    frames
}
