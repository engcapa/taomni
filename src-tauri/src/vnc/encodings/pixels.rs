use std::io::Read;

// ── Helpers to read big-endian integers from an `impl Read`. ──

pub(super) fn read_u8<R: Read>(r: &mut R) -> std::io::Result<u8> {
    let mut b = [0u8; 1];
    r.read_exact(&mut b)?;
    Ok(b[0])
}

pub(super) fn read_u16_be<R: Read>(r: &mut R) -> std::io::Result<u16> {
    let mut b = [0u8; 2];
    r.read_exact(&mut b)?;
    Ok(u16::from_be_bytes(b))
}

pub(super) fn read_u32_be<R: Read>(r: &mut R) -> std::io::Result<u32> {
    let mut b = [0u8; 4];
    r.read_exact(&mut b)?;
    Ok(u32::from_be_bytes(b))
}

pub(super) fn check_scratch(out: &[u8], w: u16, h: u16) -> Result<(), String> {
    if out.len() != usize::from(w) * usize::from(h) * 4 {
        return Err("decoder scratch buffer does not match the rectangle".into());
    }
    Ok(())
}

/// Expand packed `R, G, B` pixels (ZRLE CPIXEL / Tight TPIXEL) into opaque
/// RGBA. Every pixel but possibly the last is loaded as one little-endian
/// `u32` that overlaps the next pixel's first byte, which keeps the loop to a
/// load, an OR and a store per pixel (VNC-PERF-003).
#[inline]
pub(crate) fn rgb_to_rgba(src: &[u8], dst: &mut [u8]) {
    let pixels = dst.len() / 4;
    debug_assert!(src.len() >= pixels * 3);
    let mut written = 0usize;
    for (out, window) in dst.chunks_exact_mut(4).zip(src.windows(4).step_by(3)) {
        let value = u32::from_le_bytes([window[0], window[1], window[2], window[3]]) | 0xFF00_0000;
        out.copy_from_slice(&value.to_le_bytes());
        written += 1;
    }
    for index in written..pixels {
        let s = index * 3;
        dst[index * 4..index * 4 + 4].copy_from_slice(&[src[s], src[s + 1], src[s + 2], 255]);
    }
}

/// Fill a sub-rectangle of a packed RGBA block with one colour.
pub(super) fn fill_block(
    out: &mut [u8],
    stride_px: usize,
    x: usize,
    y: usize,
    w: usize,
    h: usize,
    colour: [u8; 4],
) {
    for row in y..y + h {
        let start = (row * stride_px + x) * 4;
        for pixel in out[start..start + w * 4].chunks_exact_mut(4) {
            pixel.copy_from_slice(&colour);
        }
    }
}
