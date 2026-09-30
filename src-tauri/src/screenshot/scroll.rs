//! Scrolling ("long") screenshot: capture a region, synthesize wheel scrolls
//! at its center with `enigo`, capture again, and stitch frames by vertical
//! overlap detection.
//!
//! The overlay window hides itself before this runs (it would otherwise be
//! captured), then reopens on the stitched image for annotation.

use std::time::Duration;

use anyhow::Context;
use enigo::{Axis, Coordinate, Enigo, Mouse, Settings};
use image::{GenericImageView, GrayImage, RgbaImage};
use serde::Serialize;

use super::capture::{capture_region_image, temp_artifact_path};

/// Upper bound for one stitched image (pixels). Feishu-style long screenshots
/// rarely need more; this caps memory at ~4 bytes * width * height.
const MAX_STITCHED_HEIGHT: u32 = 12_000;
const MAX_FRAMES: u32 = 16;
/// Wheel notches per step. Small enough that consecutive frames overlap a lot.
const SCROLL_NOTCHES: i32 = 4;
const SETTLE_DELAY: Duration = Duration::from_millis(450);
/// Minimum overlap (px) required before two frames are considered stitchable.
const MIN_OVERLAP: u32 = 24;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrollCaptureResult {
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub frames: u32,
}

/// Run a scrolling capture over `width`x`height` at display-relative `(x, y)`.
///
/// `display_origin` is the target display's virtual-desktop origin; enigo
/// needs absolute coordinates. Blocking: call from `spawn_blocking`
/// (`Enigo` is not `Send` on macOS).
pub fn scroll_capture(
    app: &tauri::AppHandle,
    display_id: Option<&str>,
    display_origin: (i32, i32),
    x: u32,
    y: u32,
    width: u32,
    height: u32,
) -> anyhow::Result<ScrollCaptureResult> {
    if width == 0 || height == 0 {
        anyhow::bail!("scroll capture region must not be empty");
    }
    let mut enigo = Enigo::new(&Settings::default()).context("init input synthesis")?;
    let center_x = display_origin.0 + x as i32 + width as i32 / 2;
    let center_y = display_origin.1 + y as i32 + height as i32 / 2;
    enigo
        .move_mouse(center_x, center_y, Coordinate::Abs)
        .map_err(|e| anyhow::anyhow!("move mouse: {e}"))?;

    let mut stitched: Option<RgbaImage> = None;
    let mut frames = 0u32;
    let mut still_frames = 0u32;

    for _ in 0..MAX_FRAMES {
        let frame = capture_region_image(app, display_id, x, y, width, height)
            .context("capture scroll frame")?;
        frames += 1;

        let grown = match stitched.take() {
            None => frame,
            Some(prev) => match stitch_below(&prev, &frame) {
                Some(next) => {
                    still_frames = 0;
                    next
                }
                None => {
                    // No new content: the page stopped moving.
                    still_frames += 1;
                    if still_frames >= 2 {
                        stitched = Some(prev);
                        break;
                    }
                    // One more scroll attempt before giving up.
                    prev
                }
            },
        };
        if grown.height() >= MAX_STITCHED_HEIGHT {
            stitched = Some(grown);
            break;
        }
        stitched = Some(grown);

        enigo
            .scroll(SCROLL_NOTCHES, Axis::Vertical)
            .map_err(|e| anyhow::anyhow!("synthesize scroll: {e}"))?;
        std::thread::sleep(SETTLE_DELAY);
    }

    let stitched = stitched.context("no frames captured")?;
    let (w, h) = stitched.dimensions();
    let path = temp_artifact_path("scroll", "png")?;
    stitched
        .save(&path)
        .context("save stitched screenshot")?;
    Ok(ScrollCaptureResult {
        path: path.to_string_lossy().into_owned(),
        width: w,
        height: h,
        frames,
    })
}

/// Append `next` below `prev`, removing the overlapping strip. Returns `None`
/// when `next` adds no new rows (the view did not move).
fn stitch_below(prev: &RgbaImage, next: &RgbaImage) -> Option<RgbaImage> {
    let (pw, ph) = prev.dimensions();
    let (nw, nh) = next.dimensions();
    if pw != nw || nh == 0 {
        return None;
    }
    let overlap = find_vertical_overlap(prev, next)?;
    if overlap >= nh {
        return None; // fully overlapping: nothing new
    }
    let new_rows = nh - overlap;
    let mut out = RgbaImage::new(pw, ph + new_rows);
    image::imageops::replace(&mut out, prev, 0, 0);
    let strip = next.view(0, overlap, nw, new_rows).to_image();
    image::imageops::replace(&mut out, &strip, 0, ph as i64);
    Some(out)
}

/// Find how many bottom rows of `prev` match the top rows of `next`.
///
/// Both frames are downscaled to 96 px wide and grayscaled; the candidate
/// overlap with the lowest mean-absolute-difference wins, provided it is both
/// below an absolute threshold and clearly better than a zero-overlap
/// baseline. Returns `None` when nothing matches.
fn find_vertical_overlap(prev: &RgbaImage, next: &RgbaImage) -> Option<u32> {
    let (w, ph) = prev.dimensions();
    let (nw, nh) = next.dimensions();
    if w != nw || ph == 0 || nh == 0 {
        return None;
    }
    let scale_w = 96u32;
    let prev_small = downscale_gray(prev, scale_w);
    let next_small = downscale_gray(next, scale_w);
    let (_, sph) = prev_small.dimensions();
    let (_, snh) = next_small.dimensions();
    if sph == 0 || snh == 0 {
        return None;
    }
    // Work in downscaled rows, then scale the answer back up.
    let row_scale = ph as f64 / sph as f64;
    let max_overlap = snh.min(sph);
    let min_overlap = ((MIN_OVERLAP as f64 / row_scale).ceil() as u32).max(4).min(max_overlap);
    if min_overlap >= max_overlap {
        return None;
    }

    let baseline = sad_between(&prev_small, 0, &next_small, 0, snh.min(32));
    let mut best: Option<(u32, f64)> = None;
    for overlap in min_overlap..=max_overlap {
        let prev_y = sph - overlap;
        let sad = sad_between(&prev_small, prev_y, &next_small, 0, overlap);
        let mean = sad / overlap as f64;
        if best.is_none_or(|(_, b)| mean < b) {
            best = Some((overlap, mean));
        }
    }
    let (best_overlap, best_mean) = best?;
    // Absolute bar: average per-pixel diff must look like the same content.
    // Relative bar: must beat "no overlap" to avoid matching on flat areas.
    if best_mean < 14.0 && best_mean < baseline * 0.75 {
        Some(((best_overlap as f64 * row_scale).round() as u32).min(nh))
    } else {
        None
    }
}

/// Sum of absolute differences between two same-size strips.
fn sad_between(a: &GrayImage, a_y: u32, b: &GrayImage, b_y: u32, rows: u32) -> f64 {
    let (w, _) = a.dimensions();
    let mut sad = 0u64;
    for row in 0..rows {
        for x in 0..w {
            let pa = a.get_pixel(x, a_y + row)[0] as i32;
            let pb = b.get_pixel(x, b_y + row)[0] as i32;
            sad += (pa - pb).unsigned_abs() as u64;
        }
    }
    sad as f64 / (w as f64 * rows as f64).max(1.0)
}

fn downscale_gray(image: &RgbaImage, target_w: u32) -> GrayImage {
    let (w, h) = image.dimensions();
    let gray = to_luma(image);
    if w <= target_w {
        return gray;
    }
    let target_h = ((h as f64 * target_w as f64 / w as f64).round() as u32).max(1);
    image::imageops::resize(&gray, target_w, target_h, image::imageops::FilterType::Triangle)
}

/// Rec. 601 luma in integer math.
fn to_luma(image: &RgbaImage) -> GrayImage {
    let (w, h) = image.dimensions();
    let mut out = GrayImage::new(w, h);
    for (x, y, px) in image.enumerate_pixels() {
        let l = (px[0] as u32 * 299 + px[1] as u32 * 587 + px[2] as u32 * 114) / 1000;
        out.put_pixel(x, y, image::Luma([l.min(255) as u8]));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Solid stripe pattern: `value` rows of `color_a`, then `color_b`.
    fn striped(width: u32, rows_a: u32, rows_b: u32, color_a: [u8; 4], color_b: [u8; 4]) -> RgbaImage {
        let mut img = RgbaImage::new(width, rows_a + rows_b);
        for y in 0..rows_a {
            for x in 0..width {
                img.put_pixel(x, y, image::Rgba(color_a));
            }
        }
        for y in 0..rows_b {
            for x in 0..width {
                img.put_pixel(x, rows_a + y, image::Rgba(color_b));
            }
        }
        img
    }

    #[test]
    fn overlap_detected_on_shifted_frames() {
        // prev: 60 rows of red then 40 of blue; next: 40 of blue then 60 of green.
        // Scrolling down by 60 rows: the 40 blue rows overlap.
        let prev = striped(48, 60, 40, [200, 30, 30, 255], [30, 30, 200, 255]);
        let next = striped(48, 40, 60, [30, 30, 200, 255], [30, 200, 30, 255]);
        let overlap = find_vertical_overlap(&prev, &next).expect("overlap expected");
        assert!(
            (36..=44).contains(&overlap),
            "expected ~40px overlap, got {overlap}"
        );
    }

    #[test]
    fn no_overlap_on_unrelated_frames() {
        let prev = striped(48, 100, 0, [200, 30, 30, 255], [200, 30, 30, 255]);
        let next = striped(48, 100, 0, [30, 200, 30, 255], [30, 200, 30, 255]);
        assert!(find_vertical_overlap(&prev, &next).is_none());
    }

    #[test]
    fn stitch_appends_new_rows_only() {
        let prev = striped(32, 60, 40, [200, 30, 30, 255], [30, 30, 200, 255]);
        let next = striped(32, 40, 60, [30, 30, 200, 255], [30, 200, 30, 255]);
        let stitched = stitch_below(&prev, &next).expect("stitched");
        let (w, h) = stitched.dimensions();
        assert_eq!((w, h), (32, 160));
        // First row stays red, last row is green.
        assert_eq!(stitched.get_pixel(0, 0)[0], 200);
        assert_eq!(stitched.get_pixel(0, h - 1)[1], 200);
    }

    #[test]
    fn stitch_rejects_fully_overlapping_frame() {
        let prev = striped(32, 100, 0, [200, 30, 30, 255], [200, 30, 30, 255]);
        let next = striped(32, 100, 0, [200, 30, 30, 255], [200, 30, 30, 255]);
        assert!(stitch_below(&prev, &next).is_none());
    }
}
