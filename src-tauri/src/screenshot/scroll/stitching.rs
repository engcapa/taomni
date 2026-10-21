use super::chrome::SideEvidence;
use super::chrome::extend_side_chrome;
use super::chrome::fixed_sides;
use super::chrome::side_chrome_splits;
use super::matching::Signature;
use super::matching::find_overlap;
use super::matching::static_margins;
use image::RgbaImage;

#[derive(Debug)]
pub(super) enum Step {
    /// New rows were appended.
    Appended,
    /// The view did not move.
    Unchanged,
    /// The view moved but no overlap was found (scrolled too far).
    Lost,
}

pub(super) struct Stitched {
    pub(super) image: RgbaImage,
    pub(super) frames: u32,
}

pub(super) struct Stitcher {
    pub(super) width: u32,
    pub(super) frame_h: u32,
    /// Static rows, fixed by the first frame pair that moved.
    pub(super) margins: Option<(usize, usize)>,
    /// Side chrome that does not follow the verified content displacement.
    pub(super) sides: Option<SideEvidence>,
    pub(super) side_splits: Vec<u32>,
    /// Rows accumulated so far: header + body rows (footer excluded once
    /// margins are known).
    pub(super) rows: Vec<u8>,
    pub(super) last: RgbaImage,
    pub(super) last_sig: Signature,
    pub(super) frames: u32,
}

impl Stitcher {
    pub(super) fn new(first: RgbaImage) -> Self {
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

    pub(super) fn height(&self) -> u32 {
        (self.rows.len() / (self.width as usize * 4)) as u32
    }

    pub(super) fn push(&mut self, frame: RgbaImage) -> Step {
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

    pub(super) fn finish(mut self) -> Stitched {
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
