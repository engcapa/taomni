//! Display enumeration and still capture for the screenshot tool.
//!
//! Backend split mirrors `lanchat/transfer.rs`: Linux reuses the RDP server's
//! platform capture backends (X11 SHM/Damage, Wayland portal/PipeWire) which
//! are always compiled in; Windows/macOS use `xcap::Monitor` (non-optional
//! target dependencies there). Output is always a temp PNG file plus its
//! dimensions; the frontend loads it through `convertFileSrc`.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::Context;
use image::{DynamicImage, GenericImageView, RgbaImage};
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayInfo {
    pub id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    /// Display origin in the virtual desktop, physical pixels.
    pub x: i32,
    pub y: i32,
    pub primary: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotFile {
    pub path: String,
    pub width: u32,
    pub height: u32,
}

/// Temporary directory for screenshot tool artifacts.
pub fn artifact_dir() -> anyhow::Result<PathBuf> {
    let dir = std::env::temp_dir().join("taomni-screenshot");
    std::fs::create_dir_all(&dir).context("create screenshot temp dir")?;
    Ok(dir)
}

pub fn temp_artifact_path(prefix: &str, ext: &str) -> anyhow::Result<PathBuf> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    Ok(artifact_dir()?.join(format!("{prefix}-{}-{nanos}.{ext}", std::process::id())))
}

/// Enumerate displays on all three platforms.
pub fn list_displays(app: &tauri::AppHandle) -> anyhow::Result<Vec<DisplayInfo>> {
    match xcap_displays() {
        Ok(displays) if !displays.is_empty() => Ok(displays),
        _ => {
            // xcap enumeration can come back empty on some Linux/Wayland
            // compositors; fall back to the RDP capture backend's desktop size.
            #[cfg(target_os = "linux")]
            {
                fallback_linux_display(app)
            }
            #[cfg(not(target_os = "linux"))]
            {
                anyhow::bail!("no displays found")
            }
        }
    }
}

fn xcap_displays() -> anyhow::Result<Vec<DisplayInfo>> {
    let monitors = xcap::Monitor::all().context("enumerate displays")?;
    monitors
        .into_iter()
        .map(|monitor| {
            Ok(DisplayInfo {
                id: monitor.id().context("display id")?.to_string(),
                name: monitor
                    .friendly_name()
                    .or_else(|_| monitor.name())
                    .unwrap_or_else(|_| "Display".to_string()),
                width: monitor.width().context("display width")?,
                height: monitor.height().context("display height")?,
                x: monitor.x().unwrap_or(0),
                y: monitor.y().unwrap_or(0),
                primary: monitor.is_primary().unwrap_or(false),
            })
        })
        .collect()
}

#[cfg(target_os = "linux")]
fn fallback_linux_display(app: &tauri::AppHandle) -> anyhow::Result<Vec<DisplayInfo>> {
    use crate::servers::rdp::capture::Capturer;
    let log = crate::servers::engine::LogEmitter::new(app.clone(), crate::servers::ServerType::Rdp);
    let capturer =
        crate::servers::rdp::capture::create_capturer(&log).context("init screen capturer")?;
    let (width, height) = capturer.desktop_size();
    Ok(vec![DisplayInfo {
        id: "0".to_string(),
        name: "Display".to_string(),
        width: u32::from(width),
        height: u32::from(height),
        x: 0,
        y: 0,
        primary: true,
    }])
}

/// Capture a full display to a temp PNG. Returns `(path, width, height)`.
pub fn capture_display_png(
    app: &tauri::AppHandle,
    display_id: Option<&str>,
) -> anyhow::Result<(PathBuf, u32, u32)> {
    let image = capture_display_image(app, display_id)?;
    let (width, height) = image.dimensions();
    let path = temp_artifact_path("shot", "png")?;
    image.save(&path).context("save screenshot png")?;
    Ok((path, width, height))
}

/// Capture a region (display-relative physical pixels) to a temp PNG.
pub fn capture_region_png(
    app: &tauri::AppHandle,
    display_id: Option<&str>,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
) -> anyhow::Result<(PathBuf, u32, u32)> {
    let image = capture_display_image(app, display_id)?;
    let (full_w, full_h) = image.dimensions();
    let x = x.min(full_w.saturating_sub(1));
    let y = y.min(full_h.saturating_sub(1));
    let width = width.min(full_w.saturating_sub(x)).max(1);
    let height = height.min(full_h.saturating_sub(y)).max(1);
    let cropped = image.crop_imm(x, y, width, height);
    let (cw, ch) = cropped.dimensions();
    let path = temp_artifact_path("shot", "png")?;
    cropped.save(&path).context("save region png")?;
    Ok((path, cw, ch))
}

/// Capture a region and return the decoded image (for scroll stitching and
/// recording, which must not round-trip through a file per frame).
pub fn capture_region_image(
    app: &tauri::AppHandle,
    display_id: Option<&str>,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
) -> anyhow::Result<RgbaImage> {
    let image = capture_display_image(app, display_id)?;
    let (full_w, full_h) = image.dimensions();
    let x = x.min(full_w.saturating_sub(1));
    let y = y.min(full_h.saturating_sub(1));
    let width = width.min(full_w.saturating_sub(x)).max(1);
    let height = height.min(full_h.saturating_sub(y)).max(1);
    Ok(image.crop_imm(x, y, width, height).to_rgba8())
}

fn capture_display_image(
    app: &tauri::AppHandle,
    display_id: Option<&str>,
) -> anyhow::Result<DynamicImage> {
    #[cfg(target_os = "linux")]
    {
        let _ = display_id; // Linux captures the whole virtual desktop.
        capture_linux_image(app)
    }
    #[cfg(not(target_os = "linux"))]
    {
        capture_xcap_image(display_id)
    }
}

#[cfg(target_os = "linux")]
fn capture_linux_image(app: &tauri::AppHandle) -> anyhow::Result<DynamicImage> {
    let log = crate::servers::engine::LogEmitter::new(app.clone(), crate::servers::ServerType::Rdp);
    let mut capturer = crate::servers::rdp::capture::create_capturer(&log)
        .context("init screen capturer")?;
    let frame = capturer.capture().context("capture frame")?;
    bgra_frame_to_image(&frame)
}

#[cfg(not(target_os = "linux"))]
fn capture_xcap_image(display_id: Option<&str>) -> anyhow::Result<DynamicImage> {
    let monitor = select_monitor(display_id)?;
    let rgba = monitor.capture_image().context("capture display")?;
    Ok(DynamicImage::ImageRgba8(rgba))
}

#[cfg(not(target_os = "linux"))]
fn select_monitor(display_id: Option<&str>) -> anyhow::Result<xcap::Monitor> {
    let requested = display_id.filter(|v| !v.trim().is_empty());
    let monitors = xcap::Monitor::all().context("enumerate displays")?;
    if let Some(want) = requested {
        if let Some(monitor) = monitors.iter().find(|m| {
            m.id().ok().is_some_and(|id| id.to_string() == want)
                || m.name().ok().is_some_and(|name| name == want)
        }) {
            return Ok(monitor.clone());
        }
        anyhow::bail!("display '{want}' is no longer available")
    }
    monitors
        .iter()
        .find(|m| m.is_primary().unwrap_or(false))
        .cloned()
        .or_else(|| monitors.into_iter().next())
        .context("no active displays found")
}

/// Convert an RDP capture BGRA frame to an `image` RGBA image.
#[cfg(target_os = "linux")]
fn bgra_frame_to_image(
    frame: &crate::servers::rdp::capture::Frame,
) -> anyhow::Result<DynamicImage> {
    let width = u32::from(frame.width);
    let height = u32::from(frame.height);
    if width == 0 || height == 0 {
        anyhow::bail!("capturer returned an empty frame");
    }
    let bytes = frame.bgra_bytes().context("read frame pixels")?;
    let row_bytes = width as usize * 4;
    if frame.stride < row_bytes {
        anyhow::bail!("frame stride is smaller than the visible row");
    }
    let mut rgba = Vec::with_capacity((width * height * 4) as usize);
    for row in 0..height as usize {
        let start = row * frame.stride;
        let row_slice = bytes
            .get(start..start + row_bytes)
            .context("frame row out of bounds")?;
        for px in row_slice.chunks_exact(4) {
            rgba.push(px[2]); // R
            rgba.push(px[1]); // G
            rgba.push(px[0]); // B
            rgba.push(px[3]); // A
        }
    }
    let image = RgbaImage::from_raw(width, height, rgba).context("build rgba image")?;
    Ok(DynamicImage::ImageRgba8(image))
}

/// Display origin for overlay/recorder window placement. `(0, 0)` when the
/// display id is unknown.
pub fn display_origin(app: &tauri::AppHandle, display_id: Option<&str>) -> (i32, i32) {
    let Ok(displays) = list_displays(app) else {
        return (0, 0);
    };
    if let Some(want) = display_id.filter(|v| !v.trim().is_empty()) {
        if let Some(d) = displays.iter().find(|d| d.id == want) {
            return (d.x, d.y);
        }
    }
    if let Some(d) = displays.iter().find(|d| d.primary) {
        return (d.x, d.y);
    }
    displays.first().map(|d| (d.x, d.y)).unwrap_or((0, 0))
}
