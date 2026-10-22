use super::pixels::check_scratch;
use super::pixels::read_u16_be;
use crate::vnc::pixel::PixelConverter;
use std::io::Read;

// ── Raw encoding (type 0) ──────────────────────────────────────────

/// Read a Raw-encoded rectangle: `w*h` PIXELs of the negotiated format. The
/// default RGBA32 format is read in place; alpha is forced to 0xFF because
/// many servers leave it at 0.
pub fn decode_raw_into<R: Read>(
    r: &mut R,
    w: u16,
    h: u16,
    conv: &PixelConverter,
    out: &mut [u8],
) -> Result<(), String> {
    check_scratch(out, w, h)?;
    if conv.format().is_native_rgba() {
        r.read_exact(out)
            .map_err(|e| format!("raw: read pixels: {}", e))?;
        for pixel in out.chunks_exact_mut(4) {
            pixel[3] = 255;
        }
        return Ok(());
    }
    let mut wire = vec![0u8; usize::from(w) * usize::from(h) * conv.bytes_per_pixel()];
    r.read_exact(&mut wire)
        .map_err(|e| format!("raw: read pixels: {}", e))?;
    conv.convert_row(&wire, out);
    Ok(())
}

/// Read the 4-byte CopyRect payload (src_x, src_y). The copy itself runs
/// against the framebuffer.
pub fn read_copyrect_source<R: Read>(r: &mut R) -> Result<(u16, u16), String> {
    let src_x = read_u16_be(r).map_err(|e| format!("copyrect: src_x: {}", e))?;
    let src_y = read_u16_be(r).map_err(|e| format!("copyrect: src_y: {}", e))?;
    Ok((src_x, src_y))
}
