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

/// Linux avoids xcap: its Wayland backend links libgbm/EGL, which the app does
/// not otherwise need. X11 sessions read the root window per RandR monitor via
/// x11rb (already used by the RDP server); Wayland sessions use the
/// xdg-desktop-portal Screenshot request, which shows the desktop's own prompt.
#[cfg(target_os = "linux")]
fn capture_all_monitors() -> Result<Vec<LumaFrame>, String> {
    let wayland = std::env::var_os("WAYLAND_DISPLAY").is_some()
        || std::env::var("XDG_SESSION_TYPE").is_ok_and(|kind| kind.eq_ignore_ascii_case("wayland"));
    if wayland {
        linux::capture_portal()
    } else {
        linux::capture_x11()
    }
}

#[cfg(not(target_os = "linux"))]
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

#[cfg(target_os = "linux")]
pub(crate) mod linux {
    use super::{ERR_CAPTURE_FAILED, ERR_NO_DISPLAY, LumaFrame, rgba_to_luma};
    use x11rb::connection::Connection as _;
    use x11rb::protocol::randr::ConnectionExt as _;
    use x11rb::protocol::xproto::{ConnectionExt as _, ImageFormat, ImageOrder};

    /// Luma of a 32-bpp ZPixmap (BGRX for LSB-first servers, XRGB otherwise).
    pub(crate) fn zpixmap_to_luma(
        data: &[u8],
        width: u32,
        height: u32,
        lsb_first: bool,
    ) -> Result<Vec<u8>, String> {
        let pixels = width as usize * height as usize;
        if pixels == 0 || data.len() < pixels * 4 {
            return Err(format!(
                "{ERR_CAPTURE_FAILED}: X11 image does not match {width}x{height}"
            ));
        }
        let (r, g, b) = if lsb_first { (2, 1, 0) } else { (1, 2, 3) };
        Ok(data
            .chunks_exact(4)
            .take(pixels)
            .map(|px| {
                ((u32::from(px[r]) * 77 + u32::from(px[g]) * 150 + u32::from(px[b]) * 29) >> 8)
                    as u8
            })
            .collect())
    }

    pub(super) fn capture_x11() -> Result<Vec<LumaFrame>, String> {
        let (conn, screen_num) =
            x11rb::connect(None).map_err(|e| format!("{ERR_NO_DISPLAY}: {e}"))?;
        let setup = conn.setup();
        let screen = setup
            .roots
            .get(screen_num)
            .ok_or_else(|| ERR_NO_DISPLAY.to_string())?;
        let bits = setup
            .pixmap_formats
            .iter()
            .find(|f| f.depth == screen.root_depth)
            .map(|f| f.bits_per_pixel);
        if bits != Some(32) {
            return Err(format!(
                "{ERR_CAPTURE_FAILED}: unsupported X11 root depth {}",
                screen.root_depth
            ));
        }
        let lsb_first = setup.image_byte_order == ImageOrder::LSB_FIRST;
        let mut rects: Vec<(i16, i16, u16, u16)> = conn
            .randr_get_monitors(screen.root, true)
            .ok()
            .and_then(|cookie| cookie.reply().ok())
            .map(|reply| {
                reply
                    .monitors
                    .iter()
                    .map(|m| (m.x, m.y, m.width, m.height))
                    .collect()
            })
            .unwrap_or_default();
        rects.retain(|&(_, _, w, h)| w > 0 && h > 0);
        if rects.is_empty() {
            rects.push((0, 0, screen.width_in_pixels, screen.height_in_pixels));
        }
        let mut frames = Vec::with_capacity(rects.len());
        let mut failures = Vec::new();
        for (x, y, w, h) in rects {
            let reply = conn
                .get_image(ImageFormat::Z_PIXMAP, screen.root, x, y, w, h, !0)
                .map_err(|e| e.to_string())
                .and_then(|cookie| cookie.reply().map_err(|e| e.to_string()));
            match reply.and_then(|image| {
                zpixmap_to_luma(&image.data, u32::from(w), u32::from(h), lsb_first)
            }) {
                Ok(luma) => frames.push(LumaFrame {
                    width: u32::from(w),
                    height: u32::from(h),
                    luma,
                }),
                Err(error) => failures.push(error),
            }
        }
        if frames.is_empty() {
            return Err(format!("{ERR_CAPTURE_FAILED}: {}", failures.join("; ")));
        }
        Ok(frames)
    }

    pub(super) fn capture_portal() -> Result<Vec<LumaFrame>, String> {
        let uri = tauri::async_runtime::block_on(async {
            let request = ashpd::desktop::screenshot::Screenshot::request()
                .interactive(false)
                .modal(true)
                .send()
                .await
                .map_err(|e| format!("{ERR_CAPTURE_FAILED}: screenshot portal: {e}"))?;
            let response = request
                .response()
                .map_err(|e| format!("{ERR_CAPTURE_FAILED}: screenshot portal: {e}"))?;
            Ok::<_, String>(response.uri().clone())
        })?;
        let path = uri
            .to_file_path()
            .map_err(|_| format!("{ERR_CAPTURE_FAILED}: portal returned {uri}"))?;
        let decoded =
            image::open(&path).map_err(|e| format!("{ERR_CAPTURE_FAILED}: portal screenshot: {e}"));
        // Portals write the capture to a temporary file; never touch user folders.
        let temporary = [
            std::env::temp_dir(),
            std::env::var_os("XDG_RUNTIME_DIR")
                .map(Into::into)
                .unwrap_or_default(),
        ];
        if temporary
            .iter()
            .any(|dir| !dir.as_os_str().is_empty() && path.starts_with(dir))
        {
            let _ = std::fs::remove_file(&path);
        }
        let rgba = decoded?.to_rgba8();
        let (width, height) = rgba.dimensions();
        Ok(vec![LumaFrame {
            width,
            height,
            luma: rgba_to_luma(rgba.as_raw(), width, height)?,
        }])
    }
}
