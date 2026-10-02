//! Pixel-content oracles for real native screenshot QA outputs.
//!
//! Expected images are originals retained by the fixture's actual drawing
//! calls, not generated from captured/encoded pixels. Each observation must
//! match its original, including the per-run nonce and frame id, at multiple
//! spatial tiles; frame count or changing hashes alone never establishes this.

use image::{Rgba, RgbaImage};
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PixelMatch {
    pub same_size: bool,
    pub mean_error: f64,
    pub bad_pixel_fraction: f64,
    pub bad_tiles: u32,
    pub worst_tile_error: f64,
    pub passed: bool,
}

/// Lossless screen/PNG tolerates only sparse rounding/compositor differences;
/// GIF/H264 may quantize edges but every spatial tile still needs to match.
pub fn compare(actual: &RgbaImage, expected: &RgbaImage, lossy: bool) -> PixelMatch {
    if actual.dimensions() != expected.dimensions() || actual.width() == 0 || actual.height() == 0 {
        return PixelMatch {
            same_size: false,
            mean_error: 255.0,
            bad_pixel_fraction: 1.0,
            bad_tiles: 1,
            worst_tile_error: 255.0,
            passed: false,
        };
    }
    let tile = 24u32;
    let tiles_x = actual.width().div_ceil(tile);
    let tiles_y = actual.height().div_ceil(tile);
    let mut sums = vec![0u64; (tiles_x * tiles_y) as usize];
    let mut counts = vec![0u64; sums.len()];
    let mut total = 0u64;
    let mut bad = 0u64;
    let pixel_limit = if lossy { 40 } else { 12 };
    for (x, y, pixel) in actual.enumerate_pixels() {
        let expected = expected.get_pixel(x, y);
        let error = (0..3)
            .map(|c| u32::from(pixel[c].abs_diff(expected[c])))
            .sum::<u32>();
        total += u64::from(error);
        if error > pixel_limit * 3 {
            bad += 1;
        }
        let index = ((y / tile) * tiles_x + x / tile) as usize;
        sums[index] += u64::from(error);
        counts[index] += 3;
    }
    let pixels = u64::from(actual.width()) * u64::from(actual.height());
    let mean_error = total as f64 / (pixels * 3) as f64;
    let bad_pixel_fraction = bad as f64 / pixels as f64;
    let tile_limit = if lossy { 20.0 } else { 5.0 };
    let tile_errors: Vec<f64> = sums
        .iter()
        .zip(&counts)
        .map(|(sum, count)| *sum as f64 / (*count).max(1) as f64)
        .collect();
    let bad_tiles = tile_errors
        .iter()
        .filter(|error| **error > tile_limit)
        .count() as u32;
    let worst_tile_error = tile_errors.iter().copied().fold(0.0, f64::max);
    let passed = mean_error <= if lossy { 8.0 } else { 2.0 }
        && bad_pixel_fraction <= if lossy { 0.02 } else { 0.01 }
        && bad_tiles == 0;
    PixelMatch {
        same_size: true,
        mean_error,
        bad_pixel_fraction,
        bad_tiles,
        worst_tile_error,
        passed,
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaskMatch {
    pub pixels: PixelMatch,
    pub opaque_pixels: u64,
    pub transparent_pixels: u64,
    pub alpha_mismatches: u64,
    pub passed: bool,
}

fn inside_polygon(x: f64, y: f64, polygon: &[(f64, f64)]) -> bool {
    let mut inside = false;
    for i in 0..polygon.len() {
        let (ax, ay) = polygon[i];
        let (bx, by) = polygon[(i + 1) % polygon.len()];
        if (ay > y) != (by > y) && x < ax + (y - ay) * (bx - ax) / (by - ay) {
            inside = !inside;
        }
    }
    inside
}

fn edge_distance(x: f64, y: f64, polygon: &[(f64, f64)]) -> f64 {
    (0..polygon.len())
        .map(|i| {
            let (ax, ay) = polygon[i];
            let (bx, by) = polygon[(i + 1) % polygon.len()];
            let length = (bx - ax).powi(2) + (by - ay).powi(2);
            let t = if length > 0.0 {
                ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / length
            } else {
                0.0
            }
            .clamp(0.0, 1.0);
            (x - ax - t * (bx - ax)).hypot(y - ay - t * (by - ay))
        })
        .fold(f64::INFINITY, f64::min)
}

/// Independent pixel-center mask; do not use the renderer's exported contour or pixels.
pub fn masked_original(original: &RgbaImage, polygon: &[(f64, f64)]) -> RgbaImage {
    RgbaImage::from_fn(original.width(), original.height(), |x, y| {
        if inside_polygon(x as f64 + 0.5, y as f64 + 0.5, polygon) {
            *original.get_pixel(x, y)
        } else {
            Rgba([0, 0, 0, 0])
        }
    })
}

pub fn compare_masked(
    actual: &RgbaImage,
    expected: &RgbaImage,
    polygon: &[(f64, f64)],
) -> MaskMatch {
    let mut comparable = actual.clone();
    let mut opaque = 0;
    let mut transparent = 0;
    let mut mismatches = 0;
    if actual.dimensions() == expected.dimensions() {
        for (x, y, pixel) in actual.enumerate_pixels() {
            let reference = expected.get_pixel(x, y);
            // Canvas coverage at contour edges can differ by at most two pixels;
            // all other interior/exterior alpha values must be exact.
            let boundary = edge_distance(x as f64 + 0.5, y as f64 + 0.5, polygon) <= 2.0;
            if !boundary {
                if reference[3] == 0 {
                    transparent += 1;
                } else {
                    opaque += 1;
                }
                if pixel[3] != reference[3] {
                    mismatches += 1;
                }
            }
            if reference[3] == 0 || boundary {
                comparable.put_pixel(x, y, *reference);
            }
        }
    }
    let pixels = compare(&comparable, expected, false);
    let passed = pixels.passed && opaque > 100 && transparent > 100 && mismatches == 0;
    MaskMatch {
        pixels,
        opaque_pixels: opaque,
        transparent_pixels: transparent,
        alpha_mismatches: mismatches,
        passed,
    }
}

#[derive(Default)]
pub struct Timeline {
    first: Option<(u64, f64)>,
    last: Option<(u64, f64)>,
    last_visible_until_ms: f64,
    pub invalid: u32,
    pub worst_drift_ms: f64,
    pub longest_gap_ms: u64,
    pub longest_unexplained_gap_ms: u64,
}

impl Timeline {
    pub fn observe(&mut self, clip_ms: u64, original_ms: f64, visible_until_ms: f64) -> bool {
        let (first_clip, first_original) = *self.first.get_or_insert((clip_ms, original_ms));
        // A drawn image is the original screen state until the next actual
        // draw, not just at its initial timestamp. A paused fixture must not
        // misclassify a correctly sampled held frame as delayed playback.
        let source_ms = first_original + clip_ms.saturating_sub(first_clip) as f64;
        let drift = (original_ms - source_ms)
            .max(source_ms - visible_until_ms)
            .max(0.0);
        self.worst_drift_ms = self.worst_drift_ms.max(drift);
        let ordered = original_ms.is_finite()
            && visible_until_ms.is_finite()
            && visible_until_ms >= original_ms
            && self.last.is_none_or(|(last_clip, last_original)| {
                clip_ms >= last_clip && original_ms >= last_original
            });
        if let Some((last_clip, _)) = self.last {
            let gap = clip_ms.saturating_sub(last_clip);
            self.longest_gap_ms = self.longest_gap_ms.max(gap);
            let last_source_ms = first_original + last_clip.saturating_sub(first_clip) as f64;
            let held_ms = (self.last_visible_until_ms.min(source_ms) - last_source_ms).max(0.0);
            // A long held original is not a dropped moving scene. Count only
            // time after that original actually stopped being visible.
            let unexplained = (gap as f64 - held_ms).max(0.0).ceil() as u64;
            self.longest_unexplained_gap_ms = self.longest_unexplained_gap_ms.max(unexplained);
        }
        let valid = ordered && drift <= 250.0;
        if !valid {
            self.invalid += 1;
        }
        self.last = Some((clip_ms, original_ms));
        self.last_visible_until_ms = visible_until_ms;
        valid
    }

    pub fn complete(&self, duration_ms: u64) -> bool {
        let Some((_, last_original)) = self.last else {
            return false;
        };
        let Some((_, first_original)) = self.first else {
            return false;
        };
        let (first_clip, _) = self.first.unwrap();
        let end_source_ms = first_original + duration_ms.saturating_sub(first_clip) as f64;
        let tail_gap = (end_source_ms - self.last_visible_until_ms).max(0.0);
        self.invalid == 0
            && self.longest_unexplained_gap_ms <= 700
            && tail_gap <= 700.0
            && last_original - first_original >= duration_ms as f64 * 0.7
    }
}

pub fn difference(actual: &RgbaImage, expected: &RgbaImage) -> RgbaImage {
    RgbaImage::from_fn(actual.width(), actual.height(), |x, y| {
        let a = actual.get_pixel(x, y);
        let b = expected.get_pixel(
            x.min(expected.width().saturating_sub(1)),
            y.min(expected.height().saturating_sub(1)),
        );
        Rgba([
            a[0].abs_diff(b[0]).saturating_mul(4),
            a[1].abs_diff(b[1]).saturating_mul(4),
            a[2].abs_diff(b[2]).saturating_mul(4),
            255,
        ])
    })
}

/// Show both RGB and alpha errors; transparent RGB is irrelevant to the mask.
pub fn mask_difference(actual: &RgbaImage, expected: &RgbaImage) -> RgbaImage {
    let mut diff = difference(actual, expected);
    for (x, y, pixel) in diff.enumerate_pixels_mut() {
        let a = actual.get_pixel(x, y);
        let b = expected.get_pixel(x.min(expected.width() - 1), y.min(expected.height() - 1));
        let alpha = a[3].abs_diff(b[3]).saturating_mul(4);
        if b[3] == 0 {
            *pixel = Rgba([alpha, 0, alpha, 255]);
        } else {
            pixel[0] = pixel[0].max(alpha);
            pixel[2] = pixel[2].max(alpha);
        }
    }
    diff
}

/// Decode complementary black/white fiducials, not color/motion heuristics.
/// Coordinates refer to the visible fixture in CSS pixels (before the 6px
/// crop). A wrong region, stale clip or damaged marker cannot yield a code.
pub fn decode_code(image: &RgbaImage, source_size: (f64, f64), bits: u32, y: f64) -> Option<u32> {
    let sx = image.width() as f64 / source_size.0;
    let sy = image.height() as f64 / source_size.1;
    if !sx.is_finite() || !sy.is_finite() || sx <= 0.0 || sy <= 0.0 {
        return None;
    }
    let brightness = |x: f64, y: f64| -> Option<f64> {
        let (cx, cy) = ((x * sx).round() as i32, (y * sy).round() as i32);
        let mut total = 0u32;
        let mut count = 0u32;
        for dy in -1..=1 {
            for dx in -1..=1 {
                let (px, py) = (cx + dx, cy + dy);
                if px < 0 || py < 0 || px >= image.width() as i32 || py >= image.height() as i32 {
                    return None;
                }
                let pixel = image.get_pixel(px as u32, py as u32);
                total += u32::from(pixel[0]) + u32::from(pixel[1]) + u32::from(pixel[2]);
                count += 3;
            }
        }
        Some(total as f64 / count as f64)
    };
    let mut code = 0u32;
    for bit in 0..bits {
        let x = 20.0 + bit as f64 * 12.0 + 5.0 - 6.0;
        let top = brightness(x, y + 5.0 - 6.0)?;
        let bottom = brightness(x, y + 19.0 - 6.0)?;
        if top >= 180.0 && bottom <= 70.0 {
            code |= 1 << bit;
        } else if top > 70.0 || bottom < 180.0 {
            return None;
        }
    }
    Some(code)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn original() -> RgbaImage {
        RgbaImage::from_fn(144, 192, |x, y| {
            Rgba([(x * 7 + y * 3) as u8, (y * 11) as u8, (x + y) as u8, 255])
        })
    }

    #[test]
    fn identical_original_passes_but_black_wrong_region_and_local_missing_content_fail() {
        let reference = original();
        assert!(compare(&reference, &reference, false).passed);
        assert!(!compare(&RgbaImage::new(144, 192), &reference, true).passed);
        let shifted = RgbaImage::from_fn(144, 192, |x, y| *reference.get_pixel((x + 8) % 144, y));
        assert!(!compare(&shifted, &reference, true).passed);
        let mut blank_tile = reference.clone();
        for y in 96..120 {
            for x in 48..72 {
                blank_tile.put_pixel(x, y, Rgba([0, 0, 0, 255]));
            }
        }
        let result = compare(&blank_tile, &reference, true);
        assert!(result.bad_tiles > 0 && !result.passed);
    }

    #[test]
    fn duplicated_missing_reordered_and_stretched_scroll_rows_fail_content_match() {
        let reference = original();
        for kind in 0..4 {
            let corrupt = RgbaImage::from_fn(144, 192, |x, y| {
                let source_y = match kind {
                    0 if (48..96).contains(&y) => y - 48,
                    1 if y >= 48 => (y + 48).min(191),
                    2 if (48..96).contains(&y) => y + 48,
                    2 if (96..144).contains(&y) => y - 48,
                    3 => (y * 3 / 4).min(191),
                    _ => y,
                };
                *reference.get_pixel(x, source_y)
            });
            assert!(
                !compare(&corrupt, &reference, false).passed,
                "corruption {kind}"
            );
        }
    }

    #[test]
    fn freehand_mask_requires_original_interior_and_exact_exterior_alpha() {
        let original = original();
        let polygon = [
            (0.0, 0.0),
            (144.0, 0.0),
            (144.0, 60.0),
            (60.0, 60.0),
            (60.0, 192.0),
            (0.0, 192.0),
        ];
        let expected = masked_original(&original, &polygon);
        assert!(compare_masked(&expected, &expected, &polygon).passed);
        assert!(!compare_masked(&original, &expected, &polygon).passed);
        assert!(!compare_masked(&RgbaImage::new(144, 192), &expected, &polygon).passed);
        let mut corrupt = expected.clone();
        corrupt.put_pixel(120, 150, Rgba([0, 0, 0, 1]));
        assert_eq!(
            compare_masked(&corrupt, &expected, &polygon).alpha_mismatches,
            1
        );
        let black = RgbaImage::from_fn(144, 192, |x, y| {
            Rgba([0, 0, 0, expected.get_pixel(x, y)[3]])
        });
        assert!(!compare_masked(&black, &expected, &polygon).passed);
    }

    #[test]
    fn lossy_quantization_is_tolerated_but_color_swap_is_not() {
        let reference = original();
        let quantized = RgbaImage::from_fn(144, 192, |x, y| {
            let p = reference.get_pixel(x, y);
            Rgba([p[0] / 4 * 4, p[1] / 4 * 4, p[2] / 4 * 4, 255])
        });
        assert!(compare(&quantized, &reference, true).passed);
        let swapped = RgbaImage::from_fn(144, 192, |x, y| {
            let p = reference.get_pixel(x, y);
            Rgba([p[2], p[1], p[0], 255])
        });
        assert!(!compare(&swapped, &reference, true).passed);
    }

    #[test]
    fn timeline_rejects_static_reversed_sped_up_and_stalled_animation() {
        let mut valid = Timeline::default();
        for i in 0..30 {
            assert!(valid.observe(
                i * 100,
                1000.0 + i as f64 * 100.0,
                1100.0 + i as f64 * 100.0
            ));
        }
        assert!(valid.complete(3000));
        let mut repeated = Timeline::default();
        for i in 0..30 {
            repeated.observe(i * 100, 1000.0, 1100.0);
        }
        assert!(!repeated.complete(3000));
        let mut reverse = Timeline::default();
        for i in 0..30 {
            reverse.observe(
                i * 100,
                4000.0 - i as f64 * 100.0,
                4100.0 - i as f64 * 100.0,
            );
        }
        assert!(!reverse.complete(3000));
        let mut fast = Timeline::default();
        for i in 0..30 {
            fast.observe(
                i * 100,
                1000.0 + i as f64 * 200.0,
                1100.0 + i as f64 * 200.0,
            );
        }
        assert!(!fast.complete(3000));
        let mut stalled = Timeline::default();
        stalled.observe(0, 1000.0, 1100.0);
        stalled.observe(900, 1900.0, 2000.0);
        stalled.observe(1500, 2500.0, 2600.0);
        assert!(!stalled.complete(3000));
    }

    #[test]
    fn held_original_matches_its_real_visibility_interval_but_stale_frame_does_not() {
        let mut held = Timeline::default();
        assert!(held.observe(0, 1000.0, 1100.0));
        assert!(held.observe(100, 1100.0, 1700.0));
        assert!(held.observe(600, 1100.0, 1700.0));
        assert!(held.observe(700, 1700.0, 1800.0));
        assert!(held.observe(900, 1900.0, 2000.0));
        assert!(held.complete(1000));
        let mut stale = Timeline::default();
        assert!(stale.observe(0, 1000.0, 1050.0));
        assert!(!stale.observe(800, 1400.0, 1450.0));
        assert!(!stale.complete(1000));
        let mut long_hold = Timeline::default();
        assert!(long_hold.observe(0, 1000.0, 1050.0));
        assert!(long_hold.observe(100, 1100.0, 1950.0));
        assert!(long_hold.observe(900, 1100.0, 1950.0));
        assert!(long_hold.observe(1000, 2000.0, 2100.0));
        assert!(long_hold.observe(1100, 2100.0, 2200.0));
        assert!(long_hold.complete(1200));
        assert_eq!(long_hold.longest_gap_ms, 800);
        assert!(long_hold.longest_unexplained_gap_ms < 700);
        let mut dropped_motion = Timeline::default();
        assert!(dropped_motion.observe(0, 1000.0, 1050.0));
        assert!(dropped_motion.observe(900, 1900.0, 1950.0));
        assert!(!dropped_motion.complete(1000));
        assert!(dropped_motion.longest_unexplained_gap_ms > 700);
    }

    #[test]
    fn complementary_code_requires_correct_pixels_and_rejects_black_frame() {
        let mut image = RgbaImage::from_pixel(508, 428, Rgba([80, 90, 100, 255]));
        let code = 0b10101010u32;
        for bit in 0..8 {
            for (offset, set) in [(0, code & (1 << bit) != 0), (14, code & (1 << bit) == 0)] {
                for y in (64 + offset - 6)..(74 + offset - 6) {
                    for x in (20 + bit * 12 - 6)..(30 + bit * 12 - 6) {
                        let v = if set { 244 } else { 8 };
                        image.put_pixel(x, y, Rgba([v, v, v, 255]));
                    }
                }
            }
        }
        assert_eq!(decode_code(&image, (508.0, 428.0), 8, 64.0), Some(code));
        assert_eq!(
            decode_code(&RgbaImage::new(508, 428), (508.0, 428.0), 8, 64.0),
            None
        );
    }
}
