//! Decoded RDP framebuffer tiles delivered to the WS relay.
//!
//! Bitmap and surface PDUs are decoded into a small set of intermediate
//! representations the WS layer can re-frame for the React canvas:
//!
//! - [`DecodedTile`] — a single rectangle of RGBA pixels. The frontend
//!   `RdpPanel` consumes these one-for-one.
//! - [`TileHeader`] — the 8-byte (x, y, w, h) header prepended to each
//!   FRAME-channel WS message. See `ws::frame_payload_with_header`.
//!
//! Real RemoteFX / RDP6 / Bitmap decoders land here in step 8 of the plan.
//! For now the helpers provide the stable wire format the canvas expects.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TileHeader {
    pub x: u16,
    pub y: u16,
    pub w: u16,
    pub h: u16,
}

#[derive(Debug, Clone)]
pub struct DecodedTile {
    pub header: TileHeader,
    /// Tightly-packed RGBA bytes (4 bytes per pixel, row-major, no
    /// stride padding). Length must equal `4 * w * h`.
    pub rgba: Vec<u8>,
}

impl DecodedTile {
    /// Build a tile from a solid color. Useful for placeholder paints
    /// while the upper-layer codec is not yet wired.
    pub fn solid(x: u16, y: u16, w: u16, h: u16, rgba: [u8; 4]) -> Self {
        let pixels = (w as usize) * (h as usize);
        let mut buf = Vec::with_capacity(pixels * 4);
        for _ in 0..pixels {
            buf.extend_from_slice(&rgba);
        }
        Self {
            header: TileHeader { x, y, w, h },
            rgba: buf,
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        let expected = 4 * (self.header.w as usize) * (self.header.h as usize);
        if self.rgba.len() != expected {
            return Err(format!(
                "DecodedTile: rgba length {} != expected {} ({}×{}×4)",
                self.rgba.len(),
                expected,
                self.header.w,
                self.header.h,
            ));
        }
        Ok(())
    }
}

/// Convert a 16-bpp RGB565 buffer into RGBA8888. Used for cursor masks
/// and the bitmap update path's RDP 5.0 fallback.
pub fn rgb565_to_rgba(src: &[u8], pixels: usize) -> Result<Vec<u8>, String> {
    if src.len() < pixels * 2 {
        return Err(format!(
            "rgb565_to_rgba: {} bytes < {} expected",
            src.len(),
            pixels * 2
        ));
    }
    let mut out = Vec::with_capacity(pixels * 4);
    for i in 0..pixels {
        let lo = src[i * 2];
        let hi = src[i * 2 + 1];
        let v = u16::from_le_bytes([lo, hi]);
        let r5 = ((v >> 11) & 0x1f) as u8;
        let g6 = ((v >> 5) & 0x3f) as u8;
        let b5 = (v & 0x1f) as u8;
        // Linear scale 5/6-bit to 8-bit.
        let r = ((r5 << 3) | (r5 >> 2)) as u8;
        let g = ((g6 << 2) | (g6 >> 4)) as u8;
        let b = ((b5 << 3) | (b5 >> 2)) as u8;
        out.extend_from_slice(&[r, g, b, 0xff]);
    }
    Ok(out)
}

/// Convert a packed BGRA8888 tile (RDP's wire order for 32-bpp bitmaps)
/// into RGBA8888 for the HTML canvas. Operates in-place.
pub fn bgra_to_rgba_in_place(buf: &mut [u8]) {
    for chunk in buf.chunks_exact_mut(4) {
        chunk.swap(0, 2);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn solid_tile_roundtrip() {
        let t = DecodedTile::solid(0, 0, 2, 2, [0xff, 0x00, 0x00, 0xff]);
        assert!(t.validate().is_ok());
        assert_eq!(t.rgba.len(), 16);
        assert_eq!(t.rgba[0], 0xff);
        assert_eq!(t.rgba[1], 0x00);
        assert_eq!(t.rgba[3], 0xff);
    }

    #[test]
    fn validate_rejects_size_mismatch() {
        let t = DecodedTile {
            header: TileHeader { x: 0, y: 0, w: 4, h: 4 },
            rgba: vec![0; 60], // expected 64
        };
        assert!(t.validate().is_err());
    }

    #[test]
    fn rgb565_to_rgba_known_value() {
        // 0xF800 == pure red in RGB565
        let src: Vec<u8> = vec![0x00, 0xF8];
        let rgba = rgb565_to_rgba(&src, 1).unwrap();
        assert_eq!(rgba, vec![0xFF, 0x00, 0x00, 0xFF]);
    }

    #[test]
    fn bgra_swap_in_place() {
        let mut buf = vec![1, 2, 3, 4, 5, 6, 7, 8];
        bgra_to_rgba_in_place(&mut buf);
        assert_eq!(buf, vec![3, 2, 1, 4, 7, 6, 5, 8]);
    }
}
