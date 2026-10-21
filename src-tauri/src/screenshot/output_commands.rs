use crate::screenshot::capture;
use crate::screenshot::capture::ScreenshotFile;
use crate::screenshot::runtime::blocking;
use crate::state::AppState;
use std::borrow::Cow;
use std::path::PathBuf;
use tauri::AppHandle;
use tauri::Manager;

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

pub(super) fn clipboard_image(path: &std::path::Path) -> anyhow::Result<image::RgbaImage> {
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
