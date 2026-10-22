use super::control::ScrollCaptureResult;
use super::control::ScrollControl;
use super::control::ScrollMode;
use super::frames::capture_frames;
use super::input::Wheel;
use super::input::pointer_in_region;
use super::limits::INITIAL_SETTLE;
use super::limits::MANUAL_POLL;
use super::limits::MAX_FRAMES;
use super::limits::MIN_REGION_HEIGHT;
use super::sampling::settled_frame;
use crate::screenshot::capture::DisplayInfo;
use crate::screenshot::capture::FrameSource;
use crate::screenshot::capture::save_png;
use anyhow::Context;
use image::RgbaImage;
use std::sync::atomic::Ordering;
use tauri::AppHandle;

/// Run a scrolling capture over `width`x`height` at display-relative
/// physical `(x, y)`. Blocking; call from `spawn_blocking`.
pub fn scroll_capture(
    app: &AppHandle,
    display: &DisplayInfo,
    region: (u32, u32, u32, u32),
) -> anyhow::Result<ScrollCaptureResult> {
    scroll_capture_with(app, display, region, MAX_FRAMES)
}

/// [`scroll_capture`] with an explicit frame budget.
pub fn scroll_capture_with(
    app: &AppHandle,
    display: &DisplayInfo,
    region: (u32, u32, u32, u32),
    max_frames: u32,
) -> anyhow::Result<ScrollCaptureResult> {
    // Uncontrolled captures have no UI to scroll from: always automatic.
    scroll_capture_controlled(
        app,
        display,
        region,
        max_frames,
        &ScrollControl::new(ScrollMode::Auto),
    )
}

pub fn scroll_capture_controlled(
    app: &AppHandle,
    display: &DisplayInfo,
    region: (u32, u32, u32, u32),
    max_frames: u32,
    control: &ScrollControl,
) -> anyhow::Result<ScrollCaptureResult> {
    let (x, y, width, height) = region;
    if width < 8 || height < MIN_REGION_HEIGHT {
        anyhow::bail!("scroll capture region is too small ({width}x{height})");
    }
    // Manual capture never initializes input synthesis or asks for control
    // permission. Create it lazily if the user switches to automatic mode.
    let mut wheel: Option<Wheel> = None;
    control.settle(INITIAL_SETTLE);
    if control.cancel.load(Ordering::SeqCst) {
        anyhow::bail!("scroll capture cancelled");
    }

    let source = std::cell::RefCell::new(FrameSource::for_scroll(
        app,
        display.clone(),
        control.mode() == ScrollMode::Auto,
        region,
    ));
    let mut grab_raw = || -> anyhow::Result<RgbaImage> {
        source.borrow_mut().grab().context("capture scroll frame")
    };

    // Activate before establishing the first frame. Inactive/active window
    // chrome must not become the first pair used to identify fixed margins.
    let positioned = std::cell::Cell::new(false);
    // Keep a user-chosen hover point. Otherwise start near the right edge,
    // where lists usually have a gutter rather than an autoplay thumbnail.
    let target = app
        .cursor_position()
        .ok()
        .and_then(|point| {
            let px = point.x - display.x as f64;
            let py = point.y - display.y as f64;
            (px >= x as f64
                && px < (x + width) as f64
                && py >= y as f64
                && py < (y + height) as f64)
                .then_some((px as u32, py as u32))
        })
        .unwrap_or((x + width.saturating_sub(12), y + height / 2));
    let mut inject = |notches| -> anyhow::Result<()> {
        if source
            .borrow_mut()
            .portal_scroll(target.0, target.1, notches)?
        {
            positioned.set(true);
            return Ok(());
        }
        if wheel.is_none() {
            wheel = Some(Wheel::new()?);
        }
        let wheel = wheel.as_mut().unwrap();
        if !positioned.get() {
            wheel.move_to(display, target.0, target.1)?;
            positioned.set(true);
        }
        wheel.scroll(notches)
    };
    if control.mode() == ScrollMode::Auto {
        // Zero wheel motion only establishes the target; no content is skipped
        // before the first frame. A failed injection retains manual takeover.
        if let Err(error) = inject(0) {
            control.set_input_error(format!("{error:#}"));
            control.set_mode(ScrollMode::Manual);
        }
        control.settle(INITIAL_SETTLE);
    }

    let stitched = capture_frames(
        &mut || {
            let was_waiting = control.waiting_for_content.load(Ordering::SeqCst);
            let frame = settled_frame(&mut grab_raw, &mut |d| control.settle(d), control)?;
            if was_waiting != control.waiting_for_content.load(Ordering::SeqCst) {
                control.progress(app, control.frames.load(Ordering::SeqCst));
            }
            Ok(frame)
        },
        &mut |notches| {
            if !positioned.get() {
                inject(0)?;
            }
            // Let the pointer reach the controls. While outside, pause input
            // instead of dragging it back or scrolling a different window.
            while control.mode() == ScrollMode::Auto && !pointer_in_region(app, display, region) {
                control.settle(MANUAL_POLL);
                if control.stop.load(Ordering::SeqCst) {
                    return Ok(());
                }
            }
            if control.mode() != ScrollMode::Auto || control.stop.load(Ordering::SeqCst) {
                return Ok(());
            }
            inject(notches)
        },
        &mut |duration| control.settle(duration),
        &mut |frames| control.progress(app, frames),
        max_frames,
        control,
    )?;
    let (path, w, h) = save_png(&stitched.image, "scroll")?;
    Ok(ScrollCaptureResult {
        path: path.to_string_lossy().into_owned(),
        width: w,
        height: h,
        frames: stitched.frames,
    })
}
