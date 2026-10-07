use std::io::Read;
use zlib_rs::{Inflate, InflateFlush};

use crate::vnc::limits::DecodeLimits;
use crate::vnc::pixel::PixelConverter;

// Pixel decoders write straight into a caller-owned, tightly packed RGBA
// scratch block of `w*h*4` bytes (stride `w*4`). The RFB connection then blits
// that block into the authoritative framebuffer once per server rectangle, so
// no per-tile allocation or per-tile relay message is produced.

#[derive(Debug)]
pub struct DecodedCursor {
    pub hotspot_x: u16,
    pub hotspot_y: u16,
    pub width: u16,
    pub height: u16,
    pub rgba: Vec<u8>,
}

/// Cursor position delivered by the RFB PointerPos pseudo-encoding (-232).
/// The encoding uses the rectangle header only; its width and height must be
/// zero and no payload follows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DecodedPointerPosition {
    pub x: u16,
    pub y: u16,
}

pub const ENCODING_DESKTOP_SIZE: i32 = -223;
pub const ENCODING_POINTER_POS: i32 = -232;
pub const ENCODING_RICH_CURSOR: i32 = -239;
pub const ENCODING_X_CURSOR: i32 = -240;

const MAX_CURSOR_DIMENSION: u16 = 512;

// ── Helpers to read big-endian integers from an `impl Read`. ──

fn read_u8<R: Read>(r: &mut R) -> std::io::Result<u8> {
    let mut b = [0u8; 1];
    r.read_exact(&mut b)?;
    Ok(b[0])
}

fn read_u16_be<R: Read>(r: &mut R) -> std::io::Result<u16> {
    let mut b = [0u8; 2];
    r.read_exact(&mut b)?;
    Ok(u16::from_be_bytes(b))
}

fn read_u32_be<R: Read>(r: &mut R) -> std::io::Result<u32> {
    let mut b = [0u8; 4];
    r.read_exact(&mut b)?;
    Ok(u32::from_be_bytes(b))
}

fn check_scratch(out: &[u8], w: u16, h: u16) -> Result<(), String> {
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
fn fill_block(
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

// ── Hextile encoding (type 5) ──────────────────────────────────────

const HEXTILE_RAW: u8 = 0x01;
const HEXTILE_BG_SPECIFIED: u8 = 0x02;
const HEXTILE_FG_SPECIFIED: u8 = 0x04;
const HEXTILE_ANY_SUBRECTS: u8 = 0x08;
const HEXTILE_SUBRECTS_COLOURED: u8 = 0x10;

/// State carried across Hextile tiles: RFB requires bg/fg to persist when the
/// server omits them from a tile.
#[derive(Default)]
pub struct HextileState {
    bg: [u8; 4],
    fg: [u8; 4],
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

// ── ZRLE encoding (type 16) ────────────────────────────────────────

/// Persistent ZRLE zlib stream. RFB keeps a single zlib stream that spans
/// every ZRLE rectangle in the session, so the decoder state cannot be
/// discarded between rectangles.
pub struct ZrleDecoder {
    /// zlib-rs: ~1.7x the inflate throughput of the stock zlib that flate2
    /// resolves to here (VNC-PERF-003).
    inflater: Inflate,
    /// Decompressed bytes already produced but not yet consumed by a tile.
    buf: Vec<u8>,
    /// Read cursor into `buf`.
    pos: usize,
    /// Reused compressed-body buffer.
    compressed: Vec<u8>,
}

impl ZrleDecoder {
    pub fn new() -> Self {
        Self {
            inflater: Inflate::new(/* zlib header */ true, 15),
            buf: Vec::new(),
            pos: 0,
            compressed: Vec::new(),
        }
    }
}

impl Default for ZrleDecoder {
    fn default() -> Self {
        Self::new()
    }
}

/// Decode a ZRLE rectangle into `out`. Uses `dec` to preserve zlib state
/// across calls, per RFB 7.7.6.
pub fn decode_zrle_into<R: Read>(
    r: &mut R,
    rect_w: u16,
    rect_h: u16,
    dec: &mut ZrleDecoder,
    limits: &DecodeLimits,
    conv: &PixelConverter,
    out: &mut [u8],
) -> Result<(), String> {
    check_scratch(out, rect_w, rect_h)?;
    let zlib_len_raw = read_u32_be(r).map_err(|e| format!("zrle: len: {}", e))?;
    let zlib_len = limits
        .compressed_bytes(zlib_len_raw)
        .map_err(|e| e.to_string())?;
    let _rect_bytes = limits
        .rectangle_bytes(rect_w, rect_h)
        .map_err(|e| e.to_string())?;
    let mut compressed = std::mem::take(&mut dec.compressed);
    compressed.clear();
    compressed.resize(zlib_len, 0);
    let read = r.read_exact(&mut compressed);
    if let Err(e) = read {
        dec.compressed = compressed;
        return Err(format!("zrle: body: {}", e));
    }
    // Large rectangles (full-screen updates) inflate on a helper thread
    // while this thread decodes tiles from the bytes already produced.
    if compressed.len() >= ZRLE_PIPELINE_MIN_COMPRESSED && dec.pos >= dec.buf.len() {
        let result = decode_zrle_pipelined(dec, &compressed, rect_w, rect_h, limits, conv, out);
        dec.compressed = compressed;
        return result;
    }
    let inflated = inflate_into(dec, &compressed, limits);
    dec.compressed = compressed;
    inflated?;

    let stride = usize::from(rect_w);
    let mut tile_y = 0u16;
    while tile_y < rect_h {
        let tile_h = 64u16.min(rect_h - tile_y);
        let mut tile_x = 0u16;
        while tile_x < rect_w {
            let tile_w = 64u16.min(rect_w - tile_x);
            zrle_decode_tile(
                &dec.buf,
                &mut dec.pos,
                conv,
                out,
                stride,
                usize::from(tile_x),
                usize::from(tile_y),
                usize::from(tile_w),
                usize::from(tile_h),
            )?;
            tile_x += tile_w;
        }
        tile_y += tile_h;
    }

    // Compact the buffer once we've cleared enough of it to avoid unbounded growth.
    if dec.pos >= dec.buf.len() {
        dec.buf.clear();
        dec.pos = 0;
    } else if dec.pos > 1 << 20 {
        dec.buf.drain(..dec.pos);
        dec.pos = 0;
    }

    Ok(())
}

/// Compressed ZRLE bodies at least this large use the overlapped decoder.
const ZRLE_PIPELINE_MIN_COMPRESSED: usize = 256 * 1024;
/// Inflate output handed to the tile decoder per step.
const ZRLE_PIPELINE_CHUNK: usize = 256 * 1024;

/// Upper bound of the inflated bytes of one ZRLE rectangle: per tile one
/// subencoding byte and a 127-colour palette, per pixel at most a CPIXEL plus
/// one run-length byte. A valid stream never produces more.
fn zrle_inflated_bound(rect_w: u16, rect_h: u16, cpixel: usize) -> usize {
    let tiles = usize::from(rect_w).div_ceil(64) * usize::from(rect_h).div_ceil(64);
    tiles * (1 + 127 * cpixel) + usize::from(rect_w) * usize::from(rect_h) * (cpixel + 1)
}

/// VNC-PERF-003: overlap inflate (helper thread) with tile decoding (this
/// thread). The inflater writes into reserved capacity that is never
/// reallocated; the decoder only reads bytes the inflater has published with
/// a Release store, so producer and consumer touch disjoint memory. A tile
/// that runs out of published bytes is decoded again once more arrive.
fn decode_zrle_pipelined(
    dec: &mut ZrleDecoder,
    compressed: &[u8],
    rect_w: u16,
    rect_h: u16,
    limits: &DecodeLimits,
    conv: &PixelConverter,
    out: &mut [u8],
) -> Result<(), String> {
    use std::mem::MaybeUninit;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    let bound = zrle_inflated_bound(rect_w, rect_h, conv.cpixel_bytes());
    if bound > limits.max_decompressed_rect_bytes {
        return Err("zrle: decompressed output exceeds configured limit".into());
    }
    dec.buf.clear();
    dec.pos = 0;
    dec.buf.reserve(bound);
    let base = dec.buf.as_mut_ptr() as usize;
    let produced = AtomicUsize::new(0);
    let finished = AtomicBool::new(false);
    let inflater = &mut dec.inflater;
    let stride = usize::from(rect_w);

    let (inflate_result, decode_result) = std::thread::scope(|scope| {
        let producer = scope.spawn(|| {
            let mut consumed = 0usize;
            let mut written = 0usize;
            let result = loop {
                let room = (bound - written).min(ZRLE_PIPELINE_CHUNK);
                if room == 0 {
                    break if consumed < compressed.len() {
                        Err("zrle: stream inflates beyond the rectangle bound".to_string())
                    } else {
                        Ok(())
                    };
                }
                // SAFETY: [written, written + room) lies inside the reserved,
                // never-reallocated capacity and is not yet published to the
                // consumer, which only reads [0, produced).
                let spare = unsafe {
                    std::slice::from_raw_parts_mut(
                        (base as *mut MaybeUninit<u8>).add(written),
                        room,
                    )
                };
                let in_before = inflater.total_in();
                let out_before = inflater.total_out();
                let status = match inflater.decompress_uninit(
                    &compressed[consumed..],
                    spare,
                    InflateFlush::NoFlush,
                ) {
                    Ok(status) => status,
                    Err(e) => break Err(format!("zrle: inflate: {}", e.as_str())),
                };
                let used = (inflater.total_in() - in_before) as usize;
                let made = (inflater.total_out() - out_before) as usize;
                consumed += used;
                written += made;
                produced.store(written, Ordering::Release);
                if matches!(status, zlib_rs::Status::StreamEnd)
                    || (consumed >= compressed.len() && made < room)
                    || (used == 0 && made == 0)
                {
                    break Ok(());
                }
            };
            finished.store(true, Ordering::Release);
            result.map(|()| written)
        });

        let mut pos = 0usize;
        let mut decode = || -> Result<(), String> {
            let mut tile_y = 0u16;
            while tile_y < rect_h {
                let tile_h = 64u16.min(rect_h - tile_y);
                let mut tile_x = 0u16;
                while tile_x < rect_w {
                    let tile_w = 64u16.min(rect_w - tile_x);
                    loop {
                        let done = finished.load(Ordering::Acquire);
                        let available = produced.load(Ordering::Acquire);
                        // SAFETY: bytes below `available` were initialised by
                        // the producer before its Release store.
                        let buf =
                            unsafe { std::slice::from_raw_parts(base as *const u8, available) };
                        let start = pos;
                        match zrle_decode_tile(
                            buf,
                            &mut pos,
                            conv,
                            out,
                            stride,
                            usize::from(tile_x),
                            usize::from(tile_y),
                            usize::from(tile_w),
                            usize::from(tile_h),
                        ) {
                            Ok(()) => break,
                            Err(error) if !done && error.starts_with("zrle: eof") => {
                                pos = start;
                                while !finished.load(Ordering::Acquire)
                                    && produced.load(Ordering::Acquire) == available
                                {
                                    std::thread::yield_now();
                                }
                            }
                            Err(error) => return Err(error),
                        }
                    }
                    tile_x += tile_w;
                }
                tile_y += tile_h;
            }
            Ok(())
        };
        let decoded = decode();
        let inflated = producer
            .join()
            .unwrap_or_else(|_| Err("zrle: inflate worker panicked".into()));
        (inflated, decoded.map(|()| pos))
    });

    let written = inflate_result?;
    // SAFETY: the producer initialised exactly `written` bytes of capacity.
    unsafe { dec.buf.set_len(written) };
    dec.pos = decode_result?;
    if dec.pos >= dec.buf.len() {
        dec.buf.clear();
        dec.pos = 0;
    }
    Ok(())
}

/// Feed the newly-arrived bytes into the persistent inflater. It is NOT
/// enough to stop as soon as the input slice has been fully consumed: the
/// inflater may hold queued output, which must be drained with an extra
/// empty-input call before the tile decoder runs (otherwise it hits
/// `eof cpixel`). Output goes into uninitialised spare capacity, so the
/// multi-megabyte growth step is never zero-filled.
fn inflate_into(
    dec: &mut ZrleDecoder,
    compressed: &[u8],
    limits: &DecodeLimits,
) -> Result<(), String> {
    // Most rectangles expand 2-6x; grow in large steps to keep the number of
    // inflate calls small.
    let step = (compressed.len().saturating_mul(4)).clamp(64 * 1024, 8 * 1024 * 1024);
    let mut src_consumed = 0usize;
    loop {
        let current_len = dec.buf.len();
        let next_len = current_len
            .checked_add(step)
            .ok_or_else(|| "zrle: output size overflow".to_string())?;
        if next_len > limits.max_decompressed_rect_bytes.saturating_add(dec.pos) {
            return Err("zrle: decompressed output exceeds configured limit".into());
        }
        dec.buf.reserve(step);

        let input_slice: &[u8] = if src_consumed < compressed.len() {
            &compressed[src_consumed..]
        } else {
            &[]
        };

        let tin_before = dec.inflater.total_in();
        let tout_before = dec.inflater.total_out();

        let spare = &mut dec.buf.spare_capacity_mut()[..step];
        let status = dec
            .inflater
            .decompress_uninit(input_slice, spare, InflateFlush::NoFlush)
            .map_err(|e| format!("zrle: inflate: {}", e.as_str()))?;

        let consumed_in = (dec.inflater.total_in() - tin_before) as usize;
        let produced_out = (dec.inflater.total_out() - tout_before) as usize;

        // SAFETY: the inflater initialised exactly `produced_out` bytes of the
        // spare capacity it was given (at most `step`, reserved above).
        unsafe { dec.buf.set_len(current_len + produced_out) };
        src_consumed += consumed_in;

        // All input fed in AND the inflater has nothing more to emit.
        if src_consumed >= compressed.len() && produced_out == 0 {
            break;
        }
        // Safety net against a livelock on malformed input.
        if consumed_in == 0 && produced_out == 0 {
            break;
        }
        if matches!(status, zlib_rs::Status::StreamEnd) {
            break;
        }
    }
    Ok(())
}

/// Decode one ZRLE tile from the inflated byte slice into `out`.
///
/// ZRLE uses **CPIXEL** — the compact form of the negotiated pixel format.
/// With our RGBA32 format (R@0, G@8, B@16, depth 24, true-colour) the CPIXEL
/// is 3 bytes `[R, G, B]`.
#[allow(clippy::too_many_arguments)]
fn zrle_decode_tile(
    buf: &[u8],
    pos: &mut usize,
    conv: &PixelConverter,
    out: &mut [u8],
    stride: usize,
    tx: usize,
    ty: usize,
    w: usize,
    h: usize,
) -> Result<(), String> {
    let pixel_count = w * h;

    let subenc = *buf
        .get(*pos)
        .ok_or_else(|| "zrle: eof subenc".to_string())?;
    *pos += 1;

    let row_start = |row: usize| ((ty + row) * stride + tx) * 4;

    let cpx = conv.cpixel_bytes();
    let native = conv.is_native();

    if subenc == 0 {
        // Raw CPIXEL stream.
        let bytes = pixel_count * cpx;
        let src = buf
            .get(*pos..*pos + bytes)
            .ok_or_else(|| "zrle: eof cpixel".to_string())?;
        for row in 0..h {
            let start = row_start(row);
            let dst = &mut out[start..start + w * 4];
            let src_row = &src[row * w * cpx..(row + 1) * w * cpx];
            if native {
                // The rest of the tile lets every pixel of the row take the
                // overlapping-load path.
                rgb_to_rgba(&src[row * w * cpx..], dst);
            } else {
                for (pixel, cpixel) in dst.chunks_exact_mut(4).zip(src_row.chunks_exact(cpx)) {
                    pixel.copy_from_slice(&conv.cpixel(cpixel));
                }
            }
        }
        *pos += bytes;
        return Ok(());
    }

    if subenc == 1 {
        let c = read_cpixel(buf, pos, conv)?;
        fill_block(out, stride, tx, ty, w, h, c);
        return Ok(());
    }

    if (2..=16).contains(&subenc) {
        // Packed palette, 1/2/4 bits-per-pixel.
        let palette_size = subenc as usize;
        let mut palette = [[0u8; 4]; 16];
        for slot in palette.iter_mut().take(palette_size) {
            *slot = read_cpixel(buf, pos, conv)?;
        }
        let bpp: usize = if palette_size == 2 {
            1
        } else if palette_size <= 4 {
            2
        } else {
            4
        };
        let mask = (1u8 << bpp) - 1;
        let pixels_in_byte = 8 / bpp;
        // Each row is packed independently: the partial trailing byte of a row
        // is padded, and the next row starts on a fresh byte.
        let row_bytes = w.div_ceil(pixels_in_byte);
        for row in 0..h {
            let packed = buf
                .get(*pos..*pos + row_bytes)
                .ok_or_else(|| "zrle: eof packed".to_string())?;
            *pos += row_bytes;
            let start = row_start(row);
            for col in 0..w {
                let byte = packed[col / pixels_in_byte];
                let shift = 8 - ((col % pixels_in_byte) + 1) * bpp;
                let idx = ((byte >> shift) & mask) as usize;
                let colour = if idx < palette_size {
                    palette[idx]
                } else {
                    [0, 0, 0, 255]
                };
                out[start + col * 4..start + col * 4 + 4].copy_from_slice(&colour);
            }
        }
        return Ok(());
    }

    if subenc == 128 || (130..=255).contains(&subenc) {
        // Plain RLE over CPIXEL (128) or palette RLE (130..=255): 2..=127
        // colours; indices with the high bit set carry a run length.
        let palette_size = if subenc == 128 {
            0
        } else {
            (subenc - 128) as usize
        };
        let mut palette = [[0u8; 4]; 128];
        for slot in palette.iter_mut().take(palette_size) {
            *slot = read_cpixel(buf, pos, conv)?;
        }
        let mut filled = 0usize;
        let (mut row, mut col) = (0usize, 0usize);
        while filled < pixel_count {
            let (colour, run_len) = if subenc == 128 {
                let colour = if native {
                    let s = *pos;
                    let Some(src) = buf.get(s..s + 3) else {
                        return Err("zrle: eof cpixel".to_string());
                    };
                    *pos += 3;
                    [src[0], src[1], src[2], 255]
                } else {
                    read_cpixel(buf, pos, conv)?
                };
                (colour, read_zrle_run_length(buf, pos)?)
            } else {
                let idx_byte = *buf
                    .get(*pos)
                    .ok_or_else(|| "zrle: eof paletteRLE idx".to_string())?;
                *pos += 1;
                let pal_idx = (idx_byte & 0x7F) as usize;
                let colour = if pal_idx < palette_size {
                    palette[pal_idx]
                } else {
                    [0, 0, 0, 255]
                };
                let run = if idx_byte & 0x80 != 0 {
                    read_zrle_run_length(buf, pos)?
                } else {
                    1
                };
                (colour, run)
            };
            let mut take = run_len.min(pixel_count - filled);
            filled += take;
            // Track the row/column instead of dividing per run: most runs in
            // photographic tiles are a single pixel.
            while take > 0 {
                let span = take.min(w - col);
                let start = row_start(row) + col * 4;
                if span == 1 {
                    out[start..start + 4].copy_from_slice(&colour);
                } else {
                    for pixel in out[start..start + span * 4].chunks_exact_mut(4) {
                        pixel.copy_from_slice(&colour);
                    }
                }
                take -= span;
                col += span;
                if col == w {
                    col = 0;
                    row += 1;
                }
            }
        }
        return Ok(());
    }

    Err(format!("zrle: unsupported subencoding {}", subenc))
}

/// Read one CPIXEL (3 bytes R, G, B for the default format). Alpha is always 0xFF.
#[inline]
fn read_cpixel(buf: &[u8], pos: &mut usize, conv: &PixelConverter) -> Result<[u8; 4], String> {
    let s = *pos;
    let len = conv.cpixel_bytes();
    let Some(src) = buf.get(s..s + len) else {
        return Err("zrle: eof cpixel".to_string());
    };
    *pos += len;
    Ok(conv.cpixel(src))
}

/// ZRLE run length: bytes of 255 accumulate, the first byte < 255 terminates.
/// The total run length is 1 + sum(bytes).
fn read_zrle_run_length(buf: &[u8], pos: &mut usize) -> Result<usize, String> {
    let mut total: usize = 1;
    loop {
        let b = *buf
            .get(*pos)
            .ok_or_else(|| "zrle: eof run length".to_string())?;
        *pos += 1;
        total += b as usize;
        if b != 255 {
            return Ok(total);
        }
    }
}

/// Decode the RichCursor pseudo-encoding (-239). Pixel bytes use the 32-bit
/// RGBA format negotiated for normal rectangles, followed by a one-bit alpha
/// mask whose rows are padded to whole bytes.
pub fn read_rich_cursor<R: Read>(
    reader: &mut R,
    hotspot_x: u16,
    hotspot_y: u16,
    width: u16,
    height: u16,
    conv: &PixelConverter,
) -> Result<DecodedCursor, String> {
    if width == 0 || height == 0 {
        return Ok(DecodedCursor {
            hotspot_x: 0,
            hotspot_y: 0,
            width: 0,
            height: 0,
            rgba: Vec::new(),
        });
    }
    if width > MAX_CURSOR_DIMENSION || height > MAX_CURSOR_DIMENSION {
        return Err(format!(
            "rich cursor dimensions {width}x{height} exceed {MAX_CURSOR_DIMENSION}x{MAX_CURSOR_DIMENSION}"
        ));
    }
    if hotspot_x >= width || hotspot_y >= height {
        return Err(format!(
            "rich cursor hotspot {hotspot_x},{hotspot_y} lies outside {width}x{height}"
        ));
    }

    let pixel_count = usize::from(width)
        .checked_mul(usize::from(height))
        .ok_or_else(|| "rich cursor pixel byte count overflow".to_string())?;
    let pixel_bytes = pixel_count
        .checked_mul(conv.bytes_per_pixel())
        .ok_or_else(|| "rich cursor pixel byte count overflow".to_string())?;
    let mask_stride = usize::from(width).div_ceil(8);
    let mask_bytes = mask_stride
        .checked_mul(usize::from(height))
        .ok_or_else(|| "rich cursor mask byte count overflow".to_string())?;

    let mut wire = vec![0u8; pixel_bytes];
    reader
        .read_exact(&mut wire)
        .map_err(|e| format!("rich cursor pixels: {e}"))?;
    let mut rgba = vec![0u8; pixel_count * 4];
    conv.convert_row(&wire, &mut rgba);
    let mut mask = vec![0u8; mask_bytes];
    reader
        .read_exact(&mut mask)
        .map_err(|e| format!("rich cursor mask: {e}"))?;

    for row in 0..usize::from(height) {
        for column in 0..usize::from(width) {
            let mask_byte = mask[row * mask_stride + column / 8];
            let visible = mask_byte & (0x80 >> (column % 8)) != 0;
            rgba[(row * usize::from(width) + column) * 4 + 3] = if visible { 255 } else { 0 };
        }
    }

    Ok(DecodedCursor {
        hotspot_x,
        hotspot_y,
        width,
        height,
        rgba,
    })
}

/// Decode the XCursor pseudo-encoding (-240). The payload contains foreground
/// and background RGB colours, followed by one-bit image and transparency
/// bitmaps whose rows are padded to whole bytes. A set image bit selects the
/// foreground colour; a set mask bit makes the pixel visible.
pub fn read_x_cursor<R: Read>(
    reader: &mut R,
    hotspot_x: u16,
    hotspot_y: u16,
    width: u16,
    height: u16,
) -> Result<DecodedCursor, String> {
    if width == 0 || height == 0 {
        return Ok(DecodedCursor {
            hotspot_x: 0,
            hotspot_y: 0,
            width: 0,
            height: 0,
            rgba: Vec::new(),
        });
    }
    if width > MAX_CURSOR_DIMENSION || height > MAX_CURSOR_DIMENSION {
        return Err(format!(
            "X cursor dimensions {width}x{height} exceed {MAX_CURSOR_DIMENSION}x{MAX_CURSOR_DIMENSION}"
        ));
    }
    if hotspot_x >= width || hotspot_y >= height {
        return Err(format!(
            "X cursor hotspot {hotspot_x},{hotspot_y} lies outside {width}x{height}"
        ));
    }

    let pixel_count = usize::from(width)
        .checked_mul(usize::from(height))
        .ok_or_else(|| "X cursor pixel count overflow".to_string())?;
    let rgba_bytes = pixel_count
        .checked_mul(4)
        .ok_or_else(|| "X cursor RGBA byte count overflow".to_string())?;
    let bitmap_stride = usize::from(width).div_ceil(8);
    let bitmap_bytes = bitmap_stride
        .checked_mul(usize::from(height))
        .ok_or_else(|| "X cursor bitmap byte count overflow".to_string())?;

    let mut colours = [0u8; 6];
    reader
        .read_exact(&mut colours)
        .map_err(|e| format!("X cursor colours: {e}"))?;
    let mut bitmap = vec![0u8; bitmap_bytes];
    reader
        .read_exact(&mut bitmap)
        .map_err(|e| format!("X cursor bitmap: {e}"))?;
    let mut mask = vec![0u8; bitmap_bytes];
    reader
        .read_exact(&mut mask)
        .map_err(|e| format!("X cursor mask: {e}"))?;

    let mut rgba = vec![0u8; rgba_bytes];
    for row in 0..usize::from(height) {
        for column in 0..usize::from(width) {
            let bit = 0x80 >> (column % 8);
            let bitmap_offset = row * bitmap_stride + column / 8;
            let colour_offset = if bitmap[bitmap_offset] & bit != 0 {
                0
            } else {
                3
            };
            let rgba_offset = (row * usize::from(width) + column) * 4;
            rgba[rgba_offset..rgba_offset + 3]
                .copy_from_slice(&colours[colour_offset..colour_offset + 3]);
            rgba[rgba_offset + 3] = if mask[bitmap_offset] & bit != 0 {
                255
            } else {
                0
            };
        }
    }

    Ok(DecodedCursor {
        hotspot_x,
        hotspot_y,
        width,
        height,
        rgba,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn raw_alpha_is_forced_opaque() {
        // 2x1 pixels, alpha bytes left at 0 by the server.
        let bytes: Vec<u8> = vec![10, 20, 30, 0, 40, 50, 60, 0];
        let mut cur = Cursor::new(bytes);
        let mut rgba = vec![0u8; 8];
        decode_raw_into(&mut cur, 2, 1, &PixelConverter::default(), &mut rgba).unwrap();
        assert_eq!(rgba, vec![10, 20, 30, 255, 40, 50, 60, 255]);
        assert!(
            decode_raw_into(
                &mut Cursor::new(vec![0u8; 8]),
                3,
                1,
                &PixelConverter::default(),
                &mut rgba
            )
            .is_err()
        );
    }

    #[test]
    fn rich_cursor_applies_bitmask_alpha_and_hotspot() {
        let mut payload = vec![10, 20, 30, 0, 40, 50, 60, 0, 70, 80, 90, 0];
        payload.push(0b1010_0000);
        let mut reader = Cursor::new(payload);
        let cursor = read_rich_cursor(&mut reader, 1, 0, 3, 1, &PixelConverter::default()).unwrap();
        assert_eq!((cursor.hotspot_x, cursor.hotspot_y), (1, 0));
        assert_eq!((cursor.width, cursor.height), (3, 1));
        assert_eq!(
            cursor.rgba,
            vec![10, 20, 30, 255, 40, 50, 60, 0, 70, 80, 90, 255]
        );
    }

    #[test]
    fn rich_cursor_rejects_invalid_geometry() {
        assert!(
            read_rich_cursor(
                &mut Cursor::new(Vec::<u8>::new()),
                3,
                0,
                3,
                1,
                &PixelConverter::default()
            )
            .is_err()
        );
        assert!(
            read_rich_cursor(
                &mut Cursor::new(Vec::<u8>::new()),
                0,
                0,
                513,
                1,
                &PixelConverter::default()
            )
            .is_err()
        );
    }

    #[test]
    fn x_cursor_applies_colours_bitmap_mask_and_hotspot() {
        let mut payload = vec![10, 20, 30, 40, 50, 60];
        payload.extend_from_slice(&[0b1010_0000, 0b0100_0000]);
        payload.extend_from_slice(&[0b1100_0000, 0b0110_0000]);
        let mut reader = Cursor::new(payload);
        let cursor = read_x_cursor(&mut reader, 2, 1, 3, 2).unwrap();

        assert_eq!((cursor.hotspot_x, cursor.hotspot_y), (2, 1));
        assert_eq!((cursor.width, cursor.height), (3, 2));
        assert_eq!(
            cursor.rgba,
            vec![
                10, 20, 30, 255, 40, 50, 60, 255, 10, 20, 30, 0, 40, 50, 60, 0, 10, 20, 30, 255,
                40, 50, 60, 255,
            ]
        );
        assert_eq!(reader.position() as usize, reader.get_ref().len());
    }

    #[test]
    fn x_cursor_rejects_invalid_geometry_and_truncated_payloads() {
        assert!(read_x_cursor(&mut Cursor::new(Vec::<u8>::new()), 3, 0, 3, 1).is_err());
        assert!(read_x_cursor(&mut Cursor::new(Vec::<u8>::new()), 0, 0, 513, 1).is_err());
        assert!(read_x_cursor(&mut Cursor::new(vec![0; 7]), 0, 0, 8, 1).is_err());
    }

    #[test]
    fn zero_sized_x_cursor_is_hidden_without_consuming_payload() {
        let mut reader = Cursor::new(vec![1, 2, 3]);
        let cursor = read_x_cursor(&mut reader, 12, 34, 0, 10).unwrap();
        assert_eq!((cursor.width, cursor.height), (0, 0));
        assert!(cursor.rgba.is_empty());
        assert_eq!(reader.position(), 0);
    }

    #[test]
    fn rgb_expansion_handles_the_last_pixel_without_overreading() {
        let src = [1u8, 2, 3, 4, 5, 6, 7, 8, 9];
        let mut dst = [0u8; 12];
        rgb_to_rgba(&src, &mut dst);
        assert_eq!(dst, [1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255]);
        let mut one = [0u8; 4];
        rgb_to_rgba(&src[..3], &mut one);
        assert_eq!(one, [1, 2, 3, 255]);
    }

    #[test]
    fn copyrect_source_reads_exactly_four_bytes() {
        let mut payload = Cursor::new(vec![0u8, 2, 0, 3, 9]);
        assert_eq!(read_copyrect_source(&mut payload).unwrap(), (2, 3));
        assert_eq!(payload.position(), 4);
    }

    #[test]
    fn hextile_raw_subencoding_reads_exact_bytes() {
        let mut payload = vec![HEXTILE_RAW]; // subenc byte
        payload.extend_from_slice(&[255, 0, 0, 0, 0, 255, 0, 0]); // 2 pixels
        // 2x1 rect, exactly one tile
        let mut cur = Cursor::new(&payload);
        let mut st = HextileState::new();
        let mut rgba = vec![0u8; 8];
        decode_hextile_into(
            &mut cur,
            2,
            1,
            &mut st,
            &PixelConverter::default(),
            &mut rgba,
        )
        .unwrap();
        // Alpha forced to 255.
        assert_eq!(rgba, vec![255, 0, 0, 255, 0, 255, 0, 255]);
        // No trailing bytes consumed from the cursor.
        assert_eq!(cur.position() as usize, payload.len());
    }

    #[test]
    fn hextile_bg_fg_persist_across_tiles() {
        // Two 16x1 tiles. First tile sets bg to red, no subrects. Second tile
        // has no bg flag and no subrects — should still paint red.
        let mut payload = Vec::new();
        payload.push(HEXTILE_BG_SPECIFIED);
        payload.extend_from_slice(&[255, 0, 0, 0]);
        payload.push(0);
        let mut cur = Cursor::new(&payload);
        let mut st = HextileState::new();
        let mut rgba = vec![0u8; 32 * 4];
        decode_hextile_into(
            &mut cur,
            32,
            1,
            &mut st,
            &PixelConverter::default(),
            &mut rgba,
        )
        .unwrap();
        for p in rgba.chunks_exact(4) {
            assert_eq!(p, &[255, 0, 0, 255]);
        }
    }

    #[test]
    fn hextile_subrects_paint_inside_their_tile_with_stride() {
        // 20x2 rect = tiles (16x2) and (4x2). Tile 2: bg blue, one fg subrect
        // at (1,1) size 2x1 in green; subrects must land at x=17..19, y=1.
        let mut payload = vec![HEXTILE_BG_SPECIFIED];
        payload.extend_from_slice(&[0, 0, 0, 0]);
        payload.push(HEXTILE_BG_SPECIFIED | HEXTILE_FG_SPECIFIED | HEXTILE_ANY_SUBRECTS);
        payload.extend_from_slice(&[0, 0, 255, 0]);
        payload.extend_from_slice(&[0, 255, 0, 0]);
        payload.push(1);
        payload.extend_from_slice(&[0x11, 0x10]);
        let mut st = HextileState::new();
        let mut rgba = vec![0u8; 20 * 2 * 4];
        decode_hextile_into(
            &mut Cursor::new(&payload),
            20,
            2,
            &mut st,
            &PixelConverter::default(),
            &mut rgba,
        )
        .unwrap();
        let px = |x: usize, y: usize| &rgba[(y * 20 + x) * 4..(y * 20 + x) * 4 + 4];
        assert_eq!(px(16, 0), &[0, 0, 255, 255]);
        assert_eq!(px(17, 1), &[0, 255, 0, 255]);
        assert_eq!(px(18, 1), &[0, 255, 0, 255]);
        assert_eq!(px(19, 1), &[0, 0, 255, 255]);
        assert_eq!(px(15, 1), &[0, 0, 0, 255]);
    }

    #[test]
    fn zrle_solid_tile_with_persistent_stream() {
        use flate2::Compression;
        use flate2::write::ZlibEncoder;
        use std::io::Write;

        // One 64x64 ZRLE tile, subenc=1 (solid), CPIXEL = [R,G,B] = [255,0,0].
        let uncompressed: Vec<u8> = vec![1u8, 255, 0, 0];
        let mut enc = ZlibEncoder::new(Vec::new(), Compression::default());
        enc.write_all(&uncompressed).unwrap();
        let compressed = enc.finish().unwrap();

        let mut payload = Vec::new();
        payload.extend_from_slice(&(compressed.len() as u32).to_be_bytes());
        payload.extend_from_slice(&compressed);

        let mut cur = Cursor::new(&payload);
        let mut dec = ZrleDecoder::new();
        let mut rgba = vec![0u8; 64 * 64 * 4];
        decode_zrle_into(
            &mut cur,
            64,
            64,
            &mut dec,
            &DecodeLimits::default(),
            &PixelConverter::default(),
            &mut rgba,
        )
        .unwrap();
        assert_eq!(rgba.len(), 64 * 64 * 4);
        for p in rgba.chunks_exact(4) {
            assert_eq!(p, &[255, 0, 0, 255]);
        }
    }

    #[test]
    fn zrle_plain_rle_with_run_length_continuation() {
        use flate2::Compression;
        use flate2::write::ZlibEncoder;
        use std::io::Write;

        // subenc=128, colour = green (0,255,0), run length = 1 + 255 + 0 = 256
        // (covers every pixel of a 16x16 tile == 256).
        let mut uncompressed = vec![128u8, 0, 255, 0];
        uncompressed.push(255); // keep reading
        uncompressed.push(0); // terminator
        let mut enc = ZlibEncoder::new(Vec::new(), Compression::default());
        enc.write_all(&uncompressed).unwrap();
        let compressed = enc.finish().unwrap();
        let mut payload = Vec::new();
        payload.extend_from_slice(&(compressed.len() as u32).to_be_bytes());
        payload.extend_from_slice(&compressed);

        let mut cur = Cursor::new(&payload);
        let mut dec = ZrleDecoder::new();
        let mut rgba = vec![0u8; 16 * 16 * 4];
        decode_zrle_into(
            &mut cur,
            16,
            16,
            &mut dec,
            &DecodeLimits::default(),
            &PixelConverter::default(),
            &mut rgba,
        )
        .unwrap();
        assert_eq!(rgba.len(), 16 * 16 * 4);
        for p in rgba.chunks_exact(4) {
            assert_eq!(p, &[0, 255, 0, 255]);
        }
    }

    #[test]
    fn zrle_preserves_zlib_state_across_rects() {
        // Two ZRLE rectangles share a single zlib stream. We build the stream
        // with two FlushCompress::Sync-delimited chunks so the inflater can
        // pause mid-stream and resume on the next rectangle.
        use flate2::{Compress, Compression, FlushCompress};

        fn emit(zlib: &mut Compress, input: &[u8]) -> Vec<u8> {
            let mut out = Vec::new();
            let in_before = zlib.total_in();
            let target_in = in_before + input.len() as u64;
            let mut src_pos = 0usize;

            // Loop until all input has been consumed AND the Sync flush has
            // flushed everything to the output buffer.
            loop {
                let mut scratch = vec![0u8; 256];
                let prod_before = zlib.total_out();
                zlib.compress(&input[src_pos..], &mut scratch, FlushCompress::Sync)
                    .unwrap();
                let produced = (zlib.total_out() - prod_before) as usize;
                out.extend_from_slice(&scratch[..produced]);
                src_pos = (zlib.total_in() - in_before) as usize;

                if zlib.total_in() == target_in && produced < scratch.len() {
                    break;
                }
                if produced == 0 {
                    break;
                }
            }
            out
        }

        let mut zlib = Compress::new(Compression::default(), true);
        let rect1 = emit(&mut zlib, &[1u8, 255, 0, 0]); // solid red tile
        let rect2 = emit(&mut zlib, &[1u8, 0, 0, 255]); // solid blue tile

        let mut payload1 = Vec::new();
        payload1.extend_from_slice(&(rect1.len() as u32).to_be_bytes());
        payload1.extend_from_slice(&rect1);
        let mut cur1 = Cursor::new(&payload1);
        let mut dec = ZrleDecoder::new();
        let mut rgba = vec![0u8; 64 * 64 * 4];
        decode_zrle_into(
            &mut cur1,
            64,
            64,
            &mut dec,
            &DecodeLimits::default(),
            &PixelConverter::default(),
            &mut rgba,
        )
        .unwrap();
        assert_eq!(rgba[0..4], [255, 0, 0, 255]);

        let mut payload2 = Vec::new();
        payload2.extend_from_slice(&(rect2.len() as u32).to_be_bytes());
        payload2.extend_from_slice(&rect2);
        let mut cur2 = Cursor::new(&payload2);
        decode_zrle_into(
            &mut cur2,
            64,
            64,
            &mut dec,
            &DecodeLimits::default(),
            &PixelConverter::default(),
            &mut rgba,
        )
        .unwrap();
        assert_eq!(rgba[0..4], [0, 0, 255, 255]);
    }

    #[test]
    fn zrle_large_rectangles_decode_through_the_overlapped_inflater() {
        use flate2::{Compress, Compression, FlushCompress};

        // 512x256 raw tiles of pseudo-random pixels: incompressible, so the
        // body exceeds the pipelined threshold. A second small rectangle on
        // the same zlib stream must still decode sequentially afterwards.
        let (w, h) = (512u16, 256u16);
        let mut seed = 0x1234_5678u32;
        let mut next = || {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            seed
        };
        let mut expected = vec![0u8; usize::from(w) * usize::from(h) * 4];
        let mut tiles = Vec::new();
        for ty in (0..h).step_by(64) {
            for tx in (0..w).step_by(64) {
                tiles.push(0u8);
                for y in ty..ty + 64 {
                    for x in tx..tx + 64 {
                        let value = next().to_le_bytes();
                        tiles.extend_from_slice(&value[..3]);
                        let at = (usize::from(y) * usize::from(w) + usize::from(x)) * 4;
                        expected[at..at + 4].copy_from_slice(&[value[0], value[1], value[2], 255]);
                    }
                }
            }
        }
        let mut stream = Compress::new(Compression::fast(), true);
        let mut emit = |input: &[u8]| {
            let mut out = vec![0u8; input.len() + input.len() / 10 + 1024];
            let before = stream.total_out();
            stream
                .compress(input, &mut out, FlushCompress::Sync)
                .unwrap();
            out.truncate((stream.total_out() - before) as usize);
            let mut payload = (out.len() as u32).to_be_bytes().to_vec();
            payload.extend(out);
            payload
        };
        let first = emit(&tiles);
        assert!(first.len() > ZRLE_PIPELINE_MIN_COMPRESSED);
        let second = emit(&[1, 9, 8, 7]);

        let mut dec = ZrleDecoder::new();
        let mut rgba = vec![0u8; expected.len()];
        decode_zrle_into(
            &mut Cursor::new(&first),
            w,
            h,
            &mut dec,
            &DecodeLimits::default(),
            &PixelConverter::default(),
            &mut rgba,
        )
        .unwrap();
        assert!(
            rgba == expected,
            "pipelined decode differs from the source pixels"
        );
        assert_eq!(dec.pos, 0);
        assert!(dec.buf.is_empty());

        let mut small = vec![0u8; 4 * 4 * 4];
        decode_zrle_into(
            &mut Cursor::new(&second),
            4,
            4,
            &mut dec,
            &DecodeLimits::default(),
            &PixelConverter::default(),
            &mut small,
        )
        .unwrap();
        assert!(small.chunks_exact(4).all(|p| p == [9, 8, 7, 255]));
    }

    #[test]
    fn zrle_decompresses_output_larger_than_initial_buffer() {
        // Regression for "zrle: eof cpixel": real ZRLE streams are a single
        // persistent zlib stream that spans the whole session, so the inflater
        // never sees a StreamEnd marker. It is NOT enough to stop decompressing
        // the moment the input slice is drained — the inflater can still have
        // bytes queued internally, and those need to be pulled out with one
        // more call (empty input) before we hand the buffer off to the tile
        // decoder. Otherwise the tile decoder runs off the end with `eof cpixel`.
        //
        // Build a rectangle whose tile stream is well over 64 KB and wrap it
        // in a Sync-flushed zlib frame (no StreamEnd), just like a real server
        // would transmit one rectangle within an ongoing session.
        use flate2::{Compress, Compression, FlushCompress};

        let rect_w: u16 = 256;
        let rect_h: u16 = 256;
        let tile_w: u16 = 64;
        let tile_h: u16 = 64;

        let mut uncompressed: Vec<u8> = Vec::new();
        let tiles_x = rect_w / tile_w;
        let tiles_y = rect_h / tile_h;
        for _ in 0..tiles_y {
            for _ in 0..tiles_x {
                uncompressed.push(0u8); // subenc = raw CPIXEL stream
                for _ in 0..(tile_w as usize * tile_h as usize) {
                    // Distinctive colour so we detect any byte-alignment bug.
                    uncompressed.extend_from_slice(&[0x12, 0x34, 0x56]);
                }
            }
        }
        assert!(uncompressed.len() > 64 * 1024);

        // Compress with Sync flush so the output is complete but the stream
        // is NOT terminated (zlib would otherwise emit StreamEnd, which hides
        // the bug via an early loop exit).
        let mut zlib = Compress::new(Compression::default(), true);
        let mut compressed: Vec<u8> = Vec::new();
        let mut src_pos = 0usize;
        loop {
            let mut scratch = vec![0u8; 32 * 1024];
            let in_before = zlib.total_in();
            let out_before = zlib.total_out();
            zlib.compress(&uncompressed[src_pos..], &mut scratch, FlushCompress::Sync)
                .unwrap();
            let consumed = (zlib.total_in() - in_before) as usize;
            let produced = (zlib.total_out() - out_before) as usize;
            compressed.extend_from_slice(&scratch[..produced]);
            src_pos += consumed;
            if src_pos >= uncompressed.len() && produced < scratch.len() {
                break;
            }
            if consumed == 0 && produced == 0 {
                break;
            }
        }

        let mut payload = Vec::new();
        payload.extend_from_slice(&(compressed.len() as u32).to_be_bytes());
        payload.extend_from_slice(&compressed);

        let mut cur = Cursor::new(&payload);
        let mut dec = ZrleDecoder::new();
        let mut rgba = vec![0u8; rect_w as usize * rect_h as usize * 4];
        decode_zrle_into(
            &mut cur,
            rect_w,
            rect_h,
            &mut dec,
            &DecodeLimits::default(),
            &PixelConverter::default(),
            &mut rgba,
        )
        .unwrap();
        assert_eq!(
            dec.pos, 0,
            "every inflated byte of the {tiles_x}x{tiles_y} tiles is consumed"
        );
        for p in rgba.chunks_exact(4) {
            assert_eq!(p, &[0x12, 0x34, 0x56, 255]);
        }
    }
}
