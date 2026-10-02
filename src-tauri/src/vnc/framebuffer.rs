use std::sync::{Arc, Mutex};

use crate::vnc::limits::DecodeLimits;

/// Bytes in front of every relay rectangle: x, y, w, h (u16 BE) + 4 reserved.
pub const RELAY_RECT_HEADER_LEN: usize = 12;

/// Above this many pending rectangles the damage collapses into its bounding
/// box, so one relay frame never fans out into thousands of WebSocket
/// messages (a 1680x1050 Hextile refresh used to produce 6,930 tiles).
const MAX_DAMAGE_RECTS: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FbRect {
    pub x: u16,
    pub y: u16,
    pub w: u16,
    pub h: u16,
}

impl FbRect {
    pub fn new(x: u16, y: u16, w: u16, h: u16) -> Self {
        Self { x, y, w, h }
    }

    fn right(&self) -> u32 {
        u32::from(self.x) + u32::from(self.w)
    }

    fn bottom(&self) -> u32 {
        u32::from(self.y) + u32::from(self.h)
    }

    fn area(&self) -> u64 {
        u64::from(self.w) * u64::from(self.h)
    }

    fn union(&self, other: &FbRect) -> FbRect {
        let x = self.x.min(other.x);
        let y = self.y.min(other.y);
        let right = self.right().max(other.right());
        let bottom = self.bottom().max(other.bottom());
        FbRect {
            x,
            y,
            w: (right - u32::from(x)) as u16,
            h: (bottom - u32::from(y)) as u16,
        }
    }

    fn contains(&self, other: &FbRect) -> bool {
        self.x <= other.x
            && self.y <= other.y
            && self.right() >= other.right()
            && self.bottom() >= other.bottom()
    }

    fn touches(&self, other: &FbRect) -> bool {
        u32::from(self.x) <= other.right()
            && u32::from(other.x) <= self.right()
            && u32::from(self.y) <= other.bottom()
            && u32::from(other.y) <= self.bottom()
    }
}

/// Pending screen damage between two relay frames. The frontend receives the
/// newest pixels of every damaged region, so no update is ever lost when the
/// WebView paints slower than the server produces updates.
#[derive(Debug, Default)]
pub struct Damage {
    rects: Vec<FbRect>,
}

impl Damage {
    pub fn is_empty(&self) -> bool {
        self.rects.is_empty()
    }

    pub fn clear(&mut self) {
        self.rects.clear();
    }

    pub fn add(&mut self, rect: FbRect) {
        if rect.w == 0 || rect.h == 0 {
            return;
        }
        let mut merged = rect;
        // Fold every rectangle the new one touches when the union stays
        // compact; this keeps scrolled/typed regions as a few large blits.
        let mut index = 0;
        while index < self.rects.len() {
            let existing = self.rects[index];
            if existing.contains(&merged) {
                return;
            }
            if merged.contains(&existing)
                || (merged.touches(&existing)
                    && merged.union(&existing).area() <= (merged.area() + existing.area()) * 5 / 4)
            {
                merged = merged.union(&existing);
                self.rects.swap_remove(index);
                index = 0;
                continue;
            }
            index += 1;
        }
        self.rects.push(merged);
        if self.rects.len() > MAX_DAMAGE_RECTS {
            let bounds = self
                .rects
                .iter()
                .skip(1)
                .fold(self.rects[0], |acc, rect| acc.union(rect));
            self.rects.clear();
            self.rects.push(bounds);
        }
    }

    pub fn take(&mut self) -> Vec<FbRect> {
        std::mem::take(&mut self.rects)
    }

    #[cfg(test)]
    pub fn rects(&self) -> &[FbRect] {
        &self.rects
    }
}

/// Authoritative RGBA framebuffer. The blocking RFB reader writes decoded
/// rectangles into it; the relay reads the newest pixels of damaged regions
/// out of it whenever the WebView is ready for another frame.
#[derive(Debug)]
pub struct Framebuffer {
    width: u16,
    height: u16,
    pixels: Vec<u8>,
}

pub type SharedFramebuffer = Arc<Mutex<Framebuffer>>;

impl Framebuffer {
    pub fn new(width: u16, height: u16, limits: &DecodeLimits) -> Result<Self, String> {
        let bytes = limits
            .framebuffer_bytes(width, height)
            .map_err(|e| e.to_string())?;
        Ok(Self {
            width,
            height,
            pixels: vec![0u8; bytes],
        })
    }

    pub fn empty() -> Self {
        Self {
            width: 0,
            height: 0,
            pixels: Vec::new(),
        }
    }

    pub fn shared(self) -> SharedFramebuffer {
        Arc::new(Mutex::new(self))
    }

    pub fn width(&self) -> u16 {
        self.width
    }

    pub fn height(&self) -> u16 {
        self.height
    }

    #[cfg(test)]
    pub fn pixels(&self) -> &[u8] {
        &self.pixels
    }

    pub fn resize(&mut self, width: u16, height: u16, limits: &DecodeLimits) -> Result<(), String> {
        *self = Self::new(width, height, limits)?;
        Ok(())
    }

    fn in_bounds(&self, rect: FbRect) -> bool {
        rect.right() <= u32::from(self.width) && rect.bottom() <= u32::from(self.height)
    }

    /// Copy a tightly packed `w*h*4` RGBA block into the framebuffer.
    pub fn blit(&mut self, rect: FbRect, src: &[u8]) -> Result<(), String> {
        let row_bytes = usize::from(rect.w) * 4;
        if !self.in_bounds(rect) || src.len() < row_bytes * usize::from(rect.h) {
            return Err("framebuffer blit is outside the negotiated size".into());
        }
        let stride = usize::from(self.width) * 4;
        let x_offset = usize::from(rect.x) * 4;
        for (row, chunk) in src
            .chunks_exact(row_bytes)
            .take(usize::from(rect.h))
            .enumerate()
        {
            let start = (usize::from(rect.y) + row) * stride + x_offset;
            self.pixels[start..start + row_bytes].copy_from_slice(chunk);
        }
        Ok(())
    }

    /// CopyRect: move a region inside the framebuffer, overlap-safe.
    pub fn copy_rect(&mut self, src_x: u16, src_y: u16, dst: FbRect) -> Result<(), String> {
        let src = FbRect::new(src_x, src_y, dst.w, dst.h);
        if !self.in_bounds(src) || !self.in_bounds(dst) {
            return Err("copyrect: source or destination is outside framebuffer".into());
        }
        let stride = usize::from(self.width) * 4;
        let row_bytes = usize::from(dst.w) * 4;
        let rows: Box<dyn Iterator<Item = usize>> = if dst.y > src_y {
            Box::new((0..usize::from(dst.h)).rev())
        } else {
            Box::new(0..usize::from(dst.h))
        };
        for row in rows {
            let from = (usize::from(src_y) + row) * stride + usize::from(src_x) * 4;
            let to = (usize::from(dst.y) + row) * stride + usize::from(dst.x) * 4;
            self.pixels.copy_within(from..from + row_bytes, to);
        }
        Ok(())
    }

    /// Serialize the current pixels of `rect` as one relay WebSocket message:
    /// the 12-byte rectangle header followed by tightly packed RGBA rows.
    pub fn relay_frame(&self, rect: FbRect) -> Option<Vec<u8>> {
        if rect.w == 0 || rect.h == 0 || !self.in_bounds(rect) {
            return None;
        }
        let row_bytes = usize::from(rect.w) * 4;
        let stride = usize::from(self.width) * 4;
        let mut frame = Vec::with_capacity(RELAY_RECT_HEADER_LEN + row_bytes * usize::from(rect.h));
        frame.extend_from_slice(&rect.x.to_be_bytes());
        frame.extend_from_slice(&rect.y.to_be_bytes());
        frame.extend_from_slice(&rect.w.to_be_bytes());
        frame.extend_from_slice(&rect.h.to_be_bytes());
        frame.extend_from_slice(&[0u8; 4]);
        for row in 0..usize::from(rect.h) {
            let start = (usize::from(rect.y) + row) * stride + usize::from(rect.x) * 4;
            frame.extend_from_slice(&self.pixels[start..start + row_bytes]);
        }
        Some(frame)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fb(w: u16, h: u16) -> Framebuffer {
        Framebuffer::new(w, h, &DecodeLimits::default()).unwrap()
    }

    #[test]
    fn blit_and_relay_frame_round_trip() {
        let mut frame = fb(4, 2);
        frame
            .blit(FbRect::new(1, 1, 2, 1), &[1, 1, 1, 255, 2, 2, 2, 255])
            .unwrap();
        let relay = frame.relay_frame(FbRect::new(1, 1, 2, 1)).unwrap();
        assert_eq!(&relay[..12], &[0, 1, 0, 1, 0, 2, 0, 1, 0, 0, 0, 0]);
        assert_eq!(&relay[12..], &[1, 1, 1, 255, 2, 2, 2, 255]);
        assert!(frame.blit(FbRect::new(3, 1, 2, 1), &[0; 8]).is_err());
    }

    #[test]
    fn copy_rect_handles_overlapping_scroll() {
        let mut frame = fb(1, 3);
        frame
            .blit(
                FbRect::new(0, 0, 1, 3),
                &[1, 0, 0, 255, 2, 0, 0, 255, 3, 0, 0, 255],
            )
            .unwrap();
        // Scroll down by one row: rows 0..2 move to 1..3.
        frame.copy_rect(0, 0, FbRect::new(0, 1, 1, 2)).unwrap();
        assert_eq!(frame.pixels(), &[1, 0, 0, 255, 1, 0, 0, 255, 2, 0, 0, 255]);
        assert!(frame.copy_rect(0, 2, FbRect::new(0, 0, 1, 2)).is_err());
    }

    #[test]
    fn damage_merges_adjacent_tiles_and_stays_bounded() {
        let mut damage = Damage::default();
        for tile in 0..105u16 {
            damage.add(FbRect::new((tile % 105) * 16, 0, 16, 16));
        }
        assert_eq!(damage.rects(), &[FbRect::new(0, 0, 1680, 16)]);

        let mut scattered = Damage::default();
        for index in 0..40u16 {
            scattered.add(FbRect::new(index * 40, index * 20, 4, 4));
        }
        assert!(scattered.rects().len() <= MAX_DAMAGE_RECTS);
        let bounds = scattered.take();
        assert!(
            bounds
                .iter()
                .any(|rect| rect.contains(&FbRect::new(39 * 40, 39 * 20, 4, 4)))
        );
        assert!(scattered.is_empty());
    }

    #[test]
    fn damage_ignores_contained_rectangles() {
        let mut damage = Damage::default();
        damage.add(FbRect::new(0, 0, 100, 100));
        damage.add(FbRect::new(10, 10, 5, 5));
        assert_eq!(damage.rects(), &[FbRect::new(0, 0, 100, 100)]);
    }
}
