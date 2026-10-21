use super::displays::DisplayInfo;
use super::displays::list_displays;
#[cfg(not(target_os = "linux"))]
use super::displays::xcap_monitor_for;
use super::permissions::ensure_capture_permission;
use super::pixels::crop;
use super::pixels::frame_to_rgba;
use super::source::FrameSource;
use crate::servers::rdp::capture::Capturer;
use anyhow::Context;
use image::RgbaImage;
use std::time::Duration;
use std::time::Instant;
use tauri::AppHandle;

/// Capture a whole display (physical pixels), without prompting from workers.
pub fn capture_display(app: &AppHandle, display: &DisplayInfo) -> anyhow::Result<RgbaImage> {
    ensure_capture_permission()?;
    #[cfg(not(target_os = "linux"))]
    {
        let _ = app;
        let monitor = xcap_monitor_for(display)?;
        monitor.capture_image().context("capture display")
    }
    #[cfg(target_os = "linux")]
    {
        let mut source = FrameSource::open(app, display.clone());
        let mut latest = source.grab()?;
        // Portal startup retains its first frame. Drain the stream through a
        // short settling interval so that frame cannot freeze a closing
        // chooser or the tail of the application's compositor animation.
        let until = Instant::now() + Duration::from_millis(250);
        while Instant::now() < until {
            if let Some(image) = source.poll()? {
                latest = image.clone();
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        Ok(latest)
    }
}

#[cfg(target_os = "linux")]
pub(super) fn wayland_monitor_capture(
    app: &AppHandle,
    log: &crate::servers::engine::LogEmitter,
    display: &DisplayInfo,
    request_input: bool,
) -> anyhow::Result<Box<dyn Capturer>> {
    use crate::servers::rdp::capture::wayland::{MonitorTarget, try_new_for_monitor};
    let (x, y, width, height) = display.logical_rect();
    try_new_for_monitor(
        log,
        request_input,
        MonitorTarget {
            position: (x, y),
            size: (width, height),
            single_monitor: list_displays(app)?.len() == 1,
        },
    )
}

pub(super) fn capture_one_shot(
    app: &AppHandle,
    display: &DisplayInfo,
) -> anyhow::Result<RgbaImage> {
    #[cfg(not(target_os = "linux"))]
    {
        capture_display(app, display)
    }
    #[cfg(target_os = "linux")]
    {
        let log =
            crate::servers::engine::LogEmitter::new(app.clone(), crate::servers::ServerType::Rdp);
        let mut capturer =
            crate::servers::rdp::capture::create_capturer(&log).context("init screen capturer")?;
        let frame = capturer.capture().context("capture frame")?;
        Ok(crop_desktop_to_display(
            app,
            frame_to_rgba(&frame)?,
            display,
        ))
    }
}

#[cfg(target_os = "linux")]
pub(super) fn crop_desktop_to_display(
    app: &AppHandle,
    desktop: RgbaImage,
    display: &DisplayInfo,
) -> RgbaImage {
    if desktop.dimensions() == (display.width, display.height) {
        return desktop;
    }
    // The X11 root origin is the top-left of the bounding
    // box of all monitors.
    let (min_x, min_y) = list_displays(app)
        .map(|ds| {
            (
                ds.iter().map(|d| d.x).min().unwrap_or(0),
                ds.iter().map(|d| d.y).min().unwrap_or(0),
            )
        })
        .unwrap_or((0, 0));
    let x = (display.x - min_x).max(0) as u32;
    let y = (display.y - min_y).max(0) as u32;
    crop(&desktop, x, y, display.width, display.height)
}
