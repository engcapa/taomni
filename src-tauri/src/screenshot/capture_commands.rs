use crate::screenshot::capture;
use crate::screenshot::capture::DisplayInfo;
use crate::screenshot::capture::ScreenshotFile;
use crate::screenshot::model::ScreenshotProbe;
use crate::screenshot::ocr;
use crate::screenshot::runtime::blocking;
use std::path::PathBuf;
use tauri::AppHandle;

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
