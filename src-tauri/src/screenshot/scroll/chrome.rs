use image::RgbaImage;

/// Side chrome evidence from one verified frame pair, per edge (left, right):
/// `chrome` is the extent of columns that do not follow the content shift
/// (fixed icons, borders, scrollbar thumbs); `bound` is the first column that
/// does follow it, beyond which the side can never extend.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct SideEvidence {
    pub(super) chrome: (u32, u32),
    pub(super) bound: (u32, u32),
}

impl SideEvidence {
    pub(super) fn merge(self, other: Self) -> Self {
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

    pub(super) fn sides(self) -> (u32, u32) {
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
pub(super) fn fixed_sides(
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
pub(super) fn side_chrome_splits(
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
pub(super) fn extend_side_chrome(output: &mut RgbaImage, last: &RgbaImage, x: u32, width: u32) {
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
