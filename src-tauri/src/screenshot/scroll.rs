//! Scrolling ("long") screenshot: capture a region, synthesize wheel scrolls
//! at its center, capture again, and stitch frames by vertical overlap.
//!
//! Stitching model. Each frame of the region is split into a static header
//! (rows identical across frames, e.g. a sticky toolbar), a scrolling body
//! and a static footer. Consecutive bodies join within their shared overlap;
//! the header/footer and supported fixed side chrome occur only once.
//! Overlap between consecutive bodies is the largest shift-consistent match
//! (mean absolute luma difference below a threshold); ties resolve to the
//! largest overlap so flat content is never duplicated.
//!
//! The overlay window hides itself before this runs (it would otherwise be
//! captured and swallow the wheel events), then reopens on the result.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::Duration;

use anyhow::Context;
use image::RgbaImage;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

#[cfg(test)]
use super::capture::crop;
use super::capture::{DisplayInfo, FrameSource, save_png};

/// Upper bound for one stitched image (pixels); caps memory at ~4*w*h bytes.
const MAX_STITCHED_HEIGHT: u32 = 20_000;
const MAX_FRAMES: u32 = 400;
/// Let the hidden overlay leave the screen before the first frame.
const INITIAL_SETTLE: Duration = Duration::from_millis(350);
/// Smooth-scroll animations in WebView2/WebKit finish well within this.
const SETTLE_DELAY: Duration = Duration::from_millis(450);
/// Consecutive unchanged frames that end the capture (page bottom).
const STILL_LIMIT: u32 = 6;
/// Consecutive one-notch steps without overlap before manual takeover.
const LOST_LIMIT: u32 = 3;
const MANUAL_POLL: Duration = Duration::from_millis(120);
const FRAME_CONFIRM: Duration = Duration::from_millis(80);
/// Columns sampled per row for matching (frames are column-averaged to this).
const MATCH_COLUMNS: usize = 128;
/// Mean absolute luma difference accepted as "same content".
const MATCH_THRESHOLD: f64 = 6.0;
/// Rows whose difference stays below this are static between frames.
const STATIC_THRESHOLD: f64 = 1.5;
/// Minimum overlap (rows) for a match to be trusted.
const MIN_OVERLAP: usize = 16;
/// Shortest region a scroll capture accepts (three overlap bands).
pub const MIN_REGION_HEIGHT: u32 = (MIN_OVERLAP as u32) * 3;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrollCaptureResult {
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub frames: u32,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ScrollMode {
    Auto,
    /// Default: manual scrolling needs no input synthesis or permissions.
    #[default]
    Manual,
}

pub struct ScrollControl {
    pub stop: AtomicBool,
    pub cancel: AtomicBool,
    pub frames: AtomicU32,
    automatic: AtomicBool,
    needs_overlap: AtomicBool,
    input_error: std::sync::Mutex<Option<String>>,
}

impl Default for ScrollControl {
    fn default() -> Self {
        Self::new(ScrollMode::default())
    }
}

impl ScrollControl {
    pub fn new(mode: ScrollMode) -> Self {
        Self {
            stop: AtomicBool::new(false),
            cancel: AtomicBool::new(false),
            frames: AtomicU32::new(0),
            automatic: AtomicBool::new(mode == ScrollMode::Auto),
            needs_overlap: AtomicBool::new(false),
            input_error: std::sync::Mutex::new(None),
        }
    }

    pub fn mode(&self) -> ScrollMode {
        if self.automatic.load(Ordering::SeqCst) {
            ScrollMode::Auto
        } else {
            ScrollMode::Manual
        }
    }

    pub fn set_mode(&self, mode: ScrollMode) {
        self.automatic
            .store(mode == ScrollMode::Auto, Ordering::SeqCst);
    }

    fn set_input_error(&self, message: String) {
        *self.input_error.lock().unwrap_or_else(|e| e.into_inner()) = Some(message);
    }

    pub fn status(&self) -> serde_json::Value {
        serde_json::json!({
            "frames": self.frames.load(Ordering::SeqCst),
            "mode": self.mode(),
            "needsOverlap": self.needs_overlap.load(Ordering::SeqCst),
            "inputError": self.input_error.lock().unwrap_or_else(|e| e.into_inner()).clone(),
        })
    }

    pub fn request_stop(&self, cancel: bool) {
        if cancel {
            self.cancel.store(true, Ordering::SeqCst);
        }
        self.stop.store(true, Ordering::SeqCst);
    }

    fn settle(&self, duration: Duration) {
        let until = std::time::Instant::now() + duration;
        while !self.stop.load(Ordering::SeqCst) && std::time::Instant::now() < until {
            std::thread::sleep(
                Duration::from_millis(20)
                    .min(until.saturating_duration_since(std::time::Instant::now())),
            );
        }
    }

    fn progress(&self, app: &AppHandle, frames: u32) {
        self.frames.store(frames, Ordering::SeqCst);
        let _ = app.emit("screenshot://scroll-progress", self.status());
    }
}

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
    let mut inject = |notches| -> anyhow::Result<()> {
        if source
            .borrow_mut()
            .portal_scroll(x + width / 2, y + height / 2, notches)?
        {
            return Ok(());
        }
        if wheel.is_none() {
            wheel = Some(Wheel::new()?);
        }
        let wheel = wheel.as_mut().unwrap();
        if !positioned.get() {
            wheel.move_to(display, x + width / 2, y + height / 2)?;
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
        &mut || settled_frame(&mut grab_raw, &mut |d| control.settle(d), control),
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

/// Check RGB pixels in small tiles, sampling alternate rows. A thin border must not be
/// diluted by a large unchanged center as it is in an image-wide luma mean.
fn stable_frame(a: &RgbaImage, b: &RgbaImage) -> bool {
    if a.dimensions() != b.dimensions() {
        return false;
    }
    let (w, h) = a.dimensions();
    for y in (0..h).step_by(32) {
        for x in (0..w).step_by(32) {
            let mut changed = 0;
            let (right, bottom) = ((x + 32).min(w), (y + 32).min(h));
            for cy in (y..bottom).step_by(2) {
                for cx in x..right {
                    let p = a.get_pixel(cx, cy);
                    let q = b.get_pixel(cx, cy);
                    if (0..3).any(|c| p[c].abs_diff(q[c]) > 12) {
                        changed += 1;
                    }
                }
            }
            if changed * 100 > (right - x) * (bottom - y).div_ceil(2) * 4 {
                return false;
            }
        }
    }
    true
}

/// Wait for two agreeing samples, including in manual mode. Return no frame
/// during motion: never stitch a transient frame just because its center fits.
fn settled_frame(
    grab: &mut impl FnMut() -> anyhow::Result<RgbaImage>,
    wait: &mut impl FnMut(Duration),
    control: &ScrollControl,
) -> anyhow::Result<Option<RgbaImage>> {
    let mut previous = grab()?;
    for _ in 0..8 {
        wait(FRAME_CONFIRM);
        if control.stop.load(Ordering::SeqCst) {
            return Ok(None);
        }
        let frame = grab()?;
        if stable_frame(&previous, &frame) {
            return Ok(Some(frame));
        }
        previous = frame;
    }
    Ok(None)
}

fn pointer_in_region(app: &AppHandle, display: &DisplayInfo, region: (u32, u32, u32, u32)) -> bool {
    // Wayland owns pointer routing through its approved portal session.
    if super::pins::native_wayland() {
        return true;
    }
    app.cursor_position()
        .map(|point| {
            let left = (display.x + region.0 as i32) as f64;
            let top = (display.y + region.1 as i32) as f64;
            point.x >= left
                && point.x < left + region.2 as f64
                && point.y >= top
                && point.y < top + region.3 as f64
        })
        .unwrap_or(true)
}

/// The capture policy is independent of OS input and frame acquisition so
/// delayed scrolling, manual pauses and overlap recovery can be tested.
fn capture_frames(
    grab: &mut impl FnMut() -> anyhow::Result<Option<RgbaImage>>,
    scroll: &mut impl FnMut(i32) -> anyhow::Result<()>,
    wait: &mut impl FnMut(Duration),
    progress: &mut impl FnMut(u32),
    max_frames: u32,
    control: &ScrollControl,
) -> anyhow::Result<Stitched> {
    let first = loop {
        if control.stop.load(Ordering::SeqCst) {
            anyhow::bail!("scroll capture cancelled");
        }
        if let Some(frame) = grab()? {
            break frame;
        }
    };
    let mut stitcher = Stitcher::new(first);
    progress(stitcher.frames);
    // Notches per step: large regions scroll faster; a step that jumps past
    // the region is undone and retried with a single notch.
    let mut notches: i32 = if stitcher.frame_h >= 600 { 3 } else { 1 };
    let mut still = 0u32;
    let mut lost = 0u32;
    let mut previous_mode = control.mode();

    while !control.stop.load(Ordering::SeqCst)
        && stitcher.frames < max_frames.min(MAX_FRAMES)
        && stitcher.height() < MAX_STITCHED_HEIGHT
    {
        let mode = control.mode();
        if mode != previous_mode {
            still = 0;
            previous_mode = mode;
        }
        if mode == ScrollMode::Auto {
            if let Err(error) = scroll(notches) {
                control.set_input_error(format!("{error:#}"));
                control.set_mode(ScrollMode::Manual);
                progress(stitcher.frames);
                continue;
            }
        }
        wait(if mode == ScrollMode::Auto {
            SETTLE_DELAY
        } else {
            MANUAL_POLL
        });
        if control.stop.load(Ordering::SeqCst) {
            break;
        }
        let frame = loop {
            if control.stop.load(Ordering::SeqCst) {
                break None;
            }
            if let Some(frame) = grab()? {
                break Some(frame);
            }
            // Motion is still settling: do not inject another scroll step.
            wait(MANUAL_POLL);
        };
        let Some(frame) = frame else {
            break;
        };
        let mut step = stitcher.push(frame);
        // Animations/lazy rendering can momentarily destroy the overlap.
        // Re-read without injecting another scroll before trying recovery.
        if mode == ScrollMode::Auto {
            for _ in 0..3 {
                if !matches!(step, Step::Lost) || control.stop.load(Ordering::SeqCst) {
                    break;
                }
                wait(SETTLE_DELAY);
                if control.stop.load(Ordering::SeqCst) {
                    break;
                }
                if let Some(frame) = grab()? {
                    step = stitcher.push(frame);
                }
            }
        }
        match step {
            Step::Appended => {
                still = 0;
                lost = 0;
                control.needs_overlap.store(false, Ordering::SeqCst);
                progress(stitcher.frames);
            }
            Step::Unchanged => {
                // A pause is normal in manual mode, including at page end.
                // Keep the session alive until Finish or Cancel is requested.
                if mode == ScrollMode::Auto && control.mode() == ScrollMode::Auto {
                    still += 1;
                    if still >= STILL_LIMIT {
                        if stitcher.frames > 1 {
                            break;
                        }
                        // No movement may mean input was not accepted rather
                        // than page end. Let the user take over instead of
                        // returning a one-screen "long" screenshot.
                        control.set_mode(ScrollMode::Manual);
                        progress(stitcher.frames);
                    }
                }
            }
            Step::Lost => {
                still = 0;
                control.needs_overlap.store(true, Ordering::SeqCst);
                if mode == ScrollMode::Auto && control.mode() == ScrollMode::Auto {
                    if let Err(error) = scroll(-notches) {
                        control.set_input_error(format!("{error:#}"));
                        control.set_mode(ScrollMode::Manual);
                        progress(stitcher.frames);
                        continue;
                    }
                    wait(SETTLE_DELAY);
                    if control.stop.load(Ordering::SeqCst) {
                        break;
                    }
                    // Never rebase on an unverified frame: that would silently
                    // skip content or duplicate rows in the accumulated image.
                    let back = grab()?
                        .map(|frame| stitcher.push(frame))
                        .unwrap_or(Step::Lost);
                    if matches!(back, Step::Lost) {
                        control.set_mode(ScrollMode::Manual);
                    } else if notches > 1 {
                        notches = 1;
                        control.needs_overlap.store(false, Ordering::SeqCst);
                    } else {
                        // Already at one notch: lazy loading or late layout
                        // can break a single step. Retry a few times before
                        // asking the user to take over.
                        lost += 1;
                        if lost >= LOST_LIMIT {
                            control.set_mode(ScrollMode::Manual);
                        } else {
                            control.needs_overlap.store(false, Ordering::SeqCst);
                        }
                    }
                }
                progress(stitcher.frames);
            }
        }
    }

    if control.cancel.load(Ordering::SeqCst) {
        anyhow::bail!("scroll capture cancelled");
    }

    Ok(stitcher.finish())
}

// ---------------------------------------------------------------------------
// Input synthesis
// ---------------------------------------------------------------------------

struct Wheel {
    enigo: enigo::Enigo,
}

/// A denial-only fault at the permission boundary, scoped to an isolated QA scenario.
/// Never grants permissions or modifies the host TCC database.
#[cfg(all(debug_assertions, target_os = "macos"))]
static QA_DENY_CONTROL: AtomicBool = AtomicBool::new(false);

#[cfg(all(debug_assertions, target_os = "macos"))]
pub(super) struct QaPermissionDenial;

#[cfg(all(debug_assertions, target_os = "macos"))]
impl QaPermissionDenial {
    pub(super) fn new(app: &tauri::AppHandle) -> anyhow::Result<Self> {
        anyhow::ensure!(
            app.config().identifier == crate::QA_APP_ID,
            "permission fault requires isolated QA app"
        );
        QA_DENY_CONTROL.store(true, Ordering::SeqCst);
        Ok(Self)
    }
}

#[cfg(all(debug_assertions, target_os = "macos"))]
impl Drop for QaPermissionDenial {
    fn drop(&mut self) {
        QA_DENY_CONTROL.store(false, Ordering::SeqCst);
    }
}

#[cfg(target_os = "macos")]
fn control_permission_granted() -> bool {
    #[cfg(debug_assertions)]
    if QA_DENY_CONTROL.load(Ordering::SeqCst) {
        return false;
    }
    crate::servers::rdp::control_permission_granted()
}

pub(super) fn ensure_control_permission() -> anyhow::Result<()> {
    #[cfg(target_os = "macos")]
    if !control_permission_granted() {
        anyhow::bail!(
            "Scrolling capture requires macOS Accessibility permission. Press Esc to leave the screenshot overlay, then open System Settings > Privacy & Security > Accessibility and enable Taomni. If launched from Terminal, enable Terminal instead (or the terminal app named by macOS); use + to add /System/Applications/Utilities/Terminal.app if it is missing. Restart the launching app after granting permission, then retry."
        );
    }
    Ok(())
}

impl Wheel {
    fn new() -> anyhow::Result<Self> {
        ensure_control_permission()?;
        let settings = enigo::Settings {
            // Default Enigo initialization prompts from the capture worker,
            // behind our topmost/fullscreen windows. Preflight above instead.
            #[cfg(target_os = "macos")]
            open_prompt_to_get_permissions: false,
            ..enigo::Settings::default()
        };
        let enigo = enigo::Enigo::new(&settings).map_err(|e| {
            anyhow::anyhow!(
                "input synthesis unavailable ({e}); on macOS grant Accessibility permission to Taomni"
            )
        })?;
        Ok(Self { enigo })
    }

    /// Move the pointer to display-relative physical `(px, py)`.
    fn move_to(&mut self, display: &DisplayInfo, px: u32, py: u32) -> anyhow::Result<()> {
        let gx = display.x + px as i32;
        let gy = display.y + py as i32;
        #[cfg(target_os = "windows")]
        {
            // enigo normalises absolute moves to the primary monitor only;
            // SetCursorPos takes virtual-desktop physical pixels (the app is
            // per-monitor DPI aware), so any display works.
            let _ = &mut self.enigo;
            use windows::Win32::UI::WindowsAndMessaging::SetCursorPos;
            unsafe {
                SetCursorPos(gx, gy).map_err(|e| anyhow::anyhow!("move pointer: {e}"))?;
            }
            activate_scroll_target(gx, gy);
            Ok(())
        }
        #[cfg(not(target_os = "windows"))]
        {
            use enigo::{Coordinate, Mouse};
            // Quartz event coordinates are logical points.
            let (ex, ey) = if cfg!(target_os = "macos") {
                let s = display.scale_factor.max(1.0);
                (
                    (gx as f64 / s).round() as i32,
                    (gy as f64 / s).round() as i32,
                )
            } else {
                (gx, gy)
            };
            self.enigo
                .move_mouse(ex, ey, Coordinate::Abs)
                .map_err(|e| anyhow::anyhow!("move pointer: {e}"))
        }
    }

    /// Positive scrolls the content down (towards the page end).
    fn scroll(&mut self, notches: i32) -> anyhow::Result<()> {
        use enigo::{Axis, Mouse};
        #[cfg(target_os = "windows")]
        unsafe {
            use windows::Win32::{Foundation::POINT, UI::WindowsAndMessaging::GetCursorPos};
            let mut point = POINT::default();
            if GetCursorPos(&mut point).is_ok() {
                // Returning from the controls must work with Windows' inactive
                // window scrolling disabled, without moving the user's mouse.
                activate_scroll_target(point.x, point.y);
            }
        }
        self.enigo
            .scroll(notches, Axis::Vertical)
            .map_err(|e| anyhow::anyhow!("synthesize scroll: {e}"))
    }
}

/// Best-effort activation of the window under the crop. SendInput wheel
/// events go to the old focused app when Windows "Scroll inactive windows"
/// is disabled, so try to activate the target without clicking its content.
/// The foreground lock routinely rejects this once our overlay has hidden;
/// that must not stop the capture: with the default setting Windows routes
/// the wheel to the hovered window anyway, and real non-delivery is caught
/// by the unchanged-frame detection.
#[cfg(target_os = "windows")]
fn activate_scroll_target(gx: i32, gy: i32) {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows::Win32::UI::WindowsAndMessaging::{
        GA_ROOT, GetAncestor, GetForegroundWindow, GetWindowThreadProcessId, SetForegroundWindow,
        WindowFromPoint,
    };
    unsafe {
        // Activate the actual top-level target. Its owner can be a different
        // (even hidden) app window; focusing that owner loses wheel delivery.
        let target = GetAncestor(WindowFromPoint(POINT { x: gx, y: gy }), GA_ROOT);
        if target.is_invalid() {
            return;
        }
        let foreground = GetForegroundWindow();
        if target == foreground {
            return;
        }
        let mut activated = SetForegroundWindow(target).as_bool();
        if !activated && !foreground.is_invalid() {
            // Sharing the foreground thread's input state lifts the lock.
            let current = GetCurrentThreadId();
            let owner = GetWindowThreadProcessId(foreground, None);
            if owner != 0 && owner != current && AttachThreadInput(current, owner, true).as_bool() {
                activated = SetForegroundWindow(target).as_bool();
                let _ = AttachThreadInput(current, owner, false);
            }
        }
        if activated {
            std::thread::sleep(Duration::from_millis(80));
        } else {
            log::debug!(
                "scroll capture: could not activate target window; relying on hover wheel routing"
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Stitching
// ---------------------------------------------------------------------------

/// Column-averaged luma rows of a frame (`MATCH_COLUMNS` samples per row).
struct Signature {
    rows: Vec<[u8; MATCH_COLUMNS]>,
    columns: usize,
}

impl Signature {
    fn of(image: &RgbaImage) -> Self {
        let (w, h) = image.dimensions();
        let raw = image.as_raw();
        let mut rows = Vec::with_capacity(h as usize);
        // Native resize shadows and scrollbar gutters are stationary chrome,
        // not scrolling content. Keep their pixels in the output but do not
        // let their changing edges defeat footer/overlap detection.
        let edge = if w >= 128 {
            (w / 20).clamp(32, 64) as usize
        } else {
            0
        };
        let matched_width = w as usize - 2 * edge;
        let cols = MATCH_COLUMNS.min(matched_width).max(1);
        for y in 0..h as usize {
            let mut row = [0u8; MATCH_COLUMNS];
            for (c, slot) in row.iter_mut().enumerate().take(cols) {
                let x0 = edge + c * matched_width / cols;
                let x1 = (edge + (c + 1) * matched_width / cols).max(x0 + 1);
                let mut sum = 0u32;
                for x in x0..x1 {
                    let i = (y * w as usize + x) * 4;
                    sum +=
                        (raw[i] as u32 * 299 + raw[i + 1] as u32 * 587 + raw[i + 2] as u32 * 114)
                            / 1000;
                }
                *slot = (sum / (x1 - x0) as u32) as u8;
            }
            rows.push(row);
        }
        Self {
            rows,
            columns: cols,
        }
    }

    fn len(&self) -> usize {
        self.rows.len()
    }

    fn moving_columns(&self, other: &Self) -> Vec<usize> {
        let h = self.len().min(other.len());
        (0..self.columns.min(other.columns))
            .filter(|&c| {
                let diff: u64 = (0..h)
                    .map(|y| self.rows[y][c].abs_diff(other.rows[y][c]) as u64)
                    .sum();
                diff as f64 / h.max(1) as f64 > STATIC_THRESHOLD
            })
            .collect()
    }

    fn row_diff(&self, a: usize, other: &Signature, b: usize, columns: &[usize]) -> u32 {
        columns
            .iter()
            .map(|&c| self.rows[a][c].abs_diff(other.rows[b][c]) as u32)
            .sum()
    }
}

/// Mean absolute difference between `rows` rows of `a` (from `a_y`) and `b`
/// (from `b_y`), sampling every `step`-th row.
fn band_mean(
    a: &Signature,
    a_y: usize,
    b: &Signature,
    b_y: usize,
    rows: usize,
    step: usize,
    columns: &[usize],
) -> f64 {
    let mut sum = 0u64;
    let mut n = 0u64;
    let mut r = 0;
    while r < rows {
        sum += a.row_diff(a_y + r, b, b_y + r, columns) as u64;
        n += 1;
        r += step;
    }
    sum as f64 / (n.max(1) * columns.len().max(1) as u64) as f64
}

/// Leading and trailing rows that did not change between two frames.
fn static_margins(a: &Signature, b: &Signature, columns: &[usize]) -> (usize, usize) {
    let h = a.len().min(b.len());
    let limit = h / 3;
    let same = |y: usize| {
        a.row_diff(y, b, y, columns) as f64 / columns.len().max(1) as f64 <= STATIC_THRESHOLD
    };
    let top = (0..limit).take_while(|&y| same(y)).count();
    let bottom = (0..limit).take_while(|&k| same(h - 1 - k)).count();
    (top, bottom)
}

/// Rows of `next`'s body that repeat the bottom of `prev`'s body, searched
/// over bodies `[top, h - bottom)`. `None` when no shift matches.
fn find_overlap(
    prev: &Signature,
    next: &Signature,
    top: usize,
    bottom: usize,
    columns: &[usize],
) -> Option<usize> {
    let h = prev.len().min(next.len());
    let body = h.checked_sub(top + bottom)?;
    // A short overlap fits inside one flat stripe of content and "matches"
    // anywhere; require it to span a sixth of the body so it covers
    // structure that must line up.
    let min_overlap = MIN_OVERLAP.max(body / 6);
    if body < min_overlap * 2 {
        return None;
    }
    let mean_at = |overlap: usize, step: usize| {
        // prev body rows [body - overlap, body) vs next body rows [0, overlap)
        band_mean(
            prev,
            top + body - overlap,
            next,
            top,
            overlap,
            step,
            columns,
        )
    };
    // Coarse pass over every overlap with sparse rows, then a dense refine
    // around the best candidates.
    let mut best: Option<(usize, f64)> = None;
    for overlap in min_overlap..=body {
        let m = mean_at(overlap, 4);
        // `<=` keeps the largest overlap on ties: never duplicate content.
        if best.is_none_or(|(_, b)| m <= b + 1e-9) {
            best = Some((overlap, m));
        }
    }
    let (coarse, _) = best?;
    let lo = coarse.saturating_sub(4).max(min_overlap);
    let hi = (coarse + 4).min(body);
    let mut refined: Option<(usize, f64)> = None;
    for overlap in lo..=hi {
        let m = mean_at(overlap, 1);
        if refined.is_none_or(|(_, b)| m <= b + 1e-9) {
            refined = Some((overlap, m));
        }
    }
    let (overlap, mean) = refined?;
    (mean <= MATCH_THRESHOLD).then_some(overlap)
}

#[derive(Debug)]
enum Step {
    /// New rows were appended.
    Appended,
    /// The view did not move.
    Unchanged,
    /// The view moved but no overlap was found (scrolled too far).
    Lost,
}

struct Stitched {
    image: RgbaImage,
    frames: u32,
}

struct Stitcher {
    width: u32,
    frame_h: u32,
    /// Static rows, fixed by the first frame pair that moved.
    margins: Option<(usize, usize)>,
    /// Side chrome that does not follow the verified content displacement.
    sides: Option<SideEvidence>,
    side_splits: Vec<u32>,
    /// Rows accumulated so far: header + body rows (footer excluded once
    /// margins are known).
    rows: Vec<u8>,
    last: RgbaImage,
    last_sig: Signature,
    frames: u32,
}

impl Stitcher {
    fn new(first: RgbaImage) -> Self {
        let sig = Signature::of(&first);
        Self {
            width: first.width(),
            frame_h: first.height(),
            margins: None,
            sides: None,
            side_splits: Vec::new(),
            rows: first.as_raw().clone(),
            last: first,
            last_sig: sig,
            frames: 1,
        }
    }

    fn height(&self) -> u32 {
        (self.rows.len() / (self.width as usize * 4)) as u32
    }

    fn push(&mut self, frame: RgbaImage) -> Step {
        if frame.dimensions() != (self.width, self.frame_h) {
            return Step::Lost;
        }
        let sig = Signature::of(&frame);
        if sig.rows == self.last_sig.rows {
            return Step::Unchanged;
        }
        let columns = self.last_sig.moving_columns(&sig);
        if columns.is_empty() {
            return Step::Unchanged;
        }
        let (top, bottom) = match self.margins {
            Some(m) => m,
            None => {
                let m = static_margins(&self.last_sig, &sig, &columns);
                if m.0 + m.1 >= self.frame_h as usize * 2 / 3 {
                    // Everything (or nearly) static: the page did not move.
                    return Step::Unchanged;
                }
                m
            }
        };
        let body = self.frame_h as usize - top - bottom;
        let Some(overlap) = find_overlap(&self.last_sig, &sig, top, bottom, &columns) else {
            return Step::Lost;
        };
        if overlap >= body {
            return Step::Unchanged;
        }
        let evidence = fixed_sides(&self.last, &frame, top, body - overlap, overlap);
        let merged = self.sides.map_or(evidence, |old| old.merge(evidence));
        if self.sides.is_none_or(|old| old.sides() != merged.sides()) {
            self.side_splits = side_chrome_splits(&self.last, &frame, merged.sides());
        }
        self.sides = Some(merged);
        if self.margins.is_none() {
            // First movement: drop the first frame's footer from the output;
            // the final footer is appended by `finish`.
            self.margins = Some((top, bottom));
            let keep = (self.frame_h as usize - bottom) * self.width as usize * 4;
            self.rows.truncate(keep);
        }
        let row_bytes = self.width as usize * 4;
        // Join in the middle of the verified overlap. Appending only the new
        // tail leaves the previous viewport's rounded corners/scrollbar ends
        // inside the image, even when the scrolling content aligns perfectly.
        let replaced = overlap / 2;
        self.rows.truncate(self.rows.len() - replaced * row_bytes);
        let start = (top + overlap - replaced) * row_bytes;
        let end = (top + body) * row_bytes;
        self.rows.extend_from_slice(&frame.as_raw()[start..end]);
        self.last = frame;
        self.last_sig = sig;
        self.frames += 1;
        Step::Appended
    }

    fn finish(mut self) -> Stitched {
        if let Some((_, bottom)) = self.margins {
            let row_bytes = self.width as usize * 4;
            let start = (self.frame_h as usize - bottom) * row_bytes;
            self.rows.extend_from_slice(&self.last.as_raw()[start..]);
        }
        let height = self.height();
        let mut image = RgbaImage::from_raw(self.width, height, self.rows)
            .expect("stitched rows are whole rows");
        if let Some((left, right)) = self.sides.map(SideEvidence::sides) {
            for (start, end) in [(0, left), (self.width - right, self.width)] {
                let mut from = start;
                for to in self
                    .side_splits
                    .iter()
                    .copied()
                    .filter(|&x| x > start && x < end)
                    .chain([end])
                {
                    extend_side_chrome(&mut image, &self.last, from, to - from);
                    from = to;
                }
            }
        }
        Stitched {
            image,
            frames: self.frames,
        }
    }
}

/// Side chrome evidence from one verified frame pair, per edge (left, right):
/// `chrome` is the extent of columns that do not follow the content shift
/// (fixed icons, borders, scrollbar thumbs); `bound` is the first column that
/// does follow it, beyond which the side can never extend.
#[derive(Clone, Copy, Debug, PartialEq)]
struct SideEvidence {
    chrome: (u32, u32),
    bound: (u32, u32),
}

impl SideEvidence {
    fn merge(self, other: Self) -> Self {
        Self {
            chrome: (
                self.chrome.0.max(other.chrome.0),
                self.chrome.1.max(other.chrome.1),
            ),
            bound: (
                self.bound.0.min(other.bound.0),
                self.bound.1.min(other.bound.1),
            ),
        }
    }

    fn sides(self) -> (u32, u32) {
        (
            self.chrome.0.min(self.bound.0),
            self.chrome.1.min(self.bound.1),
        )
    }
}

/// Classify edge columns against the verified vertical shift. Constant
/// sidebars, shadows and changing scrollbar thumbs must not be treated as
/// another scrolling page. Plain background matches either way, so it neither
/// bounds nor starts a side: a terminal's blank right margin must not hide a
/// fixed icon or scrollbar beside it. Require a close RGB match.
fn fixed_sides(
    previous: &RgbaImage,
    next: &RgbaImage,
    top: usize,
    shift: usize,
    overlap: usize,
) -> SideEvidence {
    let width = next.width() as usize;
    let a = previous.as_raw();
    let b = next.as_raw();
    // (follows the shift, contradicts the shift)
    let classify = |x: usize| {
        let mut aligned_bad = 0;
        let mut still_bad = 0;
        for y in top..top + overlap {
            let from = ((y + shift) * width + x) * 4;
            let at = (y * width + x) * 4;
            if (0..3).any(|c| a[from + c].abs_diff(b[at + c]) > 12) {
                aligned_bad += 1;
            }
            if (0..3).any(|c| a[at + c].abs_diff(b[at + c]) > 12) {
                still_bad += 1;
            }
        }
        let follows = aligned_bad <= overlap / 100;
        // Even a few shifted text rows prove the column is page content.
        (follows && still_bad >= aligned_bad + 2, !follows)
    };
    let limit = width / 3;
    let edge = |column: &dyn Fn(usize) -> usize| {
        let mut chrome = 0;
        for k in 0..limit {
            let (moving, fixed) = classify(column(k));
            if moving {
                return (chrome, k as u32);
            }
            if fixed {
                chrome = k as u32 + 1;
            }
        }
        (chrome, limit as u32)
    };
    let (left_chrome, left_bound) = edge(&|k| k);
    let (right_chrome, right_bound) = edge(&|k| width - 1 - k);
    SideEvidence {
        chrome: (left_chrome, right_chrome),
        bound: (left_bound, right_bound),
    }
}

/// A changing scrollbar and a stationary window shadow/desktop are separate
/// surfaces. Do not let text/icons behind the window prevent the plain track
/// from extending, or duplicate the thumb at a body seam as a result.
fn side_chrome_splits(
    previous: &RgbaImage,
    next: &RgbaImage,
    (left, right): (u32, u32),
) -> Vec<u32> {
    let (w, h) = next.dimensions();
    let a = previous.as_raw();
    let b = next.as_raw();
    let changing = |x: u32| {
        let mut changed = 0;
        for y in 0..h {
            let i = (y as usize * w as usize + x as usize) * 4;
            if (0..3).any(|c| a[i + c].abs_diff(b[i + c]) > 12) {
                changed += 1;
            }
        }
        changed > 2
    };
    let mut splits = Vec::new();
    for (start, end) in [(0, left), (w - right, w)] {
        let mut previous = None;
        for x in start..end {
            let current = changing(x);
            if previous.is_some_and(|old| old != current) {
                splits.push(x);
            }
            previous = Some(current);
        }
    }
    splits
}

/// Retain fixed chrome once, inserting extra height into its longest plain
/// spacer. This preserves top/bottom arrows and sidebar controls without
/// scaling them or cropping the user's selection. Complex sides with no plain
/// spacer are left as captured; never invent a background over their content.
fn extend_side_chrome(output: &mut RgbaImage, last: &RgbaImage, x: u32, width: u32) {
    if width == 0 || output.height() <= last.height() {
        return;
    }
    let stride = last.width() as usize * 4;
    let bytes = width as usize * 4;
    let start = x as usize * 4;
    let row =
        |y: u32| &last.as_raw()[y as usize * stride + start..y as usize * stride + start + bytes];
    let (mut run_start, mut best_start, mut best_len) = (0, 0, 0);
    for y in 1..=last.height() {
        if y == last.height() || row(y) != row(run_start) {
            if y - run_start > best_len {
                best_start = run_start;
                best_len = y - run_start;
            }
            run_start = y;
        }
    }
    if best_len < 16 {
        return;
    }
    let seam = best_start + best_len / 2;
    let extra = output.height() - last.height();
    for y in 0..output.height() {
        let source_y = if y < seam {
            y
        } else if y < seam + extra {
            seam
        } else {
            y - extra
        };
        let dest = y as usize * stride + start;
        let pixels: &mut [u8] = output.as_mut();
        pixels[dest..dest + bytes].copy_from_slice(row(source_y));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transient_edges_are_rejected_even_when_the_scrolling_center_matches() {
        let original = page(640, 300);
        let mut transient = original.clone();
        for y in 0..300 {
            for x in [0, 1, 638, 639] {
                transient.put_pixel(x, y, image::Rgba([255, 0, 0, 255]));
            }
        }
        assert!(!stable_frame(&original, &transient));
        let mut frames = [transient, original.clone(), original.clone()].into_iter();
        let control = ScrollControl::new(ScrollMode::Manual);
        let settled =
            settled_frame(&mut || Ok(frames.next().unwrap()), &mut |_| {}, &control).unwrap();
        assert_eq!(settled, Some(original));
    }

    #[test]
    fn automatic_capture_does_not_scroll_again_while_a_frame_is_settling() {
        let page = page(64, 1000);
        let mut frames = [
            Some(view(&page, 0, 300, 0, 0)),
            None,
            None,
            Some(view(&page, 120, 300, 0, 0)),
        ]
        .into_iter();
        let control = ScrollControl::new(ScrollMode::Auto);
        let mut wheels = Vec::new();
        let out = capture_frames(
            &mut || Ok(frames.next().unwrap()),
            &mut |n| {
                wheels.push(n);
                Ok(())
            },
            &mut |_| {},
            &mut |n| {
                if n == 2 {
                    control.request_stop(false);
                }
            },
            MAX_FRAMES,
            &control,
        )
        .unwrap();
        assert_eq!(wheels, [1]);
        assert_eq!(out.image, crop(&page, 0, 0, 64, 420));
    }

    #[test]
    fn whole_window_matches_scrolling_content_beside_a_fixed_sidebar_and_changing_gutter() {
        let page = page(640, 1000);
        let frame = |offset| {
            let mut image = view(&page, offset, 300, 24, 18);
            for y in 0..300 {
                for x in 0..200 {
                    // A vertically patterned sidebar cannot match a vertical shift.
                    image.put_pixel(x, y, image::Rgba([(y % 255) as u8, 70, 120, 255]));
                }
                for x in 624..640 {
                    image.put_pixel(x, y, image::Rgba([offset as u8, (y % 255) as u8, 30, 255]));
                }
            }
            image
        };
        let mut stitcher = Stitcher::new(frame(0));
        assert!(matches!(stitcher.push(frame(100)), Step::Appended));
        assert!(matches!(stitcher.push(frame(200)), Step::Appended));
        let out = stitcher.finish().image;
        assert_eq!(out.height(), 500);
        // The bottom border occurs only once, after all the original body rows.
        assert_eq!(
            crop(&out, 220, 24, 380, 458),
            crop(&page, 220, 24, 380, 458)
        );
        assert_eq!(
            crop(&out, 220, 482, 380, 18),
            crop(&frame(200), 220, 282, 380, 18)
        );
    }

    #[test]
    fn fixed_side_arrows_and_corners_are_retained_once_without_cropping() {
        let page = page(240, 1000);
        let frame = |offset| {
            let mut image = view(&page, offset, 300, 0, 0);
            for y in 0..300 {
                for x in (0..12).chain(224..240) {
                    let value = if y < 12 || y >= 288 { 30 } else { 240 };
                    image.put_pixel(x, y, image::Rgba([value, value, value, 255]));
                }
            }
            // The scrollbar thumb changes its viewport position.
            for y in 20 + offset / 2..50 + offset / 2 {
                for x in 227..235 {
                    image.put_pixel(x, y, image::Rgba([100, 100, 100, 255]));
                }
            }
            // A stationary, detailed desktop beside the scrollbar has no
            // plain spacer. It must not block extension of the thumb's track.
            for y in 0..300 {
                for x in 236..240 {
                    image.put_pixel(x, y, image::Rgba([(y % 255) as u8, 40, 80, 255]));
                }
            }
            image
        };
        let mut stitcher = Stitcher::new(frame(0));
        for offset in [100, 200, 300, 400] {
            assert!(matches!(stitcher.push(frame(offset)), Step::Appended));
        }
        let out = stitcher.finish().image;
        assert_eq!(out.dimensions(), (240, 700));
        assert_eq!(crop(&out, 12, 0, 212, 700), crop(&page, 12, 0, 212, 700));
        for x in [0, 11, 224, 235] {
            let ends = (0..700).filter(|&y| out.get_pixel(x, y)[0] == 30).count();
            assert_eq!(ends, 24, "repeated corner/arrow at x={x}");
        }
        let thumb = (0..700)
            .filter(|&y| out.get_pixel(230, y)[0] == 100)
            .count();
        assert_eq!(thumb, 30, "scrollbar thumb must occur once");
    }

    #[test]
    fn fixed_icons_and_scrollbar_beyond_a_wide_blank_margin_appear_once() {
        // A terminal: text only in the left part, a blank background wider
        // than a third of the window, then a fixed rail icon and a scrollbar.
        let page = page(200, 1000);
        let bg = image::Rgba([29, 31, 33, 255]);
        let frame = |offset: u32| {
            let mut image = RgbaImage::from_pixel(480, 300, bg);
            image::imageops::replace(&mut image, &view(&page, offset, 300, 0, 0), 0, 0);
            for y in 0..300 {
                for x in 470..480 {
                    image.put_pixel(x, y, image::Rgba([10, 10, 10, 255]));
                }
            }
            for y in 100..116 {
                for x in 450..466 {
                    image.put_pixel(x, y, image::Rgba([223, 247, 243, 255]));
                }
            }
            for y in 10 + offset / 4..40 + offset / 4 {
                for x in 436..444 {
                    image.put_pixel(x, y, image::Rgba([70, 72, 73, 255]));
                }
            }
            image
        };
        let mut stitcher = Stitcher::new(frame(0));
        for offset in [100, 200, 300, 400] {
            assert!(matches!(stitcher.push(frame(offset)), Step::Appended));
        }
        let out = stitcher.finish().image;
        assert_eq!(out.dimensions(), (480, 700));
        assert_eq!(crop(&out, 0, 0, 200, 700), crop(&page, 0, 0, 200, 700));
        let count = |x: u32, value: u8| {
            (0..700)
                .filter(|&y| out.get_pixel(x, y)[0] == value)
                .count()
        };
        assert_eq!(count(458, 223), 16, "rail icon must occur once");
        assert_eq!(count(440, 70), 30, "scrollbar thumb must occur once");
    }

    #[test]
    fn manual_pauses_do_not_finish_and_never_inject_wheel_input() {
        let page = page(64, 1000);
        let control = ScrollControl::new(ScrollMode::Manual);
        let mut reads = 0;
        let out = capture_frames(
            &mut || {
                reads += 1;
                Ok(Some(view(
                    &page,
                    if reads <= 12 { 0 } else { 120 },
                    300,
                    0,
                    0,
                )))
            },
            &mut |_| panic!("manual mode must not synthesize input"),
            &mut |_| {},
            &mut |frames| {
                if frames == 2 {
                    control.request_stop(false);
                }
            },
            MAX_FRAMES,
            &control,
        )
        .unwrap();
        assert_eq!(reads, 13);
        assert_eq!(out.image, crop(&page, 0, 0, 64, 420));
    }

    #[test]
    fn automatic_capture_waits_through_two_unchanged_frames_before_motion() {
        let page = page(64, 1000);
        let control = ScrollControl::new(ScrollMode::Auto);
        let mut reads = 0;
        let mut wheels = Vec::new();
        let out = capture_frames(
            &mut || {
                reads += 1;
                Ok(Some(view(
                    &page,
                    if reads <= 3 { 0 } else { 120 },
                    300,
                    0,
                    0,
                )))
            },
            &mut |n| {
                wheels.push(n);
                Ok(())
            },
            &mut |_| {},
            &mut |frames| {
                if frames == 2 {
                    control.request_stop(false);
                }
            },
            MAX_FRAMES,
            &control,
        )
        .unwrap();
        assert_eq!(wheels, [1, 1, 1]);
        assert_eq!(out.image, crop(&page, 0, 0, 64, 420));
    }

    #[test]
    fn automatic_capture_rereads_a_transient_unmatchable_frame_without_scrolling_again() {
        let page = page(64, 1000);
        let control = ScrollControl::new(ScrollMode::Auto);
        let mut reads = 0;
        let mut wheels = Vec::new();
        let out = capture_frames(
            &mut || {
                reads += 1;
                Ok(Some(match reads {
                    1 => view(&page, 0, 300, 0, 0),
                    2 => image::RgbaImage::from_pixel(64, 300, image::Rgba([0, 0, 0, 255])),
                    _ => view(&page, 120, 300, 0, 0),
                }))
            },
            &mut |n| {
                wheels.push(n);
                Ok(())
            },
            &mut |_| {},
            &mut |frames| {
                if frames == 2 {
                    control.request_stop(false);
                }
            },
            MAX_FRAMES,
            &control,
        )
        .unwrap();
        assert_eq!(wheels, [1]);
        assert_eq!(out.image, crop(&page, 0, 0, 64, 420));
    }

    #[test]
    fn manual_is_the_default_mode() {
        assert_eq!(ScrollMode::default(), ScrollMode::Manual);
        assert_eq!(ScrollControl::default().mode(), ScrollMode::Manual);
    }

    #[test]
    fn automatic_capture_survives_a_single_lost_step_at_one_notch() {
        let page = page(64, 2000);
        let control = ScrollControl::new(ScrollMode::Auto);
        // Scroll position follows the wheel; one forward step lands on an
        // unmatchable (lazy-rendering) frame, then recovers.
        let position = std::cell::Cell::new(0i32);
        let mut reads = 0;
        let mut glitch = true;
        let out = capture_frames(
            &mut || {
                reads += 1;
                if position.get() == 240 && glitch {
                    glitch = reads < 6;
                    return Ok(Some(RgbaImage::from_pixel(
                        64,
                        300,
                        image::Rgba([0, 0, 0, 255]),
                    )));
                }
                Ok(Some(view(&page, position.get() as u32, 300, 0, 0)))
            },
            &mut |n| {
                position.set((position.get() + n * 120).max(0));
                Ok(())
            },
            &mut |_| {},
            &mut |frames| {
                if frames == 4 {
                    control.request_stop(false);
                }
            },
            MAX_FRAMES,
            &control,
        )
        .unwrap();
        assert_eq!(
            control.mode(),
            ScrollMode::Auto,
            "one lost step must not force manual mode"
        );
        assert_eq!(out.image, crop(&page, 0, 0, 64, 660));
    }

    #[test]
    fn manual_overlap_loss_keeps_the_anchor_until_the_user_returns() {
        let page = page(64, 2000);
        let mut probe = Stitcher::new(view(&page, 0, 300, 0, 0));
        let lost = probe.push(view(&page, 600, 300, 0, 0));
        assert!(
            matches!(lost, Step::Lost),
            "unexpected jump match: {lost:?}"
        );
        let control = ScrollControl::new(ScrollMode::Manual);
        let mut positions = [0, 600, 0, 120, 240].into_iter();
        let out = capture_frames(
            &mut || {
                Ok(Some(view(
                    &page,
                    positions.next().expect("capture should finish"),
                    300,
                    0,
                    0,
                )))
            },
            &mut |_| panic!("unexpected OS input"),
            &mut |_| {},
            &mut |frames| {
                if frames == 3 {
                    control.request_stop(false);
                }
            },
            MAX_FRAMES,
            &control,
        )
        .unwrap();
        assert_eq!(out.image, crop(&page, 0, 0, 64, 540));
        assert!(!control.needs_overlap.load(Ordering::SeqCst));
    }

    #[test]
    fn cancellation_during_a_manual_pause_discards_the_capture() {
        let control = ScrollControl::new(ScrollMode::Manual);
        let result = capture_frames(
            &mut || Ok(Some(page(64, 300))),
            &mut |_| panic!("unexpected OS input"),
            &mut |_| control.request_stop(true),
            &mut |_| {},
            MAX_FRAMES,
            &control,
        );
        assert!(result.is_err());
    }

    /// A tall "page" of independently hashed 20px bands with a diagonal
    /// texture, so duplicated or missing rows are detectable.
    fn page(width: u32, height: u32) -> RgbaImage {
        RgbaImage::from_fn(width, height, |x, y| {
            // Mix all bits before reducing to a shade; reducing a linear
            // sequence directly can produce near-periodic stripe matches.
            let mut band = y / 20;
            band = (band ^ (band >> 16)).wrapping_mul(0x7feb352d);
            band = (band ^ (band >> 15)).wrapping_mul(0x846ca68b);
            band ^= band >> 16;
            let shade = (band % 200) as u8 + 20;
            // A diagonal texture keeps rows within a band distinguishable.
            let tex = ((x + y) % 7) as u8 * 3;
            image::Rgba([shade, shade.wrapping_add(tex), 255 - shade, 255])
        })
    }

    fn view(page: &RgbaImage, scroll: u32, h: u32, header: u32, footer: u32) -> RgbaImage {
        let w = page.width();
        let mut out = crop(page, 0, scroll, w, h);
        for y in 0..header {
            for x in 0..w {
                out.put_pixel(x, y, image::Rgba([10, 10, 10, 255]));
            }
        }
        for y in (h - footer)..h {
            for x in 0..w {
                out.put_pixel(x, y, image::Rgba([240, 240, 240, 255]));
            }
        }
        out
    }

    #[test]
    fn stitches_scrolled_views_back_into_the_page() {
        let page = page(64, 1000);
        let mut stitcher = Stitcher::new(view(&page, 0, 300, 0, 0));
        for s in [120, 240, 360, 480, 600, 700] {
            assert!(matches!(
                stitcher.push(view(&page, s, 300, 0, 0)),
                Step::Appended
            ));
        }
        // Bottom reached: the same view again is "unchanged".
        assert!(matches!(
            stitcher.push(view(&page, 700, 300, 0, 0)),
            Step::Unchanged
        ));
        let out = stitcher.finish();
        assert_eq!(out.image.dimensions(), (64, 1000));
        assert_eq!(out.frames, 7);
        assert_eq!(out.image.as_raw(), page.as_raw());
    }

    #[test]
    fn sticky_header_and_footer_appear_once() {
        let page = page(64, 900);
        let (h, header, footer) = (300, 30, 20);
        let mut stitcher = Stitcher::new(view(&page, 0, h, header, footer));
        for s in [100, 200, 300] {
            assert!(matches!(
                stitcher.push(view(&page, s, h, header, footer)),
                Step::Appended
            ));
        }
        let out = stitcher.finish();
        // Header, page rows [header, 300 + h - footer), then the footer:
        // the same layout as one 600-row view of the page.
        let body_end = 300 + h;
        assert_eq!(out.image.height(), body_end);
        let expected = view(&page, 0, body_end, header, footer);
        // Body rows between header and footer match the page exactly.
        for y in header..(body_end - footer) {
            assert_eq!(
                out.image.get_pixel(5, y),
                expected.get_pixel(5, y),
                "row {y}"
            );
        }
        assert_eq!(out.image.get_pixel(0, 0).0, [10, 10, 10, 255]);
        assert_eq!(out.image.get_pixel(0, body_end - 1).0, [240, 240, 240, 255]);
    }

    #[test]
    fn unrelated_frames_do_not_stitch() {
        let a = RgbaImage::from_pixel(48, 120, image::Rgba([200, 30, 30, 255]));
        let b = RgbaImage::from_fn(48, 120, |_, y| image::Rgba([30, (y * 2) as u8, 30, 255]));
        let mut stitcher = Stitcher::new(a);
        assert!(matches!(stitcher.push(b), Step::Lost));
        assert_eq!(stitcher.finish().image.height(), 120);
    }

    #[test]
    fn narrow_regions_do_not_dilute_mismatched_pixels() {
        let a = RgbaImage::from_pixel(8, 120, image::Rgba([20, 20, 20, 255]));
        let b = RgbaImage::from_pixel(8, 120, image::Rgba([30, 30, 30, 255]));
        let mut stitcher = Stitcher::new(a);
        assert!(matches!(stitcher.push(b), Step::Lost));
        assert_eq!(stitcher.finish().image.height(), 120);
    }

    #[test]
    fn identical_frames_are_unchanged() {
        let page = page(48, 400);
        let mut stitcher = Stitcher::new(view(&page, 50, 200, 0, 0));
        assert!(matches!(
            stitcher.push(view(&page, 50, 200, 0, 0)),
            Step::Unchanged
        ));
    }

    #[test]
    fn scrolling_past_the_region_is_lost() {
        let page = page(48, 2000);
        let mut stitcher = Stitcher::new(view(&page, 0, 200, 0, 0));
        assert!(matches!(
            stitcher.push(view(&page, 600, 200, 0, 0)),
            Step::Lost
        ));
    }

    #[test]
    fn flat_regions_prefer_the_largest_overlap() {
        // Bottom 80 rows of `a` and top 80 rows of `b` are the same flat
        // color; the true shift is 40 rows (overlap 160 of 200).
        let mut page = page(48, 400);
        for y in 100..260 {
            for x in 0..48 {
                page.put_pixel(x, y, image::Rgba([90, 90, 90, 255]));
            }
        }
        let mut stitcher = Stitcher::new(view(&page, 60, 200, 0, 0));
        assert!(matches!(
            stitcher.push(view(&page, 100, 200, 0, 0)),
            Step::Appended
        ));
        let out = stitcher.finish();
        assert_eq!(out.image.height(), 240);
        assert_eq!(out.image.as_raw(), crop(&page, 0, 60, 48, 240).as_raw());
    }
}
