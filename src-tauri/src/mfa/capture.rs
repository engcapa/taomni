//! Image sources for QR import that need the desktop: the OS clipboard image
//! (WebKitGTK paste events usually omit it) and an in-app screen scan.
//!
//! Frames go to the renderer as 8-bit luma in a small binary container so a
//! multi-monitor capture does not travel as JSON/base64. The renderer decodes
//! the QR codes (see `src/lib/mfa/frames.ts`).

use std::sync::{Arc, Mutex};

use super::{ERR_CAPTURE_FAILED, ERR_CLIPBOARD_NO_IMAGE, ERR_NO_DISPLAY};

pub const FRAME_MAGIC: &[u8; 4] = b"TQF1";

pub use taomni_capture::still::LumaFrame;

pub fn rgba_to_luma(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    taomni_capture::pixels::rgba_to_luma(rgba, width, height)
        .map_err(|error| format!("{ERR_CAPTURE_FAILED}: {error}"))
}

/// `"TQF1"`, `u32` frame count, then per frame `u32 width`, `u32 height` and
/// `width * height` luma bytes. All integers little-endian.
pub fn encode_frames(frames: &[LumaFrame]) -> Vec<u8> {
    let payload: usize = frames.iter().map(|f| 8 + f.luma.len()).sum();
    let mut out = Vec::with_capacity(8 + payload);
    out.extend_from_slice(FRAME_MAGIC);
    out.extend_from_slice(&(frames.len() as u32).to_le_bytes());
    for frame in frames {
        out.extend_from_slice(&frame.width.to_le_bytes());
        out.extend_from_slice(&frame.height.to_le_bytes());
        out.extend_from_slice(&frame.luma);
    }
    out
}

/// Read the clipboard image through arboard (shared app clipboard handle).
pub fn read_clipboard_image(
    clipboard: &Arc<Mutex<Option<arboard::Clipboard>>>,
) -> Result<Vec<u8>, String> {
    let (width, height, rgba) = {
        let mut guard = clipboard
            .lock()
            .map_err(|e| format!("clipboard lock: {e}"))?;
        if guard.is_none() {
            *guard = Some(arboard::Clipboard::new().map_err(|e| format!("clipboard init: {e}"))?);
        }
        let image = guard
            .as_mut()
            .ok_or_else(|| "clipboard unavailable".to_string())?
            .get_image()
            .map_err(|_| ERR_CLIPBOARD_NO_IMAGE.to_string())?;
        (
            image.width as u32,
            image.height as u32,
            image.bytes.into_owned(),
        )
    };
    let luma = rgba_to_luma(&rgba, width, height)?;
    Ok(encode_frames(&[LumaFrame {
        width,
        height,
        luma,
    }]))
}

fn map_still_error(error: taomni_capture::still::StillError) -> String {
    match error {
        taomni_capture::still::StillError::NoDisplay(message) => {
            format!("{ERR_NO_DISPLAY}: {message}")
        }
        taomni_capture::still::StillError::Failed(message) => {
            format!("{ERR_CAPTURE_FAILED}: {message}")
        }
    }
}

/// Retain the actual decoder input only in the isolated hosted QA app.
/// The normal app never writes screen scans. This is evidence, not a second
/// capture or a replacement result; all errors remain those of the real scan.
pub(super) fn retain_hosted_qa_scan<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    bytes: &[u8],
) {
    use tauri::Manager;
    if !cfg!(debug_assertions)
        || window.app_handle().config().identifier != crate::QA_APP_ID
        || std::env::var("GITHUB_ACTIONS").as_deref() != Ok("true")
    {
        return;
    }
    let Some(root) = std::env::var_os("RUNNER_TEMP") else {
        return;
    };
    let root = std::path::PathBuf::from(root).join("taomni-qa-artifacts");
    let path = root.join(format!("mfa-scan-{}.tqf", uuid::Uuid::new_v4()));
    if let Err(error) = std::fs::create_dir_all(&root).and_then(|_| std::fs::write(path, bytes)) {
        log::warn!("retain hosted MFA scan evidence: {error}");
    }
}

/// Hide `window`, capture every display, then always restore and refocus it.
pub fn capture_screens_hiding<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Result<Vec<u8>, String> {
    use crate::capture::service::{StillServiceError, capture_luma_hiding};
    let frames = capture_luma_hiding(window).map_err(|error| match error {
        StillServiceError::ScreenPermission => super::ERR_SCREEN_PERMISSION.to_string(),
        StillServiceError::Focus(message) => {
            format!("{ERR_CAPTURE_FAILED}: focus before screenshot permission: {message}")
        }
        StillServiceError::Capture(error) => map_still_error(error),
    })?;
    Ok(encode_frames(&frames))
}
