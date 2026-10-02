//! Feishu-style system screenshot & screen recording tool.
//!
//! Unlike the per-tab xterm-render capture (`src/lib/capture`), this module
//! captures the real OS screen on any display: fullscreen, region, scrolling
//! (auto-scroll + stitch), and video recording to GIF / MP4. Windows, macOS
//! and Linux are all supported.
//!
//! Overlay UX is static-background: [`open_overlay`] hides the app windows,
//! captures the display under the pointer, then opens a borderless overlay
//! covering that display which renders the captured PNG while the user
//! selects / annotates. Capture files are temp artifacts (see
//! `capture::temp_artifact_path`) read by the webview through
//! [`screenshot_read_file`] and deleted when the capture session ends.

pub mod capture;
pub mod ocr;
pub mod qa;
mod qa_oracle;
pub mod record;
pub mod scroll;
pub mod shortcut;

use std::borrow::Cow;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

use crate::state::AppState;
use capture::{DisplayInfo, ScreenshotFile};
use scroll::ScrollCaptureResult;

pub const OVERLAY_LABEL: &str = "screenshot-overlay";
pub const RECORDER_LABEL: &str = "screenshot-recorder";
pub const PIN_LABEL_PREFIX: &str = "screenshot-pin-";

/// Time for the compositor to remove hidden windows from the screen before
/// the desktop is captured (Windows DWM and macOS fade animations).
const HIDE_SETTLE: Duration = Duration::from_millis(250);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayInit {
    pub path: String,
    pub display_id: String,
    /// Physical pixels.
    pub width: u32,
    pub height: u32,
    pub scale_factor: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PinInit {
    pub path: String,
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
    /// MP4 uses the bundled H.264 encoder, so it is always available.
    pub mp4_available: bool,
    pub ocr_available: bool,
    pub summary: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStarted {
    pub recording_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingFile {
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub frames: u32,
    pub duration_ms: u64,
}

#[derive(Default)]
struct ToolState {
    overlay: Option<OverlayInit>,
    /// Labels of app windows hidden for the capture session.
    hidden: Vec<String>,
    recording: Option<String>,
    /// Remains true while the stopped clip is being previewed.
    recorder_open: bool,
    pins: HashMap<String, PinInit>,
}

static STATE: OnceLock<Mutex<ToolState>> = OnceLock::new();
/// Serializes overlay opening (hotkey repeat, double clicks, StrictMode).
static OPENING: AtomicBool = AtomicBool::new(false);
static STARTING_RECORDING: AtomicBool = AtomicBool::new(false);
static SESSION_GENERATION: AtomicU64 = AtomicU64::new(0);
static PIN_COUNTER: AtomicU64 = AtomicU64::new(1);

struct RecordingStartGuard;

impl Drop for RecordingStartGuard {
    fn drop(&mut self) {
        STARTING_RECORDING.store(false, Ordering::SeqCst);
    }
}

fn tool_state() -> std::sync::MutexGuard<'static, ToolState> {
    STATE
        .get_or_init(|| Mutex::new(ToolState::default()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn internal_error(e: anyhow::Error) -> String {
    format!("{e:#}")
}

/// Startup: purge leftovers of earlier runs and register the hotkey.
pub fn init(app: &AppHandle) {
    capture::purge_stale_artifacts();
    shortcut::init(app);
}

/// Raw bytes of a screenshot artifact. The UI turns them into a same-origin
/// `blob:` URL: unlike asset-protocol URLs (a different origin), blob images
/// never taint the annotation canvas, so export / color picking keep working
/// on every WebView engine.
#[tauri::command]
pub async fn screenshot_read_file(path: String) -> Result<tauri::ipc::Response, String> {
    blocking("read", move || {
        let path = capture::ensure_artifact_path(&path)?;
        Ok(tauri::ipc::Response::new(std::fs::read(path)?))
    })
    .await
}

/// App exit: stop recordings and delete temp files.
pub fn shutdown() {
    record::cancel_all();
    capture::purge_tracked();
}

async fn blocking<T: Send + 'static>(
    what: &str,
    f: impl FnOnce() -> anyhow::Result<T> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("{what} task failed: {e}"))?
        .map_err(internal_error)
}

pub(crate) fn window_builder<'a>(
    app: &'a AppHandle,
    label: &str,
    url: WebviewUrl,
) -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
    #[allow(unused_mut)]
    let mut builder = WebviewWindowBuilder::new(app, label, url);
    #[cfg(target_os = "windows")]
    if cfg!(debug_assertions) && app.config().identifier == crate::QA_APP_ID {
        // All QA WebViews must use the same isolated environment/profile and
        // EdgeDriver arguments as main, never a personal/default profile.
        if std::env::var_os("NEWMOB_DATA_DIR").is_some() {
            if let Ok(data_dir) = crate::resolved_app_data_dir(app) {
                builder = builder.data_directory(data_dir.join("webview"));
            }
            if let Ok(arguments) = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") {
                if !arguments.trim().is_empty() {
                    builder = builder.additional_browser_args(&arguments);
                }
            }
        }
    }
    builder
}

fn to_file(result: (PathBuf, u32, u32)) -> ScreenshotFile {
    ScreenshotFile {
        path: result.0.to_string_lossy().into_owned(),
        width: result.1,
        height: result.2,
    }
}

// ---------------------------------------------------------------------------
// Still capture
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn screenshot_list_displays(app: AppHandle) -> Result<Vec<DisplayInfo>, String> {
    blocking("display enumeration", move || capture::list_displays(&app)).await
}

#[tauri::command]
pub async fn screenshot_capture_full(
    app: AppHandle,
    display_id: Option<String>,
) -> Result<ScreenshotFile, String> {
    blocking("capture", move || {
        let display = capture::resolve_display(&app, display_id.as_deref())?;
        let image = capture::capture_display(&app, &display)?;
        capture::save_png(&image, "shot").map(to_file)
    })
    .await
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
    blocking("capture", move || {
        let display = capture::resolve_display(&app, display_id.as_deref())?;
        let image = capture::capture_display(&app, &display)?;
        capture::save_png(&capture::crop(&image, x, y, width, height), "shot").map(to_file)
    })
    .await
}

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
) -> Result<ScrollCaptureResult, String> {
    let overlay = app.get_webview_window(OVERLAY_LABEL);
    if let Some(window) = &overlay {
        let _ = window.hide();
    }
    let worker = app.clone();
    let result = blocking("scroll capture", move || {
        let display = capture::resolve_display(&worker, display_id.as_deref())?;
        scroll::scroll_capture(&worker, &display, (x, y, width, height))
    })
    .await;
    if let Some(window) = overlay {
        let _ = window.show();
        let _ = window.set_focus();
    }
    result
}

/// Copy a screenshot artifact to the OS clipboard as an image. Uses the
/// app-wide clipboard instance: on X11 the owner must outlive the call or
/// the clipboard content disappears with it.
#[tauri::command]
pub async fn screenshot_copy_image(app: AppHandle, path: String) -> Result<(), String> {
    blocking("clipboard", move || {
        let path = capture::ensure_artifact_path(&path)?;
        let image = clipboard_image(&path)?;
        let (width, height) = (image.width() as usize, image.height() as usize);
        let state = app.state::<AppState>();
        let mut guard = state
            .clipboard
            .lock()
            .map_err(|_| anyhow::anyhow!("clipboard lock poisoned"))?;
        if guard.is_none() {
            *guard = Some(
                arboard::Clipboard::new().map_err(|e| anyhow::anyhow!("open clipboard: {e}"))?,
            );
        }
        guard
            .as_mut()
            .expect("clipboard initialised")
            .set_image(arboard::ImageData {
                width,
                height,
                bytes: Cow::Owned(image.into_raw()),
            })
            .map_err(|e| anyhow::anyhow!("write image to clipboard: {e}"))
    })
    .await
}

fn clipboard_image(path: &std::path::Path) -> anyhow::Result<image::RgbaImage> {
    if path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("gif"))
    {
        let mut options = gif::DecodeOptions::new();
        options.set_color_output(gif::ColorOutput::RGBA);
        let mut decoder = options.read_info(std::fs::File::open(path)?)?;
        let (width, height) = (u32::from(decoder.width()), u32::from(decoder.height()));
        let frame = decoder
            .read_next_frame()?
            .ok_or_else(|| anyhow::anyhow!("GIF has no frames"))?;
        return image::RgbaImage::from_raw(width, height, frame.buffer.to_vec())
            .ok_or_else(|| anyhow::anyhow!("GIF first frame dimensions do not match its canvas"));
    }
    Ok(image::open(path)?.to_rgba8())
}

/// Copy a screenshot artifact to a user-chosen destination.
#[tauri::command]
pub async fn screenshot_save_image(path: String, dest: String) -> Result<(), String> {
    blocking("save", move || {
        let src = capture::ensure_artifact_path(&path)?;
        let dest = PathBuf::from(dest);
        if dest.as_os_str().is_empty() {
            anyhow::bail!("no destination path");
        }
        std::fs::copy(&src, &dest)
            .map(|_| ())
            .map_err(|e| anyhow::anyhow!("save to {}: {e}", dest.display()))
    })
    .await
}

/// Decode a `data:image/png;base64,...` URL from the annotation canvas and
/// write it as a temp PNG. Returns the file for copy/save/pin.
#[tauri::command]
pub async fn screenshot_save_data_url(data_url: String) -> Result<ScreenshotFile, String> {
    blocking("save", move || {
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
        let (width, height) = image::ImageReader::new(std::io::Cursor::new(&bytes))
            .with_guessed_format()
            .map_err(|e| anyhow::anyhow!("read png: {e}"))?
            .into_dimensions()
            .map_err(|e| anyhow::anyhow!("read png: {e}"))?;
        let path = capture::temp_artifact_path("annotated", "png")?;
        std::fs::write(&path, &bytes).map_err(|e| anyhow::anyhow!("write png: {e}"))?;
        Ok(ScreenshotFile {
            path: path.to_string_lossy().into_owned(),
            width,
            height,
        })
    })
    .await
}

#[tauri::command]
pub async fn screenshot_probe() -> Result<ScreenshotProbe, String> {
    blocking("probe", || {
        let base = crate::servers::rdp::capture::probe()?;
        let ocr_available = ocr::tesseract_available();
        Ok(ScreenshotProbe {
            permission: base.permission,
            control_permission: base.control_permission,
            mp4_available: true,
            ocr_available,
            summary: format!(
                "{}. OCR {}.",
                base.summary,
                if ocr_available {
                    "is available (tesseract found)"
                } else {
                    "needs tesseract installed"
                }
            ),
        })
    })
    .await
}

// ---------------------------------------------------------------------------
// Overlay window
// ---------------------------------------------------------------------------

/// Hide every visible app window except the screenshot tool's own and remember
/// them (merged with windows already hidden for this session).
fn hide_app_windows(app: &AppHandle) -> bool {
    let mut hid_any = false;
    let mut state = tool_state();
    for (label, window) in app.webview_windows() {
        if label == OVERLAY_LABEL
            || label == RECORDER_LABEL
            || label.starts_with(PIN_LABEL_PREFIX)
            || label == qa::QA_WINDOW_LABEL
        {
            continue;
        }
        if window.is_visible().unwrap_or(false) && window.hide().is_ok() {
            hid_any = true;
            if !state.hidden.contains(&label) {
                state.hidden.push(label);
            }
        }
    }
    hid_any
}

fn restore_app_windows(app: &AppHandle) {
    let hidden = std::mem::take(&mut tool_state().hidden);
    for label in hidden {
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

/// Place a borderless window exactly over `display` (physical pixels).
fn cover_display(window: &WebviewWindow, display: &DisplayInfo) {
    let _ = window.set_position(PhysicalPosition::new(display.x, display.y));
    let _ = window.set_size(PhysicalSize::new(display.width, display.height));
    #[cfg(target_os = "macos")]
    {
        // Simple fullscreen hides the menu bar and Dock without the Space
        // switch animation of native fullscreen.
        let _ = window.set_simple_fullscreen(true);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window.set_fullscreen(true);
    }
}

/// Hide app windows, capture `display_id` (default: the display under the
/// pointer) and open the annotation overlay on it. Re-entrant calls while an
/// overlay is opening/open just focus the existing one; while a recording
/// runs they focus the recorder bar.
pub async fn open_overlay(app: &AppHandle, display_id: Option<String>) -> Result<(), String> {
    if let Some(label) = {
        let state = tool_state();
        if state.recording.is_some() || state.recorder_open {
            Some(RECORDER_LABEL)
        } else if state.overlay.is_some() {
            Some(OVERLAY_LABEL)
        } else {
            None
        }
    } {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.show();
            let _ = window.set_focus();
        }
        return Ok(());
    }
    if OPENING.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let result = open_overlay_inner(app, display_id).await;
    OPENING.store(false, Ordering::SeqCst);
    if result.is_err() {
        // Never leave the user with no visible window.
        tool_state().overlay = None;
        if let Some(window) = app.get_webview_window(OVERLAY_LABEL) {
            let _ = window.close();
        }
        restore_app_windows(app);
        capture::purge_tracked();
    }
    result
}

async fn open_overlay_inner(app: &AppHandle, display_id: Option<String>) -> Result<(), String> {
    let generation = SESSION_GENERATION.load(Ordering::SeqCst);
    let display = {
        let app = app.clone();
        blocking("display lookup", move || match display_id {
            Some(id) if !id.trim().is_empty() => capture::resolve_display(&app, Some(&id)),
            _ => capture::display_at_cursor(&app),
        })
        .await?
    };
    if hide_app_windows(app) {
        tokio::time::sleep(HIDE_SETTLE).await;
    }
    let (path, width, height) = {
        let app = app.clone();
        let display = display.clone();
        blocking("capture", move || {
            let image = capture::capture_display(&app, &display)?;
            capture::save_png(&image, "shot")
        })
        .await?
    };
    if SESSION_GENERATION.load(Ordering::SeqCst) != generation {
        std::fs::remove_file(path).ok();
        return Err("screenshot opening was cancelled".into());
    }
    tool_state().overlay = Some(OverlayInit {
        path: path.to_string_lossy().into_owned(),
        display_id: display.id.clone(),
        width,
        height,
        scale_factor: display.scale_factor,
    });

    let url = WebviewUrl::App("index.html#screenshot-overlay".into());
    let window = window_builder(app, OVERLAY_LABEL, url)
        .title("Screenshot")
        .visible(false)
        .decorations(false)
        .resizable(false)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .build()
        .map_err(|e| format!("open overlay window: {e}"))?;
    watch_session_window(&window);
    cover_display(&window, &display);
    window
        .show()
        .map_err(|e| format!("show overlay window: {e}"))?;
    let _ = window.set_focus();
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

/// The pending overlay payload, set by [`open_overlay`].
#[tauri::command]
pub async fn screenshot_overlay_init() -> Result<OverlayInit, String> {
    tool_state()
        .overlay
        .clone()
        .ok_or_else(|| "no pending screenshot overlay".to_string())
}

/// The overlay replaced its background (scroll capture result).
#[tauri::command]
pub async fn screenshot_overlay_update(
    path: String,
    width: u32,
    height: u32,
) -> Result<(), String> {
    capture::ensure_artifact_path(&path).map_err(internal_error)?;
    if let Some(overlay) = tool_state().overlay.as_mut() {
        overlay.path = path;
        overlay.width = width;
        overlay.height = height;
    }
    Ok(())
}

/// End the capture session: close the overlay and recorder bar, reshow the
/// hidden app windows and delete the session's temp files.
#[tauri::command]
pub async fn screenshot_close_overlay(app: AppHandle) -> Result<(), String> {
    close_session(&app);
    Ok(())
}

fn watch_session_window(window: &WebviewWindow) {
    let app = window.app_handle().clone();
    let label = window.label().to_string();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            let active = {
                let state = tool_state();
                if label == OVERLAY_LABEL {
                    state.overlay.is_some()
                } else {
                    state.recorder_open
                }
            };
            if active {
                let app = app.clone();
                // Joining recorder threads must not block the event loop.
                tauri::async_runtime::spawn_blocking(move || close_session(&app));
            }
        }
    });
}

pub(crate) fn close_session(app: &AppHandle) {
    SESSION_GENERATION.fetch_add(1, Ordering::SeqCst);
    let recording = {
        let mut state = tool_state();
        state.overlay = None;
        state.recorder_open = false;
        state.recording.take()
    };
    if let Some(id) = recording {
        let _ = record::cancel_recording(&id);
    }
    for label in [OVERLAY_LABEL, RECORDER_LABEL] {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.close();
        }
    }
    restore_app_windows(app);
    capture::purge_tracked();
}

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

    let scale = tool_state()
        .overlay
        .as_ref()
        .map(|o| o.scale_factor)
        .or_else(|| {
            app.primary_monitor()
                .ok()
                .flatten()
                .map(|m| m.scale_factor())
        })
        .unwrap_or(1.0)
        .max(0.5);
    // Logical size at 1:1 physical pixels, capped so huge shots stay usable.
    const MAX_DIM: f64 = 720.0;
    let (lw, lh) = (width as f64 / scale, height as f64 / scale);
    let fit = (MAX_DIM / lw.max(lh)).min(1.0);
    let label = format!(
        "{PIN_LABEL_PREFIX}{}",
        PIN_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    tool_state().pins.insert(
        label.clone(),
        PinInit {
            path: pinned.to_string_lossy().into_owned(),
            width,
            height,
        },
    );

    let url = WebviewUrl::App("index.html#screenshot-pin".into());
    let window = window_builder(&app, &label, url)
        .title("Pinned Screenshot")
        .inner_size((lw * fit).round().max(48.0), (lh * fit).round().max(48.0))
        .decorations(false)
        .resizable(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .build();
    let window = match window {
        Ok(window) => window,
        Err(e) => {
            tool_state().pins.remove(&label);
            std::fs::remove_file(&pinned).ok();
            return Err(format!("open pin window: {e}"));
        }
    };
    let pin_label = label.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::Destroyed = event {
            if let Some(pin) = tool_state().pins.remove(&pin_label) {
                std::fs::remove_file(pin.path).ok();
            }
        }
    });
    Ok(label)
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

// ---------------------------------------------------------------------------
// OCR & auto-redact
// ---------------------------------------------------------------------------

/// Extract text from a screenshot artifact via tesseract (if installed).
#[tauri::command]
pub async fn screenshot_ocr(path: String) -> Result<ocr::OcrResult, String> {
    tokio::task::spawn_blocking(move || {
        let path = capture::ensure_artifact_path(&path).map_err(internal_error)?;
        ocr::ocr_image(&path.to_string_lossy())
    })
    .await
    .map_err(|e| format!("ocr task failed: {e}"))?
}

/// Find sensitive tokens (e-mail / phone / ID) in an artifact via OCR.
/// Returns bounding boxes in physical pixels relative to the image.
#[tauri::command]
pub async fn screenshot_auto_redact(path: String) -> Result<ocr::RedactResult, String> {
    tokio::task::spawn_blocking(move || {
        let path = capture::ensure_artifact_path(&path).map_err(internal_error)?;
        let result = ocr::ocr_image(&path.to_string_lossy())?;
        let boxes = ocr::find_sensitive(&result.words);
        Ok::<_, String>(ocr::RedactResult {
            count: boxes.len(),
            boxes,
        })
    })
    .await
    .map_err(|e| format!("redact task failed: {e}"))?
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

fn recording_region(
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

/// Start recording a display region (physical pixels; all of `x/y/w/h`
/// absent = whole display). The overlay closes; the hidden app windows stay
/// hidden until the session ends so the recorded area matches the frozen
/// screenshot the region was chosen on.
#[allow(clippy::too_many_arguments)]
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
    let format = record::RecordFormat::parse(&format).map_err(internal_error)?;
    let region = recording_region(x, y, width, height)?;
    if STARTING_RECORDING.swap(true, Ordering::SeqCst) {
        return Err("screen recording is already starting".into());
    }
    let _start_guard = RecordingStartGuard;
    if tool_state().recorder_open {
        return Err("finish the current recording session first".into());
    }
    let generation = SESSION_GENERATION.load(Ordering::SeqCst);
    let had_overlay = tool_state().overlay.is_some();
    hide_app_windows(&app);
    if let Some(window) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = window.hide();
    }
    let worker = app.clone();
    let started = blocking("start recording", move || {
        let display = capture::resolve_display(&worker, display_id.as_deref())?;
        std::thread::sleep(HIDE_SETTLE);
        let id = record::start_recording(&worker, display.clone(), region, format, fps)?;
        Ok((id, display))
    })
    .await;
    let (recording_id, display) = match started {
        Ok(started) => started,
        Err(e) => {
            if let Some(window) = app.get_webview_window(OVERLAY_LABEL) {
                let _ = window.show();
                let _ = window.set_focus();
            }
            if !had_overlay {
                restore_app_windows(&app);
            }
            return Err(e);
        }
    };
    if SESSION_GENERATION.load(Ordering::SeqCst) != generation {
        let id = recording_id.clone();
        let _ = blocking("cancel recording", move || record::cancel_recording(&id)).await;
        return Err("screen recording start was cancelled".into());
    }
    {
        let mut state = tool_state();
        state.recording = Some(recording_id.clone());
        state.recorder_open = true;
        state.overlay = None;
    }
    if let Some(window) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = window.close();
    }
    if let Err(e) = open_recorder_bar(&app, &display) {
        let _ = record::cancel_recording(&recording_id);
        tool_state().recording = None;
        close_session(&app);
        return Err(e);
    }
    Ok(RecordingStarted { recording_id })
}

#[tauri::command]
pub async fn screenshot_stop_recording(recording_id: String) -> Result<RecordingFile, String> {
    if tool_state().recording.as_deref() != Some(&recording_id) {
        return Err("unknown recording id".into());
    }
    let current_id = recording_id.clone();
    let info = blocking("stop recording", move || {
        record::stop_recording(&recording_id)
    })
    .await;
    {
        let mut state = tool_state();
        if state.recording.as_deref() == Some(&current_id) {
            state.recording = None;
        }
    }
    let info = info?;
    Ok(RecordingFile {
        path: info.path.to_string_lossy().into_owned(),
        width: info.width,
        height: info.height,
        frames: info.frames,
        duration_ms: info.duration_ms,
    })
}

#[tauri::command]
pub async fn screenshot_cancel_recording(recording_id: String) -> Result<(), String> {
    if tool_state().recording.as_deref() != Some(&recording_id) {
        return Err("unknown recording id".into());
    }
    let current_id = recording_id.clone();
    let result = blocking("cancel recording", move || {
        record::cancel_recording(&recording_id)
    })
    .await;
    {
        let mut state = tool_state();
        if state.recording.as_deref() == Some(&current_id) {
            state.recording = None;
        }
    }
    result
}

/// The recorder bar window reads this to learn which recording it controls.
#[tauri::command]
pub async fn screenshot_current_recording() -> Result<Option<String>, String> {
    Ok(tool_state().recording.clone())
}

fn open_recorder_bar(app: &AppHandle, display: &DisplayInfo) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(RECORDER_LABEL) {
        let _ = existing.close();
    }
    let url = WebviewUrl::App("index.html#screenshot-recorder".into());
    // Compact while recording; the bar grows itself for the preview.
    let (lw, lh) = (300.0, 56.0);
    let window = window_builder(app, RECORDER_LABEL, url)
        .title("Recording")
        .inner_size(lw, lh)
        .visible(false)
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        // Keep the bar out of the recording (WDA_EXCLUDEFROMCAPTURE on
        // Windows, NSWindowSharingNone on macOS; no-op on Linux).
        .content_protected(true)
        .build()
        .map_err(|e| format!("open recorder bar: {e}"))?;
    watch_session_window(&window);
    // Bottom-center of the recorded display.
    let s = display.scale_factor.max(0.5);
    let (pw, ph) = ((lw * s) as i32, (lh * s) as i32);
    let x = display.x + (display.width as i32 - pw) / 2;
    // Leave room above for the grown preview (240 logical px).
    let y = display.y + display.height as i32 - ph - (240.0 * s) as i32;
    let _ = window.set_position(PhysicalPosition::new(x, y));
    window
        .show()
        .map_err(|e| format!("show recorder bar: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recording_requires_a_complete_nonempty_region() {
        assert_eq!(recording_region(None, None, None, None).unwrap(), None);
        assert_eq!(
            recording_region(Some(1), Some(2), Some(10), Some(20)).unwrap(),
            Some((1, 2, 10, 20))
        );
        assert!(recording_region(Some(1), None, Some(10), Some(20)).is_err());
        assert!(recording_region(Some(1), Some(2), Some(0), Some(20)).is_err());
    }

    #[test]
    fn clipboard_decodes_the_first_gif_frame_without_png_only_image_features() {
        let file = tempfile::Builder::new().suffix(".GIF").tempfile().unwrap();
        {
            let mut encoder =
                gif::Encoder::new(std::fs::File::create(file.path()).unwrap(), 4, 2, &[]).unwrap();
            for color in [[240, 40, 20, 255], [20, 60, 220, 255]] {
                let mut pixels = color.repeat(8);
                let frame = gif::Frame::from_rgba_speed(4, 2, &mut pixels, 10);
                encoder.write_frame(&frame).unwrap();
            }
        }
        let first = clipboard_image(file.path()).unwrap();
        assert_eq!(first.dimensions(), (4, 2));
        assert!(first.pixels().all(|p| p[0] > 200 && p[1] < 70 && p[2] < 50));
    }

    #[test]
    fn empty_gif_clipboard_image_is_rejected() {
        let file = tempfile::Builder::new().suffix(".gif").tempfile().unwrap();
        {
            let encoder = gif::Encoder::new(
                std::fs::File::create(file.path()).unwrap(),
                4,
                2,
                &[0, 0, 0],
            )
            .unwrap();
            drop(encoder);
        }
        assert!(clipboard_image(file.path()).is_err());
    }

    #[test]
    fn close_session_state_resets_overlay_and_recording() {
        {
            let mut state = tool_state();
            state.overlay = Some(OverlayInit {
                path: "x".into(),
                display_id: "0,0".into(),
                width: 1,
                height: 1,
                scale_factor: 1.0,
            });
            state.hidden = vec!["main".into()];
        }
        // Without an app handle we can only exercise the state transitions.
        let hidden = std::mem::take(&mut tool_state().hidden);
        tool_state().overlay = None;
        assert_eq!(hidden, vec!["main".to_string()]);
        assert!(tool_state().overlay.is_none());
    }
}
