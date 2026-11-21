use crate::screenshot::capture;
use crate::screenshot::capture::DisplayInfo;
use crate::screenshot::capture::ScreenshotFile;
use crate::screenshot::model::ScreenshotProbe;
use crate::screenshot::ocr;
use crate::screenshot::overlay_handoff;
use crate::screenshot::runtime::blocking;
use crate::screenshot::startup_timing;
use crate::state::AppState;
use std::path::PathBuf;
use tauri::{AppHandle, State};

/// Raw bytes of a screenshot artifact. The UI turns them into a same-origin
/// `blob:` URL: unlike asset-protocol URLs (a different origin), blob images
/// never taint the annotation canvas, so export / color picking keep working
/// on every WebView engine.
#[tauri::command]
pub async fn screenshot_read_file(path: String) -> Result<tauri::ipc::Response, String> {
    // B10 of the startup timing: only the overlay's base image read-back.
    let base_image = overlay_handoff::is_base_image(&path);
    blocking("read", move || {
        let path = capture::ensure_artifact_path(&path)?;
        if base_image {
            startup_timing::mark("read_file_start");
        }
        let bytes = std::fs::read(path)?;
        if base_image {
            startup_timing::mark("read_file_end");
            startup_timing::note("readBytes", serde_json::json!(bytes.len()));
        }
        Ok(tauri::ipc::Response::new(bytes))
    })
    .await
}

pub(super) fn to_file(result: (PathBuf, u32, u32)) -> ScreenshotFile {
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
    // The overlay's live-capture fallback is for dev/QA direct opens only.
    // During a backend open the app windows may still be visible, so a
    // capture now could contain them.
    if overlay_handoff::open_pending() {
        return Err("a screenshot is opening; its capture is not ready yet".into());
    }
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

#[tauri::command]
pub async fn screenshot_probe(state: State<'_, AppState>) -> Result<ScreenshotProbe, String> {
    let base = blocking("probe", taomni_capture::engine::probe).await?;
    let availability = ocr::probe(state.plugins.clone())
        .await
        .unwrap_or_else(|error| taomni_screenshot_api::OcrAvailability {
            engine: None,
            hint: Some(error),
        });
    let summary = match &availability.engine {
        Some(name) => format!("{}. OCR uses the {name} engine.", base.summary),
        None => format!("{}. OCR needs an OCR engine.", base.summary),
    };
    Ok(ScreenshotProbe {
        permission: base.permission,
        control_permission: base.control_permission,
        mp4_available: true,
        ocr_available: availability.engine.is_some(),
        ocr_engine: availability.engine,
        ocr_hint: availability.hint,
        summary,
    })
}
