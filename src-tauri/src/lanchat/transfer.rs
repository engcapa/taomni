//! Screenshot / clipboard-image / open-path helpers for LanChat.
//!
//! The file-transfer engine now lives in [`crate::lanchat::swarm`]; this module
//! keeps the platform media helpers it relied on: screen capture, encoding
//! clipboard/webview images to a temp PNG, and opening a received path with the
//! OS default handler. Captured/encoded files are then handed to `swarm::send`.

use std::path::PathBuf;

fn temp_image_path(prefix: &str) -> PathBuf {
    std::env::temp_dir().join(format!("taomni-lanchat-{prefix}-{}.png", uuid::Uuid::new_v4()))
}

/// Open a path with the platform's default handler (file or folder).
pub fn open_path(path: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("explorer").arg(path).spawn();
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(path).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = std::process::Command::new("xdg-open").arg(path).spawn();
    result.map(|_| ()).map_err(|e| format!("open {path}: {e}"))
}

/// Capture the primary monitor to a temp PNG and return its path. Blocking —
/// call via `spawn_blocking`. Requires the `screen-capture` feature (xcap +
/// platform screen-capture libraries, e.g. PipeWire on Linux/Wayland).
#[cfg(feature = "screen-capture")]
pub fn capture_screenshot() -> Result<PathBuf, String> {
    let monitors = xcap::Monitor::all().map_err(|e| format!("enumerate monitors: {e}"))?;
    let monitor = monitors.into_iter().next().ok_or("no monitor found")?;
    let image = monitor.capture_image().map_err(|e| format!("capture: {e}"))?;
    let path = temp_image_path("shot");
    image.save(&path).map_err(|e| format!("save screenshot: {e}"))?;
    Ok(path)
}

/// Stub when built without the `screen-capture` feature.
#[cfg(not(feature = "screen-capture"))]
pub fn capture_screenshot() -> Result<PathBuf, String> {
    Err("此版本未启用屏幕截图（需 screen-capture 构建特性）".into())
}

/// Save raw RGBA8 pixels (e.g. from the clipboard) to a temp PNG; return path.
/// Uses the pure-Rust `image` crate (no system dependencies).
pub fn save_rgba_png(width: u32, height: u32, rgba: &[u8]) -> Result<PathBuf, String> {
    let buf = image::RgbaImage::from_raw(width, height, rgba.to_vec())
        .ok_or("invalid image buffer")?;
    let path = temp_image_path("clip");
    buf.save(&path).map_err(|e| format!("save clipboard image: {e}"))?;
    Ok(path)
}

/// Write a pre-encoded PNG blob (e.g. a webview getDisplayMedia capture) to a
/// temp file and return its path. Used by the screenshot fallback when native
/// capture (the `screen-capture` build feature) is unavailable.
pub fn save_png_bytes(bytes: &[u8]) -> Result<PathBuf, String> {
    let path = temp_image_path("shot");
    std::fs::write(&path, bytes).map_err(|e| format!("save image: {e}"))?;
    Ok(path)
}
