//! Tight encoding (type 7) decoder, following the RFB community
//! specification: four persistent zlib streams selected per rectangle, fill,
//! JPEG and basic compression with the copy, palette and gradient filters.
//! TightPNG (compression type 10) is not requested and is rejected.

use std::io::Read;

use zlib_rs::{Inflate, InflateFlush};

use crate::vnc::limits::DecodeLimits;
use crate::vnc::pixel::PixelConverter;

pub const ENCODING_TIGHT: i32 = 7;
/// `-32 + level` selects JPEG quality 0..=9 (Tight "quality level").
pub const ENCODING_JPEG_QUALITY_0: i32 = -32;
/// `-256 + level` selects zlib compression 0..=9 (Tight "compress level").
pub const ENCODING_COMPRESS_LEVEL_0: i32 = -256;

const COMPRESSION_FILL: u8 = 0x08;
const COMPRESSION_JPEG: u8 = 0x09;
const FILTER_COPY: u8 = 0;
const FILTER_PALETTE: u8 = 1;
const FILTER_GRADIENT: u8 = 2;
/// Data shorter than this is sent without zlib.
const MIN_TO_COMPRESS: usize = 12;

/// Per-session Tight state: the four zlib streams persist across rectangles
/// until the server asks for a reset in the compression-control byte.
pub struct TightDecoder {
    streams: [Inflate; 4],
    compressed: Vec<u8>,
    data: Vec<u8>,
}

impl TightDecoder {
    pub fn new() -> Self {
        Self {
            streams: std::array::from_fn(|_| Inflate::new(true, 15)),
            compressed: Vec::new(),
            data: Vec::new(),
        }
    }
}

impl Default for TightDecoder {
    fn default() -> Self {
        Self::new()
    }
}

fn read_u8<R: Read>(r: &mut R, what: &str) -> Result<u8, String> {
    let mut byte = [0u8; 1];
    r.read_exact(&mut byte)
        .map_err(|e| format!("tight: {what}: {e}"))?;
    Ok(byte[0])
}

/// Tight "compact length": 7 bits per byte, little-endian, up to 22 bits.
fn read_compact_length<R: Read>(r: &mut R) -> Result<usize, String> {
    let b0 = read_u8(r, "length")?;
    let mut len = usize::from(b0 & 0x7F);
    if b0 & 0x80 != 0 {
        let b1 = read_u8(r, "length")?;
        len |= usize::from(b1 & 0x7F) << 7;
        if b1 & 0x80 != 0 {
            len |= usize::from(read_u8(r, "length")?) << 14;
        }
    }
    Ok(len)
}

fn tpixel_bytes(conv: &PixelConverter) -> usize {
    if conv.format().tpixel_is_rgb() {
        3
    } else {
        conv.bytes_per_pixel()
    }
}

#[inline]
fn tpixel(conv: &PixelConverter, src: &[u8]) -> [u8; 4] {
    if conv.format().tpixel_is_rgb() {
        [src[0], src[1], src[2], 255]
    } else {
        conv.pixel(src)
    }
}

/// Decode one Tight rectangle into `out` (`w*h*4` RGBA bytes).
pub fn decode_tight_into<R: Read>(
    r: &mut R,
    w: u16,
    h: u16,
    dec: &mut TightDecoder,
    limits: &DecodeLimits,
    conv: &PixelConverter,
    out: &mut [u8],
) -> Result<(), String> {
    let (width, height) = (usize::from(w), usize::from(h));
    if out.len() != width * height * 4 {
        return Err("tight: scratch buffer does not match the rectangle".into());
    }
    let control = read_u8(r, "compression control")?;
    for (index, stream) in dec.streams.iter_mut().enumerate() {
        if control & (1 << index) != 0 {
            *stream = Inflate::new(true, 15);
        }
    }
    let compression = control >> 4;
    let tpx = tpixel_bytes(conv);

    if compression == COMPRESSION_FILL {
        let mut pixel = [0u8; 4];
        r.read_exact(&mut pixel[..tpx])
            .map_err(|e| format!("tight: fill colour: {e}"))?;
        let colour = tpixel(conv, &pixel[..tpx]);
        for dst in out.chunks_exact_mut(4) {
            dst.copy_from_slice(&colour);
        }
        return Ok(());
    }

    if compression == COMPRESSION_JPEG {
        let len = read_compact_length(r)?;
        limits
            .compressed_bytes(len as u32)
            .map_err(|e| e.to_string())?;
        dec.compressed.clear();
        dec.compressed.resize(len, 0);
        r.read_exact(&mut dec.compressed)
            .map_err(|e| format!("tight: jpeg data: {e}"))?;
        return decode_jpeg(&dec.compressed, width, height, out);
    }

    if compression & 0x08 != 0 {
        return Err(format!("tight: unsupported compression type {compression}"));
    }

    // Basic compression: stream id in bits 4-5, explicit filter in bit 6.
    let stream_id = usize::from(compression & 0x03);
    let filter = if compression & 0x04 != 0 {
        read_u8(r, "filter id")?
    } else {
        FILTER_COPY
    };
    let mut palette = [[0u8; 4]; 256];
    let mut palette_len = 0usize;
    let data_len = match filter {
        FILTER_COPY | FILTER_GRADIENT => {
            if filter == FILTER_GRADIENT && conv.bytes_per_pixel() == 1 {
                return Err("tight: gradient filter needs a 16 or 32 bpp format".into());
            }
            width * height * tpx
        }
        FILTER_PALETTE => {
            palette_len = usize::from(read_u8(r, "palette size")?) + 1;
            let mut raw = vec![0u8; palette_len * tpx];
            r.read_exact(&mut raw)
                .map_err(|e| format!("tight: palette: {e}"))?;
            for (slot, src) in palette.iter_mut().zip(raw.chunks_exact(tpx)) {
                *slot = tpixel(conv, src);
            }
            if palette_len == 2 {
                width.div_ceil(8) * height
            } else {
                width * height
            }
        }
        other => return Err(format!("tight: unknown filter {other}")),
    };
    if data_len > limits.max_decompressed_rect_bytes {
        return Err("tight: decompressed rectangle exceeds configured limit".into());
    }

    read_basic_data(r, dec, stream_id, data_len, limits)?;
    let data = &dec.data;
    match filter {
        FILTER_COPY => {
            if tpx == 3 {
                crate::vnc::encodings::rgb_to_rgba(data, out);
            } else {
                conv.convert_row(data, out);
            }
        }
        FILTER_PALETTE => {
            if palette_len == 2 {
                let row_bytes = width.div_ceil(8);
                for y in 0..height {
                    let row = &data[y * row_bytes..(y + 1) * row_bytes];
                    let dst_row = &mut out[y * width * 4..(y + 1) * width * 4];
                    for (x, dst) in dst_row.chunks_exact_mut(4).enumerate() {
                        let bit = (row[x / 8] >> (7 - (x % 8))) & 1;
                        dst.copy_from_slice(&palette[usize::from(bit)]);
                    }
                }
            } else {
                for (dst, index) in out.chunks_exact_mut(4).zip(data.iter()) {
                    let index = usize::from(*index);
                    let colour = if index < palette_len {
                        palette[index]
                    } else {
                        [0, 0, 0, 255]
                    };
                    dst.copy_from_slice(&colour);
                }
            }
        }
        _ => apply_gradient(data, width, height, tpx, conv, out),
    }
    Ok(())
}

/// Read `data_len` filtered bytes into `dec.data`: raw when shorter than 12
/// bytes, otherwise zlib data from the selected persistent stream.
fn read_basic_data<R: Read>(
    r: &mut R,
    dec: &mut TightDecoder,
    stream_id: usize,
    data_len: usize,
    limits: &DecodeLimits,
) -> Result<(), String> {
    dec.data.clear();
    dec.data.resize(data_len, 0);
    if data_len < MIN_TO_COMPRESS {
        return r
            .read_exact(&mut dec.data)
            .map_err(|e| format!("tight: raw data: {e}"));
    }
    let len = read_compact_length(r)?;
    limits
        .compressed_bytes(len as u32)
        .map_err(|e| e.to_string())?;
    dec.compressed.clear();
    dec.compressed.resize(len, 0);
    r.read_exact(&mut dec.compressed)
        .map_err(|e| format!("tight: zlib data: {e}"))?;
    let stream = &mut dec.streams[stream_id];
    let mut consumed = 0usize;
    let mut produced = 0usize;
    while produced < data_len {
        let in_before = stream.total_in();
        let out_before = stream.total_out();
        stream
            .decompress(
                &dec.compressed[consumed..],
                &mut dec.data[produced..],
                InflateFlush::SyncFlush,
            )
            .map_err(|e| format!("tight: inflate: {}", e.as_str()))?;
        let used = (stream.total_in() - in_before) as usize;
        let made = (stream.total_out() - out_before) as usize;
        consumed += used;
        produced += made;
        if used == 0 && made == 0 {
            break;
        }
    }
    if produced != data_len {
        return Err(format!(
            "tight: zlib stream {stream_id} produced {produced} of {data_len} bytes"
        ));
    }
    Ok(())
}

/// Reverse the Tight gradient filter: each component is predicted as
/// `left + up - up_left` (clamped) and the stream carries the difference.
fn apply_gradient(
    data: &[u8],
    width: usize,
    height: usize,
    tpx: usize,
    conv: &PixelConverter,
    out: &mut [u8],
) {
    let format = conv.format();
    let (maxes, shifts): ([u32; 3], [u8; 3]) = if tpx == 3 {
        ([255; 3], [0, 8, 16])
    } else {
        (
            [
                u32::from(format.red_max),
                u32::from(format.green_max),
                u32::from(format.blue_max),
            ],
            [format.red_shift, format.green_shift, format.blue_shift],
        )
    };
    let read_value = |src: &[u8]| -> u32 {
        match tpx {
            3 => u32::from(src[0]) | (u32::from(src[1]) << 8) | (u32::from(src[2]) << 16),
            2 if format.big_endian => u32::from(u16::from_be_bytes([src[0], src[1]])),
            2 => u32::from(u16::from_le_bytes([src[0], src[1]])),
            _ if format.big_endian => u32::from_be_bytes([src[0], src[1], src[2], src[3]]),
            _ => u32::from_le_bytes([src[0], src[1], src[2], src[3]]),
        }
    };
    let mut previous = vec![[0u32; 3]; width];
    let mut current = vec![[0u32; 3]; width];
    for y in 0..height {
        let mut left = [0u32; 3];
        let mut up_left = [0u32; 3];
        for x in 0..width {
            let offset = (y * width + x) * tpx;
            let value = read_value(&data[offset..offset + tpx]);
            let up = previous[x];
            let mut pixel = [0u32; 3];
            for c in 0..3 {
                let predicted = (i64::from(left[c]) + i64::from(up[c]) - i64::from(up_left[c]))
                    .clamp(0, i64::from(maxes[c])) as u32;
                let diff = (value >> shifts[c]) & maxes[c];
                pixel[c] = (predicted + diff) & maxes[c];
            }
            current[x] = pixel;
            up_left = up;
            left = pixel;
            let rgba = if tpx == 3 {
                [pixel[0] as u8, pixel[1] as u8, pixel[2] as u8, 255]
            } else {
                format.value_to_rgba(
                    (pixel[0] << shifts[0]) | (pixel[1] << shifts[1]) | (pixel[2] << shifts[2]),
                )
            };
            out[(y * width + x) * 4..(y * width + x) * 4 + 4].copy_from_slice(&rgba);
        }
        std::mem::swap(&mut previous, &mut current);
    }
}

fn decode_jpeg(data: &[u8], width: usize, height: usize, out: &mut [u8]) -> Result<(), String> {
    use zune_core::bytestream::ZCursor;
    use zune_core::colorspace::ColorSpace;
    use zune_core::options::DecoderOptions;

    let options = DecoderOptions::default().jpeg_set_out_colorspace(ColorSpace::RGBA);
    let mut decoder = zune_jpeg::JpegDecoder::new_with_options(ZCursor::new(data), options);
    decoder
        .decode_headers()
        .map_err(|e| format!("tight: jpeg header: {e:?}"))?;
    let info = decoder
        .info()
        .ok_or_else(|| "tight: jpeg header missing".to_string())?;
    if usize::from(info.width) != width || usize::from(info.height) != height {
        return Err(format!(
            "tight: jpeg is {}x{}, rectangle is {width}x{height}",
            info.width, info.height
        ));
    }
    decoder
        .decode_into(out)
        .map_err(|e| format!("tight: jpeg decode: {e:?}"))?;
    for pixel in out.chunks_exact_mut(4) {
        pixel[3] = 255;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io::{Cursor, Write};

    use flate2::write::ZlibEncoder;
    use flate2::{Compress, Compression, FlushCompress};

    use super::*;
    use crate::vnc::pixel::PixelFormat;

    fn compact(len: usize) -> Vec<u8> {
        let mut out = vec![(len & 0x7F) as u8];
        if len > 0x7F {
            out[0] |= 0x80;
            out.push(((len >> 7) & 0x7F) as u8);
            if len > 0x3FFF {
                out[1] |= 0x80;
                out.push((len >> 14) as u8);
            }
        }
        out
    }

    fn sync_compress(stream: &mut Compress, data: &[u8]) -> Vec<u8> {
        let mut out = vec![0u8; data.len() * 2 + 64];
        let before = stream.total_out();
        stream
            .compress(data, &mut out, FlushCompress::Sync)
            .unwrap();
        out.truncate((stream.total_out() - before) as usize);
        out
    }

    fn decode(payload: &[u8], w: u16, h: u16, dec: &mut TightDecoder) -> Result<Vec<u8>, String> {
        let mut out = vec![0u8; usize::from(w) * usize::from(h) * 4];
        decode_tight_into(
            &mut Cursor::new(payload),
            w,
            h,
            dec,
            &DecodeLimits::default(),
            &PixelConverter::default(),
            &mut out,
        )?;
        Ok(out)
    }

    #[test]
    fn compact_length_uses_one_to_three_bytes() {
        for len in [0usize, 127, 128, 16_383, 16_384, 4_194_303] {
            let bytes = compact(len);
            assert_eq!(read_compact_length(&mut Cursor::new(bytes)).unwrap(), len);
        }
    }

    #[test]
    fn fill_uses_a_three_byte_tpixel() {
        let mut dec = TightDecoder::new();
        let out = decode(&[0x80, 10, 20, 30], 2, 2, &mut dec).unwrap();
        assert!(out.chunks_exact(4).all(|p| p == [10, 20, 30, 255]));
    }

    #[test]
    fn short_copy_data_is_sent_uncompressed() {
        // 2x1 pixels = 6 bytes < 12: no length prefix, no zlib.
        let mut dec = TightDecoder::new();
        let out = decode(&[0x00, 1, 2, 3, 4, 5, 6], 2, 1, &mut dec).unwrap();
        assert_eq!(out, vec![1, 2, 3, 255, 4, 5, 6, 255]);
    }

    #[test]
    fn copy_filter_streams_stay_in_sync_across_rectangles() {
        let mut stream = Compress::new(Compression::default(), true);
        let first: Vec<u8> = (0..48u8).collect();
        let second: Vec<u8> = (100..148u8).collect();
        let mut payload = vec![0x00];
        let packed = sync_compress(&mut stream, &first);
        payload.extend(compact(packed.len()));
        payload.extend(packed);
        let mut dec = TightDecoder::new();
        let out = decode(&payload, 4, 4, &mut dec).unwrap();
        assert_eq!(&out[..4], &[0, 1, 2, 255]);
        // Same stream 0 continues without a reset.
        let mut payload = vec![0x00];
        let packed = sync_compress(&mut stream, &second);
        payload.extend(compact(packed.len()));
        payload.extend(packed);
        let out = decode(&payload, 4, 4, &mut dec).unwrap();
        assert_eq!(&out[..4], &[100, 101, 102, 255]);
        // A reset bit discards the stream state; a fresh server stream decodes.
        let mut fresh = Compress::new(Compression::default(), true);
        let mut payload = vec![0x01];
        let packed = sync_compress(&mut fresh, &first);
        payload.extend(compact(packed.len()));
        payload.extend(packed);
        let out = decode(&payload, 4, 4, &mut dec).unwrap();
        assert_eq!(&out[4..8], &[3, 4, 5, 255]);
    }

    #[test]
    fn two_colour_palette_unpacks_msb_first_rows() {
        // Stream 1, explicit filter: palette of 2, rows of 10 pixels = 2 bytes.
        let mut payload = vec![0x40 | 0x10, FILTER_PALETTE, 1, 0, 0, 0, 255, 255, 255];
        payload.extend([0b1010_0000, 0b1100_0000]); // 2 bytes < 12: raw
        let mut dec = TightDecoder::new();
        let out = decode(&payload, 10, 1, &mut dec).unwrap();
        let bits: Vec<u8> = out.chunks_exact(4).map(|p| u8::from(p[0] == 255)).collect();
        assert_eq!(bits, vec![1, 0, 1, 0, 0, 0, 0, 0, 1, 1]);
    }

    #[test]
    fn indexed_palette_and_gradient_filters_decode() {
        let mut dec = TightDecoder::new();
        let mut zlib = ZlibEncoder::new(Vec::new(), Compression::default());
        let indices: Vec<u8> = (0..16).map(|i| (i % 3) as u8).collect();
        zlib.write_all(&indices).unwrap();
        let packed = zlib.finish().unwrap();
        let mut payload = vec![0x40 | 0x20, FILTER_PALETTE, 2, 1, 1, 1, 2, 2, 2, 3, 3, 3];
        payload.extend(compact(packed.len()));
        payload.extend(packed);
        let out = decode(&payload, 4, 4, &mut dec).unwrap();
        assert_eq!(&out[..12], &[1, 1, 1, 255, 2, 2, 2, 255, 3, 3, 3, 255]);

        // Gradient over a horizontal ramp: the first pixel carries the value,
        // the rest differ from the prediction by +10 per step.
        let pixels: Vec<[u8; 3]> = (0..4).map(|x| [10 * (x + 1) as u8, 0, 0]).collect();
        let mut diffs = Vec::new();
        let mut left = [0i32; 3];
        for pixel in &pixels {
            for c in 0..3 {
                diffs.push((i32::from(pixel[c]) - left[c]) as u8);
            }
            left = [
                i32::from(pixel[0]),
                i32::from(pixel[1]),
                i32::from(pixel[2]),
            ];
        }
        let mut payload = vec![0x40 | 0x30, FILTER_GRADIENT];
        // 12 bytes: compressed with a fresh stream 3.
        let mut zlib = ZlibEncoder::new(Vec::new(), Compression::default());
        zlib.write_all(&diffs).unwrap();
        let packed = zlib.finish().unwrap();
        payload.extend(compact(packed.len()));
        payload.extend(packed);
        let out = decode(&payload, 4, 1, &mut dec).unwrap();
        let reds: Vec<u8> = out.chunks_exact(4).map(|p| p[0]).collect();
        assert_eq!(reds, vec![10, 20, 30, 40]);
    }

    #[test]
    fn reduced_colour_tpixel_is_a_full_pixel() {
        let conv = PixelConverter::new(PixelFormat::RGB222);
        let mut out = vec![0u8; 4];
        decode_tight_into(
            &mut Cursor::new([0x80, 0b11_00_00]),
            1,
            1,
            &mut TightDecoder::new(),
            &DecodeLimits::default(),
            &conv,
            &mut out,
        )
        .unwrap();
        assert_eq!(out, vec![255, 0, 0, 255]);
    }

    #[test]
    fn jpeg_rectangle_decodes_to_rgba() {
        let mut jpeg = Vec::new();
        let rgb: Vec<u8> = (0..16 * 8).flat_map(|_| [200u8, 40, 40]).collect();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 90)
            .encode(&rgb, 16, 8, image::ExtendedColorType::Rgb8)
            .unwrap();
        let mut payload = vec![0x90];
        payload.extend(compact(jpeg.len()));
        payload.extend(&jpeg);
        let out = decode(&payload, 16, 8, &mut TightDecoder::new()).unwrap();
        let pixel = &out[..4];
        assert!(
            pixel[0] > 180 && pixel[1] < 70 && pixel[3] == 255,
            "{pixel:?}"
        );
        // A size mismatch is a protocol error, not a partial paint.
        assert!(decode(&payload, 8, 8, &mut TightDecoder::new()).is_err());
    }

    #[test]
    fn unknown_filter_and_png_are_rejected() {
        assert!(decode(&[0x40, 7], 2, 2, &mut TightDecoder::new()).is_err());
        assert!(decode(&[0xA0, 0], 2, 2, &mut TightDecoder::new()).is_err());
    }
}
