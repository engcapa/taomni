//! Feishu-style system screenshot & screen recording tool.
//!
//! Unlike the per-tab xterm-render capture (`src/lib/capture`), this module
//! captures the real OS screen on any display: fullscreen, region, scrolling
//! (auto-scroll + stitch), and video recording to GIF / MP4. Windows, macOS
//! and Linux are all supported.
//!
//! The overlay UX is static-background: [`screenshot_open_overlay`] hides the
//! app windows, captures the display, then opens a fullscreen overlay window
//! that renders the captured PNG while the user selects / annotates. This
//! avoids transparent-window focus and click-through problems on Linux.

pub mod capture;
pub mod record;
pub mod scroll;

use std::borrow::Cow;
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use capture::{DisplayInfo, ScreenshotFile};
use scroll::ScrollCaptureResult;

const OVERLAY_LABEL: &str = "screenshot-overlay";
const RECORDER_LABEL: &str = "screenshot-recorder";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayInit {
    pub path: String,
    pub display_id: Option<String>,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotProbe {
    /// `granted`, `denied`, or `notRequired` — OS screen-capture permission.
    pub permission: String,
    /// Accessibility / input-injection permission (macOS scroll capture).
    pub control_permission: String,
    pub ffmpeg_available: bool,
    pub summary: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStarted {
    pub recording_id: String,
}

static OVERLAY_INIT: OnceLock<Mutex<Option<OverlayInit>>> = OnceLock::new();
static HIDDEN_WINDOWS: OnceLock<Mutex<Vec<String>>> = OnceLock::new();
static CURRENT_RECORDING: OnceLock<Mutex<Option<String>>> = OnceLock::new();

fn overlay_init_slot() -> &'static Mutex<Option<OverlayInit>> {
    OVERLAY_INIT.get_or_init(|| Mutex::new(None))
}

fn hidden_windows_slot() -> &'static Mutex<Vec<String>> {
    HIDDEN_WINDOWS.get_or_init(|| Mutex::new(Vec::new()))
}

fn current_recording_slot() -> &'static Mutex<Option<String>> {
    CURRENT_RECORDING.get_or_init(|| Mutex::new(None))
}

fn internal_error(e: anyhow::Error) -> String {
    format!("{e:#}")
}

// ---------------------------------------------------------------------------
// Still capture
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn screenshot_list_displays(app: AppHandle) -> Result<Vec<DisplayInfo>, String> {
    tokio::task::spawn_blocking(move || capture::list_displays(&app))
        .await
        .map_err(|e| format!("display enumeration task failed: {e}"))?
        .map_err(internal_error)
}

#[tauri::command]
pub async fn screenshot_capture_full(
    app: AppHandle,
    display_id: Option<String>,
) -> Result<ScreenshotFile, String> {
    tokio::task::spawn_blocking(move || capture::capture_display_png(&app, display_id.as_deref()))
        .await
        .map_err(|e| format!("capture task failed: {e}"))?
        .map_err(internal_error)
        .map(|(path, width, height)| ScreenshotFile {
            path: path.to_string_lossy().into_owned(),
            width,
            height,
        })
}

#[tauri::command]
pub async fn screenshot_capture_region(
    app: AppHandle,
    display_id: Option<String>,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
) -> Result<ScreenshotFile, String> {
    tokio::task::spawn_blocking(move || {
        capture::capture_region_png(&app, display_id.as_deref(), x, y, width, height)
    })
    .await
    .map_err(|e| format!("capture task failed: {e}"))?
    .map_err(internal_error)
    .map(|(path, width, height)| ScreenshotFile {
        path: path.to_string_lossy().into_owned(),
        width,
        height,
    })
}

#[tauri::command]
pub async fn screenshot_scroll_capture(
    app: AppHandle,
    display_id: Option<String>,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
) -> Result<ScrollCaptureResult, String> {
    // Enigo is not `Send` on macOS; the whole flow owns its OS thread.
    tokio::task::spawn_blocking(move || {
        let origin = capture::display_origin(&app, display_id.as_deref());
        scroll::scroll_capture(&app, display_id.as_deref(), origin, x, y, width, height)
    })
    .await
    .map_err(|e| format!("scroll capture task failed: {e}"))?
    .map_err(internal_error)
}

#[tauri::command]
pub async fn screenshot_copy_image(path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let image = image::open(&path)
            .map_err(|e| anyhow::anyhow!("open image: {e}"))?
            .to_rgba8();
        let (width, height) = (image.width() as usize, image.height() as usize);
        let mut clipboard =
            arboard::Clipboard::new().map_err(|e| anyhow::anyhow!("open clipboard: {e}"))?;
        clipboard
            .set_image(arboard::ImageData {
                width,
                height,
                bytes: Cow::Owned(image.into_raw()),
            })
            .map_err(|e| anyhow::anyhow!("write image to clipboard: {e}"))
    })
    .await
    .map_err(|e| format!("clipboard task failed: {e}"))?
    .map_err(internal_error)
}

#[tauri::command]
pub async fn screenshot_save_image(path: String, dest: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        std::fs::copy(&path, &dest)
            .map(|_| ())
            .map_err(|e| anyhow::anyhow!("save image: {e}"))
    })
    .await
    .map_err(|e| format!("save task failed: {e}"))?
    .map_err(internal_error)
}

/// Decode a `data:image/png;base64,...` URL from the annotation canvas and
/// write it as a temp PNG. Returns the file for copy/save.
#[tauri::command]
pub async fn screenshot_save_data_url(data_url: String) -> Result<ScreenshotFile, String> {
    tokio::task::spawn_blocking(move || {
        use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
        let payload = data_url
            .split_once(',')
            .map(|(_, rest)| rest)
            .unwrap_or(&data_url);
        let bytes = BASE64
            .decode(payload.trim())
            .map_err(|e| anyhow::anyhow!("decode data url: {e}"))?;
        if bytes.len() < 8 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" {
            anyhow::bail!("not a PNG data url");
        }
        let path = capture::temp_artifact_path("annotated", "png")?;
        std::fs::write(&path, &bytes).map_err(|e| anyhow::anyhow!("write png: {e}"))?;
        let image = image::open(&path).map_err(|e| anyhow::anyhow!("read png: {e}"))?;
        Ok::<ScreenshotFile, anyhow::Error>(ScreenshotFile {
            path: path.to_string_lossy().into_owned(),
            width: image.width(),
            height: image.height(),
        })
    })
    .await
    .map_err(|e| format!("save task failed: {e}"))?
    .map_err(internal_error)
}

#[tauri::command]
pub async fn screenshot_probe() -> Result<ScreenshotProbe, String> {
    let base = tokio::task::spawn_blocking(|| crate::servers::rdp::capture::probe())
        .await
        .map_err(|e| format!("probe task failed: {e}"))?
        .map_err(internal_error)?;
    Ok(ScreenshotProbe {
        permission: base.permission,
        control_permission: base.control_permission,
        ffmpeg_available: record::ffmpeg_available(),
        summary: format!(
            "{}. MP4 recording {}.",
            base.summary,
            if record::ffmpeg_available() {
                "is available (ffmpeg found)"
            } else {
                "needs ffmpeg on PATH (GIF always works)"
            }
        ),
    })
}

/// Read the first `len` bytes of a file as lowercase hex. Test-only helper
/// for QA to verify recording file headers (GIF87a/89a, MP4 ftyp).
#[tauri::command]
pub async fn screenshot_read_file_header(path: String, len: u32) -> Result<String, String> {
    let len = len.min(64) as usize;
    let bytes = tokio::task::spawn_blocking(move || {
        use std::io::Read;
        let mut f = std::fs::File::open(&path).map_err(|e| format!("open failed: {e}"))?;
        let mut buf = vec![0u8; len];
        let n = f.read(&mut buf).map_err(|e| format!("read failed: {e}"))?;
        buf.truncate(n);
        Ok::<Vec<u8>, String>(buf)
    })
    .await
    .map_err(|e| format!("read task failed: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Test-only: run scroll capture and verify multi-frame stitching in one call.
/// Returns "OK frames=N height=H" where N>1 and H>requested height prove
/// the wheel scrolled and frames were stitched.
#[tauri::command]
pub async fn screenshot_test_scroll_capture(
    app: AppHandle,
    width: u32,
    height: u32,
) -> Result<String, String> {
    let r = screenshot_scroll_capture(app, None, 0, 0, width, height).await?;
    let ok = r.frames > 1 && r.height > height;
    Ok(format!(
        "{} frames={} height={}",
        if ok { "OK" } else { "FAIL" },
        r.frames,
        r.height
    ))
}

/// Test-only: record a short clip and verify its file header in one call.
/// Starts a recording, waits `secs` seconds, stops it, reads the first 12
/// bytes as hex. Returns "OK <hex>" on success. Avoids JS promise chaining
/// (banned by the QA audit) in native test cases.
/// Bypasses the recorder-bar window (UI) used by the interactive flow.
#[tauri::command]
pub async fn screenshot_test_recording(
    app: AppHandle,
    format: String,
    secs: u64,
) -> Result<String, String> {
    let recording_id = {
        let app_clone = app.clone();
        let format_clone = format.clone();
        tokio::task::spawn_blocking(move || {
            record::start_recording(
                &app_clone,
                None,
                Some((0, 0, 200, 200)),
                &format_clone,
                Some(5),
            )
        })
        .await
        .map_err(|e| format!("start recording task failed: {e}"))?
        .map_err(internal_error)?
    };
    tokio::time::sleep(std::time::Duration::from_secs(secs.min(10))).await;
    let file = tokio::task::spawn_blocking(move || record::stop_recording(&recording_id))
        .await
        .map_err(|e| format!("stop recording task failed: {e}"))?
        .map_err(internal_error)?;
    let header = screenshot_read_file_header(file.path.clone(), 12).await?;
    Ok(format!("OK path={} header={}", file.path, header))
}

// ---------------------------------------------------------------------------
// Overlay window
// ---------------------------------------------------------------------------

/// Hide app windows, capture the display, and open the fullscreen annotation
/// overlay. Split from the Tauri command so the global-shortcut handler can
/// reuse it.
pub async fn open_overlay(app: &AppHandle, display_id: Option<String>) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = existing.close();
    }
    // Hide every visible app window (no label assumptions about the main
    // window); they are reshown by `screenshot_close_overlay`.
    let mut hidden = Vec::new();
    for (label, window) in app.webview_windows() {
        if label == OVERLAY_LABEL || label == RECORDER_LABEL {
            continue;
        }
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
            hidden.push(label);
        }
    }
    *hidden_windows_slot().lock().unwrap() = hidden;

    let origin = capture::display_origin(app, display_id.as_deref());
    let app_clone = app.clone();
    let display_clone = display_id.clone();
    let (path, width, height) = tokio::task::spawn_blocking(move || {
        capture::capture_display_png(&app_clone, display_clone.as_deref())
    })
    .await
    .map_err(|e| format!("capture task failed: {e}"))?
    .map_err(internal_error)?;
    *overlay_init_slot().lock().unwrap() = Some(OverlayInit {
        path: path.to_string_lossy().into_owned(),
        display_id,
        width,
        height,
    });

    let url = WebviewUrl::App("index.html#screenshot-overlay".into());
    WebviewWindowBuilder::new(app, OVERLAY_LABEL, url)
        .title("Screenshot")
        .position(origin.0 as f64, origin.1 as f64)
        .fullscreen(true)
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .build()
        .map_err(|e| format!("open overlay window: {e}"))?;
    Ok(())
}

/// Tauri command wrapper for [`open_overlay`].
#[tauri::command]
pub async fn screenshot_open_overlay(
    app: AppHandle,
    display_id: Option<String>,
) -> Result<(), String> {
    open_overlay(&app, display_id).await
}

/// One-shot fetch of the pending overlay payload, set by
/// [`screenshot_open_overlay`].
#[tauri::command]
pub async fn screenshot_overlay_init() -> Result<OverlayInit, String> {
    overlay_init_slot()
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "no pending screenshot overlay".to_string())
}

/// Close the overlay (and recorder bar) and reshow hidden app windows.
#[tauri::command]
pub async fn screenshot_close_overlay(app: AppHandle) -> Result<(), String> {
    for label in [OVERLAY_LABEL, RECORDER_LABEL] {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.close();
        }
    }
    let hidden: Vec<String> = std::mem::take(&mut *hidden_windows_slot().lock().unwrap());
    for label in hidden {
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn screenshot_start_recording(
    app: AppHandle,
    display_id: Option<String>,
    x: Option<u32>,
    y: Option<u32>,
    width: Option<u32>,
    height: Option<u32>,
    format: String,
    fps: Option<u32>,
) -> Result<RecordingStarted, String> {
    // Recording owns an OS thread; also give the overlay a chance to hide by
    // opening the tiny recorder bar window first (frontend hides the overlay
    // before invoking this).
    let region = match (x, y, width, height) {
        (Some(x), Some(y), Some(w), Some(h)) => Some((x, y, w, h)),
        _ => None,
    };
    let recording_id = {
        let app_clone = app.clone();
        tokio::task::spawn_blocking(move || {
            record::start_recording(&app_clone, display_id, region, &format, fps)
        })
        .await
        .map_err(|e| format!("start recording task failed: {e}"))?
        .map_err(internal_error)?
    };
    *current_recording_slot().lock().unwrap() = Some(recording_id.clone());

    open_recorder_bar(&app)?;
    Ok(RecordingStarted { recording_id })
}

#[tauri::command]
pub async fn screenshot_stop_recording(recording_id: String) -> Result<ScreenshotFile, String> {
    let file = tokio::task::spawn_blocking(move || record::stop_recording(&recording_id))
        .await
        .map_err(|e| format!("stop recording task failed: {e}"))?
        .map_err(internal_error)?;
    *current_recording_slot().lock().unwrap() = None;
    Ok(file)
}

#[tauri::command]
pub async fn screenshot_cancel_recording(recording_id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || record::cancel_recording(&recording_id))
        .await
        .map_err(|e| format!("cancel recording task failed: {e}"))?
        .map_err(internal_error)?;
    *current_recording_slot().lock().unwrap() = None;
    Ok(())
}

/// The recorder bar window reads this to learn which recording it controls.
#[tauri::command]
pub async fn screenshot_current_recording() -> Result<Option<String>, String> {
    Ok(current_recording_slot().lock().unwrap().clone())
}

fn open_recorder_bar(app: &AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(RECORDER_LABEL) {
        let _ = existing.close();
    }
    let url = WebviewUrl::App("index.html#screenshot-recorder".into());
    // Position: bottom-center of the primary display area; the bar frontend
    // recenters itself on its own display via the window API if needed.
    WebviewWindowBuilder::new(app, RECORDER_LABEL, url)
        .title("Recording")
        .inner_size(300.0, 72.0)
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .build()
        .map_err(|e| format!("open recorder bar: {e}"))?;
    Ok(())
}
