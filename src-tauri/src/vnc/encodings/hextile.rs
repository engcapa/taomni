use super::pixels::check_scratch;
use super::pixels::fill_block;
use super::pixels::read_u8;
use crate::vnc::pixel::PixelConverter;
use std::io::Read;

// ── Hextile encoding (type 5) ──────────────────────────────────────

pub(super) const HEXTILE_RAW: u8 = 0x01;
pub(super) const HEXTILE_BG_SPECIFIED: u8 = 0x02;
pub(super) const HEXTILE_FG_SPECIFIED: u8 = 0x04;
pub(super) const HEXTILE_ANY_SUBRECTS: u8 = 0x08;
pub(super) const HEXTILE_SUBRECTS_COLOURED: u8 = 0x10;

/// State carried across Hextile tiles: RFB requires bg/fg to persist when the
/// server omits them from a tile.
#[derive(Default)]
pub struct HextileState {
    pub(super) bg: [u8; 4],
    pub(super) fg: [u8; 4],
}

impl HextileState {
    pub fn new() -> Self {
        Self::default()
    }
}

/// Decode a Hextile rectangle tile-by-tile into `out`. Reads exactly the
/// bytes the server sent, carries bg/fg across tiles and applies the five
/// subencoding flags.
pub fn decode_hextile_into<R: Read>(
    r: &mut R,
    rect_w: u16,
    rect_h: u16,
    state: &mut HextileState,
    conv: &PixelConverter,
    out: &mut [u8],
) -> Result<(), String> {
    check_scratch(out, rect_w, rect_h)?;
    let stride = usize::from(rect_w);
    let bpp = conv.bytes_per_pixel();
    let mut tile_raw = [0u8; 16 * 16 * 4];
    let read_pixel = |r: &mut R, what: &str| -> Result<[u8; 4], String> {
        let mut pixel = [0u8; 4];
        r.read_exact(&mut pixel[..bpp])
            .map_err(|e| format!("hextile: {what}: {e}"))?;
        Ok(conv.pixel(&pixel[..bpp]))
    };

    let mut tile_y = 0u16;
    while tile_y < rect_h {
        let tile_h = 16u16.min(rect_h - tile_y);
        let mut tile_x = 0u16;
        while tile_x < rect_w {
            let tile_w = 16u16.min(rect_w - tile_x);
            let (tx, ty) = (usize::from(tile_x), usize::from(tile_y));
            let (tw, th) = (usize::from(tile_w), usize::from(tile_h));
            let subenc = read_u8(r).map_err(|e| format!("hextile: subenc: {}", e))?;

            if subenc & HEXTILE_RAW != 0 {
                let bytes = &mut tile_raw[..tw * th * bpp];
                r.read_exact(bytes)
                    .map_err(|e| format!("hextile: raw tile pixels: {}", e))?;
                for (row, chunk) in bytes.chunks_exact(tw * bpp).enumerate() {
                    let start = ((ty + row) * stride + tx) * 4;
                    conv.convert_row(chunk, &mut out[start..start + tw * 4]);
                }
                tile_x += tile_w;
                continue;
            }

            if subenc & HEXTILE_BG_SPECIFIED != 0 {
                state.bg = read_pixel(r, "bg")?;
            }
            if subenc & HEXTILE_FG_SPECIFIED != 0 {
                state.fg = read_pixel(r, "fg")?;
            }

            fill_block(out, stride, tx, ty, tw, th, state.bg);

            if subenc & HEXTILE_ANY_SUBRECTS != 0 {
                let n_subrects =
                    read_u8(r).map_err(|e| format!("hextile: n_subrects: {}", e))? as usize;
                let coloured = subenc & HEXTILE_SUBRECTS_COLOURED != 0;
                for _ in 0..n_subrects {
                    let colour = if coloured {
                        read_pixel(r, "sr colour")?
                    } else {
                        state.fg
                    };
                    let mut geometry = [0u8; 2];
                    r.read_exact(&mut geometry)
                        .map_err(|e| format!("hextile: sr geometry: {}", e))?;
                    let sx = (geometry[0] >> 4) as usize;
                    let sy = (geometry[0] & 0x0F) as usize;
                    let sw = ((geometry[1] >> 4) as usize) + 1;
                    let sh = ((geometry[1] & 0x0F) as usize) + 1;
                    if sx >= tw || sy >= th {
                        continue;
                    }
                    let w = sw.min(tw - sx);
                    let h = sh.min(th - sy);
                    fill_block(out, stride, tx + sx, ty + sy, w, h, colour);
                }
            }
            tile_x += tile_w;
        }
        tile_y += tile_h;
    }

    Ok(())
}
