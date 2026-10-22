use super::pixels::check_scratch;
use super::pixels::fill_block;
use super::pixels::read_u32_be;
use super::pixels::rgb_to_rgba;
use crate::vnc::limits::DecodeLimits;
use crate::vnc::pixel::PixelConverter;
use std::io::Read;
use zlib_rs::Inflate;
use zlib_rs::InflateFlush;

// ── ZRLE encoding (type 16) ────────────────────────────────────────

/// Persistent ZRLE zlib stream. RFB keeps a single zlib stream that spans
/// every ZRLE rectangle in the session, so the decoder state cannot be
/// discarded between rectangles.
pub struct ZrleDecoder {
    /// zlib-rs: ~1.7x the inflate throughput of the stock zlib that flate2
    /// resolves to here (VNC-PERF-003).
    pub(super) inflater: Inflate,
    /// Decompressed bytes already produced but not yet consumed by a tile.
    pub(super) buf: Vec<u8>,
    /// Read cursor into `buf`.
    pub(super) pos: usize,
    /// Reused compressed-body buffer.
    pub(super) compressed: Vec<u8>,
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
pub(super) const ZRLE_PIPELINE_MIN_COMPRESSED: usize = 256 * 1024;
/// Inflate output handed to the tile decoder per step.
pub(super) const ZRLE_PIPELINE_CHUNK: usize = 256 * 1024;

/// Upper bound of the inflated bytes of one ZRLE rectangle: per tile one
/// subencoding byte and a 127-colour palette, per pixel at most a CPIXEL plus
/// one run-length byte. A valid stream never produces more.
pub(super) fn zrle_inflated_bound(rect_w: u16, rect_h: u16, cpixel: usize) -> usize {
    let tiles = usize::from(rect_w).div_ceil(64) * usize::from(rect_h).div_ceil(64);
    tiles * (1 + 127 * cpixel) + usize::from(rect_w) * usize::from(rect_h) * (cpixel + 1)
}

/// VNC-PERF-003: overlap inflate (helper thread) with tile decoding (this
/// thread). The inflater writes into reserved capacity that is never
/// reallocated; the decoder only reads bytes the inflater has published with
/// a Release store, so producer and consumer touch disjoint memory. A tile
/// that runs out of published bytes is decoded again once more arrive.
pub(super) fn decode_zrle_pipelined(
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
pub(super) fn inflate_into(
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
pub(super) fn zrle_decode_tile(
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
pub(super) fn read_cpixel(
    buf: &[u8],
    pos: &mut usize,
    conv: &PixelConverter,
) -> Result<[u8; 4], String> {
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
pub(super) fn read_zrle_run_length(buf: &[u8], pos: &mut usize) -> Result<usize, String> {
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
