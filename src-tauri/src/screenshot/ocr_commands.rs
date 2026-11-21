use crate::screenshot::capture;
use crate::screenshot::ocr;
use crate::screenshot::runtime::internal_error;
use crate::state::AppState;
use taomni_screenshot_api::{RECOGNIZE, REDACT};
use tauri::State;

// ---------------------------------------------------------------------------
// OCR & auto-redact
// ---------------------------------------------------------------------------

/// Extract text from a screenshot artifact via tesseract (if installed).
#[tauri::command]
pub async fn screenshot_ocr(
    path: String,
    state: State<'_, AppState>,
) -> Result<ocr::OcrResult, String> {
    if ocr::use_host(&state.plugins, RECOGNIZE)? {
        return ocr::process_image(state.plugins.clone(), RECOGNIZE, path).await;
    }
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
pub async fn screenshot_auto_redact(
    path: String,
    state: State<'_, AppState>,
) -> Result<ocr::RedactResult, String> {
    if ocr::use_host(&state.plugins, REDACT)? {
        return ocr::process_image(state.plugins.clone(), REDACT, path).await;
    }
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
