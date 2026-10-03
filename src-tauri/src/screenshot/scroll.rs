//! Scrolling ("long") screenshot: capture a region, synthesize wheel scrolls
//! at its center, capture again, and stitch frames by vertical overlap.
//!
//! Stitching model. Each frame of the region is split into a static header
//! (rows identical across frames, e.g. a sticky toolbar), a scrolling body
//! and a static footer. The output is `frame0[0..h-footer]` followed by the
//! new body rows of every later frame, then the footer of the last frame.
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
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::capture::{DisplayInfo, FrameSource, crop, save_png};

/// Upper bound for one stitched image (pixels); caps memory at ~4*w*h bytes.
const MAX_STITCHED_HEIGHT: u32 = 20_000;
const MAX_FRAMES: u32 = 40;
/// Let the hidden overlay leave the screen before the first frame.
const INITIAL_SETTLE: Duration = Duration::from_millis(350);
/// Smooth-scroll animations in WebView2/WebKit finish well within this.
const SETTLE_DELAY: Duration = Duration::from_millis(450);
/// Consecutive unchanged frames that end the capture (page bottom).
const STILL_LIMIT: u32 = 2;
/// Columns sampled per row for matching (frames are column-averaged to this).
const MATCH_COLUMNS: usize = 128;
/// Mean absolute luma difference accepted as "same content".
const MATCH_THRESHOLD: f64 = 6.0;
/// Rows whose difference stays below this are static between frames.
const STATIC_THRESHOLD: f64 = 1.5;
/// Minimum overlap (rows) for a match to be trusted.
const MIN_OVERLAP: usize = 16;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrollCaptureResult {
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub frames: u32,
}

#[derive(Default)]
pub struct ScrollControl {
    pub stop: AtomicBool,
    pub cancel: AtomicBool,
    pub frames: AtomicU32,
}

impl ScrollControl {
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
        let _ = app.emit(
            "screenshot://scroll-progress",
            serde_json::json!({ "frames": frames }),
        );
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
    scroll_capture_controlled(app, display, region, max_frames, &ScrollControl::default())
}

pub fn scroll_capture_controlled(
    app: &AppHandle,
    display: &DisplayInfo,
    region: (u32, u32, u32, u32),
    max_frames: u32,
    control: &ScrollControl,
) -> anyhow::Result<ScrollCaptureResult> {
    let (x, y, width, height) = region;
    if width < 8 || height < (MIN_OVERLAP as u32) * 3 {
        anyhow::bail!("scroll capture region is too small ({width}x{height})");
    }
    let mut wheel = Wheel::new()?;
    wheel.move_to(display, x + width / 2, y + height / 2)?;
    control.settle(INITIAL_SETTLE);
    if control.cancel.load(Ordering::SeqCst) {
        anyhow::bail!("scroll capture cancelled");
    }

    let mut source = FrameSource::one_shot(app, display.clone());
    let mut grab = || -> anyhow::Result<RgbaImage> {
        let full = source.grab().context("capture scroll frame")?;
        Ok(crop(&full, x, y, width, height))
    };

    let first = grab()?;
    let mut stitcher = Stitcher::new(first);
    control.progress(app, stitcher.frames);
    // Notches per step: large regions scroll faster; a step that jumps past
    // the region is undone and retried with a single notch.
    let mut notches: i32 = if height >= 600 { 3 } else { 1 };
    let mut still = 0u32;

    while !control.stop.load(Ordering::SeqCst)
        && stitcher.frames < max_frames.min(MAX_FRAMES)
        && stitcher.height() < MAX_STITCHED_HEIGHT
    {
        wheel.scroll(notches)?;
        control.settle(SETTLE_DELAY);
        if control.stop.load(Ordering::SeqCst) {
            break;
        }
        let frame = grab()?;
        match stitcher.push(frame) {
            Step::Appended => {
                still = 0;
                control.progress(app, stitcher.frames);
            }
            Step::Unchanged => {
                still += 1;
                if still >= STILL_LIMIT {
                    break;
                }
            }
            Step::Lost => {
                if notches > 1 {
                    // Jumped further than the region: go back and slow down.
                    wheel.scroll(-notches)?;
                    control.settle(SETTLE_DELAY);
                    if control.stop.load(Ordering::SeqCst) {
                        break;
                    }
                    notches = 1;
                    let back = grab()?;
                    stitcher.rebase(back);
                } else {
                    break;
                }
            }
        }
    }

    if control.cancel.load(Ordering::SeqCst) {
        anyhow::bail!("scroll capture cancelled");
    }

    let stitched = stitcher.finish();
    let (path, w, h) = save_png(&stitched.image, "scroll")?;
    Ok(ScrollCaptureResult {
        path: path.to_string_lossy().into_owned(),
        width: w,
        height: h,
        frames: stitched.frames,
    })
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
            unsafe { windows::Win32::UI::WindowsAndMessaging::SetCursorPos(gx, gy) }
                .map_err(|e| anyhow::anyhow!("move pointer: {e}"))?;
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
        self.enigo
            .scroll(notches, Axis::Vertical)
            .map_err(|e| anyhow::anyhow!("synthesize scroll: {e}"))
    }
}

// ---------------------------------------------------------------------------
// Stitching
// ---------------------------------------------------------------------------

/// Column-averaged luma rows of a frame (`MATCH_COLUMNS` samples per row).
struct Signature {
    rows: Vec<[u8; MATCH_COLUMNS]>,
}

impl Signature {
    fn of(image: &RgbaImage) -> Self {
        let (w, h) = image.dimensions();
        let raw = image.as_raw();
        let mut rows = Vec::with_capacity(h as usize);
        let cols = MATCH_COLUMNS.min(w as usize).max(1);
        for y in 0..h as usize {
            let mut row = [0u8; MATCH_COLUMNS];
            for (c, slot) in row.iter_mut().enumerate().take(cols) {
                let x0 = c * w as usize / cols;
                let x1 = ((c + 1) * w as usize / cols).max(x0 + 1);
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
        Self { rows }
    }

    fn len(&self) -> usize {
        self.rows.len()
    }

    fn row_diff(&self, a: usize, other: &Signature, b: usize) -> u32 {
        self.rows[a]
            .iter()
            .zip(other.rows[b].iter())
            .map(|(p, q)| (*p as i32 - *q as i32).unsigned_abs())
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
) -> f64 {
    let mut sum = 0u64;
    let mut n = 0u64;
    let mut r = 0;
    while r < rows {
        sum += a.row_diff(a_y + r, b, b_y + r) as u64;
        n += 1;
        r += step;
    }
    sum as f64 / (n.max(1) * MATCH_COLUMNS as u64) as f64
}

/// Leading and trailing rows that did not change between two frames.
fn static_margins(a: &Signature, b: &Signature) -> (usize, usize) {
    let h = a.len().min(b.len());
    let limit = h / 3;
    let same = |y: usize| a.row_diff(y, b, y) as f64 / MATCH_COLUMNS as f64 <= STATIC_THRESHOLD;
    let top = (0..limit).take_while(|&y| same(y)).count();
    let bottom = (0..limit).take_while(|&k| same(h - 1 - k)).count();
    (top, bottom)
}

/// Rows of `next`'s body that repeat the bottom of `prev`'s body, searched
/// over bodies `[top, h - bottom)`. `None` when no shift matches.
fn find_overlap(prev: &Signature, next: &Signature, top: usize, bottom: usize) -> Option<usize> {
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
        band_mean(prev, top + body - overlap, next, top, overlap, step)
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
        let (top, bottom) = match self.margins {
            Some(m) => m,
            None => {
                let m = static_margins(&self.last_sig, &sig);
                if m.0 + m.1 >= self.frame_h as usize * 2 / 3 {
                    // Everything (or nearly) static: the page did not move.
                    return Step::Unchanged;
                }
                m
            }
        };
        let body = self.frame_h as usize - top - bottom;
        let Some(overlap) = find_overlap(&self.last_sig, &sig, top, bottom) else {
            return Step::Lost;
        };
        if overlap >= body {
            return Step::Unchanged;
        }
        if self.margins.is_none() {
            // First movement: drop the first frame's footer from the output;
            // the final footer is appended by `finish`.
            self.margins = Some((top, bottom));
            let keep = (self.frame_h as usize - bottom) * self.width as usize * 4;
            self.rows.truncate(keep);
        }
        let row_bytes = self.width as usize * 4;
        let start = (top + overlap) * row_bytes;
        let end = (top + body) * row_bytes;
        self.rows.extend_from_slice(&frame.as_raw()[start..end]);
        self.last = frame;
        self.last_sig = sig;
        self.frames += 1;
        Step::Appended
    }

    /// Replace the reference frame after scrolling back (no rows appended).
    fn rebase(&mut self, frame: RgbaImage) {
        if frame.dimensions() == (self.width, self.frame_h) {
            self.last_sig = Signature::of(&frame);
            self.last = frame;
        }
    }

    fn finish(mut self) -> Stitched {
        if let Some((_, bottom)) = self.margins {
            let row_bytes = self.width as usize * 4;
            let start = (self.frame_h as usize - bottom) * row_bytes;
            self.rows.extend_from_slice(&self.last.as_raw()[start..]);
        }
        let height = self.height();
        let image = RgbaImage::from_raw(self.width, height, self.rows)
            .expect("stitched rows are whole rows");
        Stitched {
            image,
            frames: self.frames,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A tall "page" of 20px bands whose colors never repeat, so any
    /// duplicated or missing rows are detectable.
    fn page(width: u32, height: u32) -> RgbaImage {
        RgbaImage::from_fn(width, height, |x, y| {
            // Hashed band shades: no shift of the page lines up with itself.
            let band = y / 20;
            let shade = ((band.wrapping_mul(2_654_435_761) >> 16) % 200) as u8 + 20;
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
