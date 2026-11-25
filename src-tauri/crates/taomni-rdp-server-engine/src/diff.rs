//! Upstream change detection for the capture pipeline (dev plan phase 3).
//!
//! `ironrdp-server`'s encoder already diffs each *full frame* against its own
//! framebuffer and only encodes the changed rectangles (and negotiates RemoteFX
//! by default). So the value we add at the capture layer is **suppression**: if
//! a freshly captured frame is byte-identical to the previous one, we avoid
//! pushing it downstream at all — no channel hop, no encode, no diff — which is
//! what makes a static desktop cost ~zero. We also expose a cheap tile-based
//! "did anything change / which tiles changed" pre-scan for backends without
//! native dirty rectangles (X11/xcap), so future work can crop to changed
//! regions before the data ever leaves the capture thread.

/// Side length (px) of a change-detection tile. 64 matches the encoder's own
/// internal tiling granularity (`ironrdp_graphics::diff` uses 64).
pub(crate) const TILE: usize = 64;

/// A lightweight per-frame fingerprint used to suppress identical frames.
///
/// FNV-1a over the pixel bytes: fast, allocation-free, and good enough to decide
/// "unchanged vs changed" between consecutive captures. Collisions would at
/// worst drop one real update; in practice the desktop changes far more than one
/// frame at a time, so a missed single frame is invisible.
pub(crate) fn frame_hash(data: &[u8]) -> u64 {
    const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    let mut h = OFFSET;
    for &b in data {
        h ^= u64::from(b);
        h = h.wrapping_mul(PRIME);
    }
    h
}

/// Pixel rectangle (top-left origin), in screen pixels.
//
// Region-cropping (sending only changed tiles instead of full frames) is a
// planned capture-side optimization for backends without native dirty rects;
// the detection is implemented and tested here, wiring it into the frame path
// is future work, hence `dead_code` for now.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TileRect {
    pub x: usize,
    pub y: usize,
    pub width: usize,
    pub height: usize,
}

/// Compare two BGRA frames of identical geometry tile-by-tile and return the
/// bounding rectangles of changed `TILE`×`TILE` blocks.
///
/// `prev`/`curr` are tightly-or-loosely packed at `stride` bytes per row; only
/// the first `width*4` bytes of each row are compared. Returns an empty vec when
/// the frames are identical. Geometry mismatch (e.g. a resize) returns a single
/// full-frame rect so the caller treats everything as dirty.
#[allow(dead_code)] // detection implemented + tested; region cropping is future work
pub(crate) fn changed_tiles(
    prev: &[u8],
    curr: &[u8],
    width: usize,
    height: usize,
    stride: usize,
) -> Vec<TileRect> {
    let row_bytes = width.saturating_mul(4);
    let need = height.saturating_mul(stride);
    if prev.len() < need || curr.len() < need || width == 0 || height == 0 {
        return vec![TileRect {
            x: 0,
            y: 0,
            width,
            height,
        }];
    }

    let mut out = Vec::new();
    let mut ty = 0;
    while ty < height {
        let th = TILE.min(height - ty);
        let mut tx = 0;
        while tx < width {
            let tw = TILE.min(width - tx);
            if tile_differs(prev, curr, tx, ty, tw, th, stride, row_bytes) {
                out.push(TileRect {
                    x: tx,
                    y: ty,
                    width: tw,
                    height: th,
                });
            }
            tx += TILE;
        }
        ty += TILE;
    }
    out
}

#[allow(clippy::too_many_arguments)]
fn tile_differs(
    prev: &[u8],
    curr: &[u8],
    tx: usize,
    ty: usize,
    tw: usize,
    th: usize,
    stride: usize,
    row_bytes: usize,
) -> bool {
    let x0 = tx * 4;
    let x1 = (x0 + tw * 4).min(row_bytes);
    for row in ty..ty + th {
        let base = row * stride;
        let a = &prev[base + x0..base + x1];
        let b = &curr[base + x0..base + x1];
        if a != b {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(w: usize, h: usize, color: u8) -> Vec<u8> {
        vec![color; w * h * 4]
    }

    #[test]
    fn identical_frames_hash_equal_and_no_tiles() {
        let a = solid(128, 128, 7);
        let b = solid(128, 128, 7);
        assert_eq!(frame_hash(&a), frame_hash(&b));
        assert!(changed_tiles(&a, &b, 128, 128, 128 * 4).is_empty());
    }

    #[test]
    fn single_pixel_change_marks_one_tile() {
        let w = 128;
        let h = 128;
        let stride = w * 4;
        let a = solid(w, h, 0);
        let mut b = a.clone();
        // Flip a pixel inside the bottom-right tile (x=70, y=70).
        let idx = 70 * stride + 70 * 4;
        b[idx] = 255;
        let tiles = changed_tiles(&a, &b, w, h, stride);
        assert_eq!(tiles.len(), 1, "exactly one tile should differ");
        let t = tiles[0];
        assert_eq!((t.x, t.y), (TILE, TILE), "the second tile on each axis");
        assert_ne!(frame_hash(&a), frame_hash(&b));
    }

    #[test]
    fn changes_in_two_tiles_report_both() {
        let w = 200;
        let h = 64;
        let stride = w * 4;
        let a = solid(w, h, 0);
        let mut b = a.clone();
        b[10 * 4] = 1; // tile (0,0)
        b[150 * 4] = 1; // tile (128,0)
        let tiles = changed_tiles(&a, &b, w, h, stride);
        let xs: Vec<usize> = tiles.iter().map(|t| t.x).collect();
        assert!(xs.contains(&0) && xs.contains(&128), "got {:?}", tiles);
    }

    #[test]
    fn geometry_mismatch_is_fully_dirty() {
        let a = solid(64, 64, 0);
        let tiles = changed_tiles(&a, &[], 64, 64, 256);
        assert_eq!(tiles.len(), 1);
        assert_eq!(tiles[0].width, 64);
    }
}
