use super::limits::MATCH_COLUMNS;
use super::limits::MATCH_THRESHOLD;
use super::limits::MIN_OVERLAP;
use super::limits::STATIC_THRESHOLD;
use image::RgbaImage;

// ---------------------------------------------------------------------------
// Stitching
// ---------------------------------------------------------------------------

/// Column-averaged luma rows of a frame (`MATCH_COLUMNS` samples per row).
pub(super) struct Signature {
    pub(super) rows: Vec<[u8; MATCH_COLUMNS]>,
    pub(super) columns: usize,
}

impl Signature {
    pub(super) fn of(image: &RgbaImage) -> Self {
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

    pub(super) fn len(&self) -> usize {
        self.rows.len()
    }

    pub(super) fn moving_columns(&self, other: &Self) -> Vec<usize> {
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

    pub(super) fn row_diff(&self, a: usize, other: &Signature, b: usize, columns: &[usize]) -> u32 {
        columns
            .iter()
            // Bound a local thumbnail's contribution. Most of the overlap
            // still has to agree; widespread layout changes remain Lost.
            .map(|&c| self.rows[a][c].abs_diff(other.rows[b][c]).min(24) as u32)
            .sum()
    }
}

/// Mean absolute difference between `rows` rows of `a` (from `a_y`) and `b`
/// (from `b_y`), sampling every `step`-th row.
pub(super) fn band_mean(
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
pub(super) fn static_margins(a: &Signature, b: &Signature, columns: &[usize]) -> (usize, usize) {
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
pub(super) fn find_overlap(
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
