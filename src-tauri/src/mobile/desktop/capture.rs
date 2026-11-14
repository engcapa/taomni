use super::now_unix_secs;
use crate::mobile::Core;
use image::{ColorType, ImageEncoder, RgbaImage, codecs::png::PngEncoder, imageops::FilterType};
use serde::{Deserialize, Serialize};

const MAX_CAPTURE_WIDTH: u32 = 1600;
const MAX_CAPTURE_HEIGHT: u32 = 1000;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct DisplaySummary {
    pub id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub primary: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ScreenCapture {
    pub mime: String,
    pub width: u32,
    pub height: u32,
    pub screen_width: u32,
    pub screen_height: u32,
    pub display_id: String,
    pub display_name: String,
    pub displays: Vec<DisplaySummary>,
    pub captured_at: u64,
    pub png: Vec<u8>,
}

/// Captures the current screen after verifying the explicit desktop Settings opt-in.
pub async fn capture_screen(
    core: &Core,
    display_id: Option<&str>,
) -> Result<ScreenCapture, String> {
    let state = core.state();
    if !state.mobile.desktop.screen_allowed() {
        return Err("screen_capture_disabled".into());
    }
    #[cfg(test)]
    if let Some(driver) = state.mobile.desktop.test_driver() {
        return driver.capture_screen(display_id);
    }
    let Core::Desktop(app) = core else {
        return Err("desktop_required".into());
    };
    let app = app.clone();
    let requested = display_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    tokio::task::spawn_blocking(move || capture_display_blocking(&app, requested.as_deref()))
        .await
        .map_err(|_| "desktop_screen_capture_failed".to_string())?
}

fn capture_display_blocking(
    app: &tauri::AppHandle,
    display_id: Option<&str>,
) -> Result<ScreenCapture, String> {
    let displays = crate::screenshot::capture::list_displays(app)
        .map_err(|error| map_capture_error(&error.to_string()))?;
    let target = crate::screenshot::capture::resolve_display(app, display_id)
        .map_err(|error| map_capture_error(&error.to_string()))?;
    let image = crate::screenshot::capture::capture_display(app, &target)
        .map_err(|error| map_capture_error(&error.to_string()))?;
    let (png, width, height, screen_width, screen_height) = encode_screen_png(image)?;
    Ok(ScreenCapture {
        mime: "image/png".into(),
        width,
        height,
        screen_width,
        screen_height,
        display_id: target.id,
        display_name: target.name,
        displays: displays
            .into_iter()
            .map(|item| DisplaySummary {
                id: item.id,
                name: item.name,
                width: item.width,
                height: item.height,
                primary: item.primary,
            })
            .collect(),
        captured_at: now_unix_secs(),
        png,
    })
}

pub(crate) fn encode_screen_png(rgba: RgbaImage) -> Result<(Vec<u8>, u32, u32, u32, u32), String> {
    let screen_width = rgba.width().max(1);
    let screen_height = rgba.height().max(1);
    let scaled = if screen_width > MAX_CAPTURE_WIDTH || screen_height > MAX_CAPTURE_HEIGHT {
        let ratio = (MAX_CAPTURE_WIDTH as f64 / screen_width as f64)
            .min(MAX_CAPTURE_HEIGHT as f64 / screen_height as f64);
        let dst_w = ((screen_width as f64 * ratio).round() as u32).max(1);
        let dst_h = ((screen_height as f64 * ratio).round() as u32).max(1);
        image::imageops::resize(&rgba, dst_w, dst_h, FilterType::Triangle)
    } else {
        rgba
    };
    let width = scaled.width();
    let height = scaled.height();
    let mut png = Vec::new();
    PngEncoder::new(&mut png)
        .write_image(scaled.as_raw(), width, height, ColorType::Rgba8.into())
        .map_err(|_| "desktop_screen_capture_failed".to_string())?;
    Ok((png, width, height, screen_width, screen_height))
}

fn map_capture_error(message: &str) -> String {
    if message.contains("Screen Recording") || message.contains("permission") {
        log::warn!("Mobile screen capture blocked by permission: {message}");
        "desktop_screen_permission_required".into()
    } else {
        log::warn!("Mobile screen capture failed: {message}");
        "desktop_screen_capture_failed".into()
    }
}
