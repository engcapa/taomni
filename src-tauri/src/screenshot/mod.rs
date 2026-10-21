//! Feishu-style system screenshot & screen recording tool.
//!
//! Captures the real OS screen on any display: fullscreen, region, scrolling
//! (auto-scroll + stitch), and video recording to GIF / MP4. Windows, macOS
//! and Linux are all supported.
//!
//! Overlay UX is static-background: [`open_overlay`] hides the app windows,
//! captures the display under the pointer, then opens a borderless overlay
//! covering that display which renders the captured PNG while the user
//! selects / annotates. Capture files are temp artifacts (see
//! `capture::temp_artifact_path`) read by the webview through
//! [`screenshot_read_file`] and deleted when the capture session ends.

use self::overlay_session::open_overlay_with_window;
use self::overlay_session::watch_session_window;
use self::pin_window::open_pin;
use self::pin_window::open_pin_with_note;
use self::recording_controls::open_recorder_bar;
use self::recording_controls::recording_region;
use self::runtime::NATIVE_WAYLAND;
use self::runtime::OPENING;
#[cfg(all(debug_assertions, target_os = "macos"))]
use self::runtime::QA_WINDOW_HIDE_CALLS;
use self::runtime::RecordingStartGuard;
use self::runtime::SESSION_GENERATION;
use self::runtime::STARTING_RECORDING;
use self::runtime::blocking;
use self::runtime::capture_lease;
use self::runtime::internal_error;
use self::runtime::tool_state;
use self::scroll_controls::capture_control_position;
use self::scroll_controls::open_scroll_bar;
use self::scroll_controls::scroll_layout;
use self::window_lifecycle::HIDE_SETTLE;
use self::window_lifecycle::await_hidden_windows;
use self::window_lifecycle::cover_display;
use self::window_lifecycle::hide_app_windows;
use self::window_lifecycle::restore_app_windows;
use self::window_lifecycle::restore_app_windows_for_preview;
use crate::screenshot::capture::DisplayInfo;
use crate::screenshot::capture::ScreenshotFile;
use crate::screenshot::scroll::ScrollCaptureResult;
use crate::state::AppState;
pub use model::OverlayInit;
pub use model::PhysicalRegion;
pub use model::PinInit;
pub use model::RecordingFile;
pub use model::RecordingStarted;
pub use model::ScreenshotProbe;
pub(crate) use overlay_session::close_session;
pub use overlay_session::open_overlay;
pub(crate) use recording_controls::recording_ended;
pub use runtime::shutdown;
pub(crate) use runtime::stop_orphaned_capture_controls;
pub(crate) use runtime::wait_for_recovery_recording;
use std::borrow::Cow;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::AppHandle;
use tauri::Manager;
use tauri::WebviewWindow;
pub(crate) use window_lifecycle::focus_capture_window;
pub(crate) use window_lifecycle::window_builder;
mod window_lifecycle;

mod model;

mod runtime;

mod scroll_controls;

mod overlay_session;

mod pin_window;

mod recording_controls;

#[cfg(test)]
mod tests;

pub mod capture;
pub mod edit;
pub mod favorites;
pub mod ocr;
#[cfg(target_os = "macos")]
mod ocr_macos;
#[cfg(target_os = "windows")]
mod ocr_windows;
pub mod pins;
pub mod qa;
mod qa_oracle;
pub mod record;
mod recovery_file;
pub mod scroll;
pub(crate) mod scroll_input;
mod session;
pub mod shortcut;
#[cfg(target_os = "linux")]
mod surface_backend;
pub mod surfaces;

pub const OVERLAY_LABEL: &str = "screenshot-overlay";
pub const RECORDER_LABEL: &str = "screenshot-recorder";
pub const PIN_LABEL_PREFIX: &str = "screenshot-pin-";

/// Startup: purge leftovers of earlier runs and register the hotkey.
pub fn init(app: &AppHandle) {
    #[cfg(target_os = "linux")]
    {
        use gtk::prelude::*;
        NATIVE_WAYLAND.store(
            gtk::gdk::Display::default().is_some_and(|d| d.type_().name() == "GdkWaylandDisplay"),
            Ordering::SeqCst,
        );
    }
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
    mode: Option<scroll::ScrollMode>,
) -> Result<ScrollCaptureResult, String> {
    // Retain ownership until the worker and stop listener have both left, even
    // if closing the overlay clears ToolState while cancellation is pending.
    let _capture_lease = capture_lease()?;
    // Fail while the selection UI can still show the instructions, before
    // hiding it or creating topmost controls. Never prompt from the worker.
    let mode = mode.unwrap_or_default();
    if mode == scroll::ScrollMode::Auto {
        scroll::ensure_control_permission().map_err(internal_error)?;
    }
    let display = capture::resolve_display(&app, display_id.as_deref()).map_err(internal_error)?;
    let requested = capture::clamp_region(display.width, display.height, (x, y, width, height));
    let (region, position) = scroll_layout(&app, &display, requested)?;
    let rect = surfaces::region_rect(&display, region);
    let control = Arc::new(scroll::ScrollControl::new(mode));
    {
        let mut state = tool_state();
        if state.scroll.is_some() || state.recorder_open {
            return Err("a capture is already running".into());
        }
        state.scroll = Some(control.clone());
    }
    // Establish an independent exit before hiding the overlay. Wayland keeps
    // its visible input strip because the compositor owns global input.
    let stop_input = if pins::native_wayland() {
        None
    } else {
        match scroll_input::StopInput::start(&app, control.clone()) {
            Ok(input) => Some(input),
            Err(error) => {
                tool_state().scroll = None;
                return Err(error);
            }
        }
    };
    let generation = SESSION_GENERATION.load(Ordering::SeqCst);
    let overlay = app.get_webview_window(OVERLAY_LABEL);
    if let Some(window) = &overlay {
        let _ = window.hide();
    }
    let surfaces = surfaces::open_borders(&app, &display, rect)
        .and_then(|()| open_scroll_bar(&app, &display, position, control.clone()));
    if let Err(error) = surfaces {
        tool_state().scroll = None;
        surfaces::close_borders(&app);
        if let Some(window) = app.get_webview_window(surfaces::SCROLL_LABEL) {
            let _ = window.close();
        }
        if let Some(window) = &overlay {
            let _ = window.show();
        }
        return Err(error);
    }
    let editor_display = display.clone();
    let worker = app.clone();
    let worker_control = control.clone();
    let result = blocking("scroll capture", move || {
        scroll::scroll_capture_controlled(&worker, &display, region, u32::MAX, &worker_control)
    })
    .await;
    drop(stop_input);
    if SESSION_GENERATION.load(Ordering::SeqCst) != generation {
        return Err("scroll capture cancelled".into());
    }
    tool_state().scroll = None;
    surfaces::close_borders(&app);
    if let Some(window) = app.get_webview_window(surfaces::SCROLL_LABEL) {
        let _ = window.close();
    }
    if let Some(window) = overlay {
        if result.is_ok() {
            edit::reset_hidden_surface(&window).await?;
            edit::configure_document_window(&window, &editor_display)?;
        }
        let _ = window.show();
        if result.is_ok() {
            edit::settle_document_window(&window, &editor_display).await?;
        }
        focus_capture_window(&window).await;
    }
    result
}

#[tauri::command]
pub async fn screenshot_scroll_surface() -> bool {
    false
}

#[tauri::command]
pub async fn screenshot_scroll_plan(
    app: AppHandle,
    display_id: Option<String>,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
) -> Result<PhysicalRegion, String> {
    let display = capture::resolve_display(&app, display_id.as_deref()).map_err(internal_error)?;
    let requested = capture::clamp_region(display.width, display.height, (x, y, width, height));
    let (region, _) = scroll_layout(&app, &display, requested)?;
    Ok(PhysicalRegion {
        x: region.0,
        y: region.1,
        width: region.2,
        height: region.3,
    })
}

#[tauri::command]
pub async fn screenshot_scroll_status() -> Result<Option<serde_json::Value>, String> {
    Ok(tool_state().scroll.as_ref().map(|control| control.status()))
}

#[tauri::command]
pub async fn screenshot_set_scroll_mode(mode: scroll::ScrollMode) -> Result<(), String> {
    if mode == scroll::ScrollMode::Auto {
        scroll::ensure_control_permission().map_err(internal_error)?;
    }
    if let Some(control) = &tool_state().scroll {
        control.set_mode(mode);
    }
    Ok(())
}

#[tauri::command]
pub async fn screenshot_stop_scroll_capture(cancel: bool) -> Result<(), String> {
    if let Some(control) = &tool_state().scroll {
        control.request_stop(cancel);
    }
    Ok(())
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
        let engine = ocr::engine_name();
        Ok(ScreenshotProbe {
            permission: base.permission,
            control_permission: base.control_permission,
            mp4_available: true,
            ocr_available: engine.is_some(),
            ocr_engine: engine.map(str::to_string),
            ocr_hint: engine.is_none().then(|| ocr::install_hint().to_string()),
            summary: format!(
                "{}. OCR {}.",
                base.summary,
                match engine {
                    Some(name) => format!("uses the {name} engine"),
                    None => "needs an OCR engine".into(),
                }
            ),
        })
    })
    .await
}

/// Tauri command wrapper for [`open_overlay`].
#[tauri::command]
pub async fn screenshot_open_overlay(
    app: AppHandle,
    window: WebviewWindow,
    display_id: Option<String>,
    include_current_window: Option<bool>,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    let display_id =
        if display_id.as_ref().is_none_or(|id| id.trim().is_empty()) && pins::native_wayland() {
            let worker = app.clone();
            let caller = window.clone();
            Some(
                blocking("invoking display", move || {
                    capture::display_for_window(&worker, &caller)
                })
                .await?
                .id,
            )
        } else {
            display_id
        };
    open_overlay_with_window(
        &app,
        display_id,
        include_current_window.unwrap_or(false).then_some(window),
    )
    .await
}

/// The pending overlay payload, set by [`open_overlay`].
#[tauri::command]
pub async fn screenshot_overlay_init() -> Result<OverlayInit, String> {
    tool_state()
        .overlay
        .clone()
        .ok_or_else(|| "no pending screenshot overlay".to_string())
}

/// Switch the selection surface to another physical display without ending
/// the screenshot session or requiring Taomni itself to move there.
#[tauri::command]
pub async fn screenshot_switch_display(
    app: AppHandle,
    window: WebviewWindow,
    display_id: String,
) -> Result<OverlayInit, String> {
    let _lease = capture_lease()?;
    {
        let state = tool_state();
        if window.label() != OVERLAY_LABEL
            || state.overlay.as_ref().is_none_or(|o| o.document)
            || state.scroll.is_some()
        {
            return Err("not a display selection session".into());
        }
    }
    let generation = SESSION_GENERATION.load(Ordering::SeqCst);
    let worker = app.clone();
    let display = blocking("display lookup", move || {
        capture::resolve_display(&worker, Some(&display_id))
    })
    .await?;
    window.hide().map_err(|e| e.to_string())?;
    tokio::time::sleep(HIDE_SETTLE).await;
    let worker = app.clone();
    let captured_display = display.clone();
    let captured = blocking("capture display", move || {
        capture::save_png(
            &capture::capture_display(&worker, &captured_display)?,
            "shot",
        )
    })
    .await;
    if SESSION_GENERATION.load(Ordering::SeqCst) != generation {
        return Err("screenshot opening was cancelled".into());
    }
    let result = captured.map(|(path, width, height)| OverlayInit {
        path: path.to_string_lossy().into_owned(),
        display_id: display.id.clone(),
        width,
        height,
        scale_factor: display.scale_factor,
        window_region: None,
        document: false,
        source_pin: None,
    });
    if let Ok(init) = &result {
        edit::reset_hidden_surface(&window).await?;
        if let Err(error) = cover_display(&window, &display).await {
            let _ = window.show();
            return Err(error);
        }
        tool_state().overlay = Some(init.clone());
    }
    let _ = window.show();
    focus_capture_window(&window).await;
    result
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
        overlay.document = true;
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
    let capture_lease = capture_lease()?;
    let generation = SESSION_GENERATION.load(Ordering::SeqCst);
    let had_overlay = tool_state().overlay.is_some();
    let display = capture::resolve_display(&app, display_id.as_deref()).map_err(internal_error)?;
    let bounded = capture::clamp_region(
        display.width,
        display.height,
        region.unwrap_or((0, 0, display.width, display.height)),
    );
    capture_control_position(&app, &display, surfaces::region_rect(&display, bounded))?;
    if !tool_state().include_current_window {
        hide_app_windows(&app);
    }
    if let Some(window) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = window.hide();
    }
    if let Err(error) = open_recorder_bar(&app, &display, bounded).await {
        surfaces::close_borders(&app);
        if let Some(window) = app.get_webview_window(RECORDER_LABEL) {
            let _ = window.close();
        }
        if let Some(window) = app.get_webview_window(OVERLAY_LABEL) {
            let _ = window.show();
        }
        if !had_overlay {
            restore_app_windows(&app);
        }
        return Err(error);
    }
    if SESSION_GENERATION.load(Ordering::SeqCst) != generation {
        return Err("screen recording start was cancelled".into());
    }
    let worker = app.clone();
    let started = blocking("start recording", move || {
        std::thread::sleep(HIDE_SETTLE);
        let id = record::start_recording(&worker, display.clone(), region, format, fps)?;
        Ok((id, display))
    })
    .await;
    let (recording_id, display) = match started {
        Ok(started) => started,
        Err(e) => {
            surfaces::close_borders(&app);
            if let Some(window) = app.get_webview_window(RECORDER_LABEL) {
                let _ = window.close();
            }
            if let Some(window) = app.get_webview_window(OVERLAY_LABEL) {
                let _ = window.show();
                focus_capture_window(&window).await;
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
        state.recording_preview = None;
        state.session_lease = Some(capture_lease);
        state.recorder_open = true;
        state.overlay = None;
        let r = capture::clamp_region(
            display.width,
            display.height,
            region.unwrap_or((0, 0, display.width, display.height)),
        );
        state.recording_region = Some(PhysicalRegion {
            x: r.0,
            y: r.1,
            width: r.2,
            height: r.3,
        });
    }
    if let Some(window) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = window.close();
    }
    if capture_control_position(&app, &display, surfaces::region_rect(&display, bounded))?.is_some()
    {
        if let Some(window) = app.get_webview_window(RECORDER_LABEL) {
            let _ = window.show();
        }
    }
    Ok(RecordingStarted { recording_id })
}

#[tauri::command]
pub async fn screenshot_stop_recording(
    app: AppHandle,
    recording_id: String,
) -> Result<RecordingFile, String> {
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
            if info.is_ok() {
                state.recording_preview = Some(current_id.clone());
            }
        }
    }
    surfaces::close_borders(&app);
    // The recorder preview remains open after Stop, but the application
    // windows hidden for the capture session must become available again.
    // Without this, the process stays alive while its main window is hidden,
    // so macOS app switching has no visible Taomni window to activate.
    restore_app_windows_for_preview(&app);
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
pub async fn screenshot_cancel_recording(
    app: AppHandle,
    recording_id: String,
) -> Result<(), String> {
    if tool_state().recording.as_deref() != Some(&recording_id) {
        return Err("unknown recording id".into());
    }
    let current_id = recording_id.clone();
    surfaces::close_borders(&app);
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
    while STARTING_RECORDING.load(Ordering::SeqCst) && tool_state().recording.is_none() {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    Ok(tool_state().recording.clone())
}

#[tauri::command]
pub async fn screenshot_recording_status() -> Result<Option<serde_json::Value>, String> {
    let (id, region) = {
        let state = tool_state();
        (state.recording.clone(), state.recording_region.clone())
    };
    Ok(id.map(|id| {
        let (finished, stopped_by_user) = record::recording_status(&id);
        serde_json::json!({ "recordingId": id, "finished": finished, "stoppedByUser": stopped_by_user, "region": region })
    }))
}
