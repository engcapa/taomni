//! Image sources for QR import that need the desktop: the OS clipboard image
//! (WebKitGTK paste events usually omit it) and an in-app screen scan.
//!
//! Frames go to the renderer as 8-bit luma in a small binary container so a
//! multi-monitor capture does not travel as JSON/base64. The renderer decodes
//! the QR codes (see `src/lib/mfa/frames.ts`).

use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::{ERR_CAPTURE_FAILED, ERR_CLIPBOARD_NO_IMAGE, ERR_NO_DISPLAY};

pub const FRAME_MAGIC: &[u8; 4] = b"TQF1";
/// Lets the compositor remove the hidden Taomni window before capturing.
const HIDE_SETTLE: Duration = Duration::from_millis(350);

pub struct LumaFrame {
    pub width: u32,
    pub height: u32,
    pub luma: Vec<u8>,
}

/// BT.601 luma of an RGBA buffer, composited over white so transparent QR
/// backgrounds (common in copied images) stay light instead of turning black.
pub fn rgba_to_luma(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    let pixels = width as usize * height as usize;
    if pixels == 0 || rgba.len() < pixels * 4 {
        return Err(format!(
            "{ERR_CAPTURE_FAILED}: image buffer does not match {width}x{height}"
        ));
    }
    let mut out = Vec::with_capacity(pixels);
    for px in rgba.chunks_exact(4).take(pixels) {
        let (r, g, b, a) = (
            u32::from(px[0]),
            u32::from(px[1]),
            u32::from(px[2]),
            u32::from(px[3]),
        );
        let y = (r * 77 + g * 150 + b * 29) >> 8;
        out.push(((y * a + 255 * (255 - a)) / 255) as u8);
    }
    Ok(out)
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

#[cfg(target_os = "macos")]
fn ensure_screen_permission() -> Result<(), String> {
    use objc2_core_graphics::{CGPreflightScreenCaptureAccess, CGRequestScreenCaptureAccess};
    if CGPreflightScreenCaptureAccess() {
        return Ok(());
    }
    // Registers Taomni in System Settings and shows the one-time prompt; the
    // grant only takes effect after the app restarts.
    let _ = CGRequestScreenCaptureAccess();
    Err(super::ERR_SCREEN_PERMISSION.to_string())
}

#[cfg(not(target_os = "macos"))]
fn ensure_screen_permission() -> Result<(), String> {
    Ok(())
}

fn capture_all_monitors() -> Result<Vec<LumaFrame>, String> {
    let monitors = xcap::Monitor::all().map_err(|e| format!("{ERR_NO_DISPLAY}: {e}"))?;
    if monitors.is_empty() {
        return Err(ERR_NO_DISPLAY.to_string());
    }
    let mut frames = Vec::with_capacity(monitors.len());
    let mut failures = Vec::new();
    for monitor in monitors {
        match monitor.capture_image() {
            Ok(image) => {
                let (width, height) = (image.width(), image.height());
                frames.push(LumaFrame {
                    width,
                    height,
                    luma: rgba_to_luma(image.as_raw(), width, height)?,
                });
            }
            Err(error) => failures.push(error.to_string()),
        }
    }
    if frames.is_empty() {
        return Err(format!("{ERR_CAPTURE_FAILED}: {}", failures.join("; ")));
    }
    Ok(frames)
}

/// Hide `window`, capture every display, then always restore and refocus it.
pub fn capture_screens_hiding<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Result<Vec<u8>, String> {
    ensure_screen_permission()?;
    let was_visible = window.is_visible().unwrap_or(true);
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
    let frames = capture_all_monitors();
    drop(restore);
    Ok(encode_frames(&frames?))
}
