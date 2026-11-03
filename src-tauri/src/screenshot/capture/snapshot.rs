use super::displays::DisplayInfo;
use super::displays::list_displays;
#[cfg(not(target_os = "linux"))]
use super::displays::xcap_monitor_for;
use super::permissions::ensure_capture_permission;
use super::pixels::crop;
use super::pixels::frame_to_rgba;
use super::source::FrameSource;
use crate::servers::rdp::capture::Capturer;
use crate::servers::rdp::capture::stage_trace;
use anyhow::Context;
use image::RgbaImage;
use std::time::Duration;
use std::time::Instant;
use tauri::AppHandle;

/// Capture a whole display (physical pixels), without prompting from workers.
/// Marks/cancellation have an effect only inside a caller's stage-trace scope.
pub fn capture_display(app: &AppHandle, display: &DisplayInfo) -> anyhow::Result<RgbaImage> {
    ensure_capture_permission()?;
    stage_trace::check_cancelled()?;
    #[cfg(not(target_os = "linux"))]
    {
        let _ = app;
        stage_trace::mark("capture_open_start");
        let monitor = xcap_monitor_for(display)?;
        stage_trace::mark("capture_open_end");
        let result = monitor.capture_image().context("capture display");
        stage_trace::mark("capture_grab");
        stage_trace::mark("capture_drain_end");
        stage_trace::mark("capture_drop_start");
        drop(monitor);
        stage_trace::mark("capture_drop_end");
        stage_trace::check_cancelled()?;
        result
    }
    #[cfg(target_os = "linux")]
    {
        // This source is constructed after the hide barrier, including when
        // overlap falls back after retiring its pre-barrier stream.
        let opened_after = Instant::now();
        let mut observed = ObservedSource::open(app, display)?;
        let result = (|| {
            let source = observed.source();
            let mut latest = None;
            let mut first = true;
            let until = Instant::now() + Duration::from_millis(250);
            loop {
                stage_trace::check_cancelled()?;
                if let Some(image) = source.poll()?.cloned() {
                    if first {
                        stage_trace::mark("capture_grab");
                        first = false;
                    }
                    if source.captured_at().is_some_and(|at| at >= opened_after) {
                        latest = Some(image);
                    }
                }
                if Instant::now() >= until {
                    break;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            stage_trace::check_cancelled()?;
            latest
                .context("capture produced no timestamped frame after hiding; retry the screenshot")
        })();
        stage_trace::mark("capture_drain_end");
        drop(observed);
        result
    }
}

/// Explicit retirement keeps the final Drop marks inside the observer/token
/// scope, including cancellation and failed polls. A reopen cannot overlap it.
#[cfg(target_os = "linux")]
pub(super) struct ObservedSource {
    source: Option<FrameSource>,
}

#[cfg(target_os = "linux")]
impl ObservedSource {
    pub(super) fn open(app: &AppHandle, display: &DisplayInfo) -> anyhow::Result<Self> {
        stage_trace::check_cancelled()?;
        stage_trace::mark("capture_open_start");
        let source = Self {
            source: Some(FrameSource::open(app, display.clone())),
        };
        stage_trace::mark("capture_open_end");
        stage_trace::check_cancelled()?;
        Ok(source)
    }

    pub(super) fn source(&mut self) -> &mut FrameSource {
        self.source
            .as_mut()
            .expect("capture source already retired")
    }
}

#[cfg(target_os = "linux")]
impl Drop for ObservedSource {
    fn drop(&mut self) {
        stage_trace::mark("capture_drop_start");
        drop(self.source.take());
        stage_trace::mark("capture_drop_end");
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
