use core::num::NonZeroUsize;

use ironrdp_core::{
    Encode as _, WriteCursor, cast_int, cast_length, invalid_field_err, not_enough_bytes_err,
};
use ironrdp_graphics::image_processing::PixelFormat;
use ironrdp_graphics::rdp6::{
    ABgrChannels, ARgbChannels, BgrAChannels, BitmapEncodeError, BitmapStreamEncoder, RgbAChannels,
};
use ironrdp_pdu::bitmap::rdp6::{BitmapStreamHeader, ColorPlaneDefinition};
use ironrdp_pdu::bitmap::{self, BitmapData, BitmapUpdateData, Compression};
use ironrdp_pdu::geometry::InclusiveRectangle;

use crate::BitmapUpdate;

// PERF: we could also remove the need for this buffer
#[derive(Clone)]
pub(crate) struct BitmapEncoder {
    buffer: Vec<u8>,
    byte_scan_width: bool,
}

impl BitmapEncoder {
    pub(crate) fn new() -> Self {
        Self {
            buffer: vec![0; usize::from(u16::MAX)],
            byte_scan_width: false,
        }
    }

    pub(crate) fn for_bulk_compression() -> Self {
        Self {
            byte_scan_width: true,
            ..Self::new()
        }
    }

    pub(crate) fn output_size_hint(&self, bitmap: &BitmapUpdate) -> usize {
        let pixels = usize::from(bitmap.width.get()) * usize::from(bitmap.height.get());
        if self.byte_scan_width {
            // Raw RGB planes need 3 B/pixel; RLE's literal overhead fits in
            // 4 B/pixel. Allow bitmap/planar headers even for one-row chunks.
            pixels * 4 + usize::from(bitmap.height.get()) * 32
        } else {
            bitmap.data.len() * 2
        }
    }

    pub(crate) fn raw_planar_sample(
        &self,
        bitmap: &BitmapUpdate,
    ) -> Result<Option<(usize, Vec<u8>)>, BitmapEncodeError> {
        if !self.byte_scan_width || has_repeated_pixels(bitmap) {
            return Ok(None);
        }
        // Raw planar has an exact size and byte layout. Read the same four
        // strips as the materialized candidate without allocating/writing all
        // three planes of a photo that RemoteFX will usually beat.
        let width = usize::from(bitmap.width.get());
        let row_len = bitmap.width.get().checked_mul(4).ok_or_else(|| {
            BitmapEncodeError::Encode(invalid_field_err!("bitmap", "Row size exceeds u16"))
        })?;
        let chunk_height = usize::from(u16::MAX / row_len);
        let stride = bitmap.stride.get();
        let chunks: Vec<_> = bitmap.data.chunks(stride * chunk_height).collect();
        let mut update_header = [0; 4];
        BitmapUpdateData::encode_header(
            cast_length!("rectangle count", chunks.len()).map_err(BitmapEncodeError::Encode)?,
            &mut WriteCursor::new(&mut update_header),
        )
        .map_err(BitmapEncodeError::Encode)?;
        let mut headers = Vec::with_capacity(chunks.len());
        let mut length = update_header.len();
        for (index, chunk) in chunks.iter().enumerate() {
            let height = chunk.len().div_ceil(stride);
            let body_size = width * height * 3 + 2; // planar header and pad
            // BitmapStreamHeader checks two bytes of capacity but writes one
            // for ARGB. Keep its actual length separate from that capacity.
            let mut header = [0; 28];
            let mut cursor = WriteCursor::new(&mut header);
            let top = bitmap.y + (index * chunk_height) as u16;
            InclusiveRectangle {
                left: bitmap.x,
                top,
                right: bitmap.x + bitmap.width.get() - 1,
                bottom: top + height as u16 - 1,
            }
            .encode(&mut cursor)
            .map_err(BitmapEncodeError::Encode)?;
            cursor.write_u16(bitmap.width.get());
            cursor.write_u16(height as u16);
            cursor.write_u16(32);
            cursor.write_u16(Compression::BITMAP_COMPRESSION.bits());
            cursor.write_u16((body_size + bitmap::CompressedDataHeader::ENCODED_SIZE) as u16);
            bitmap::CompressedDataHeader {
                main_body_size: body_size as u16,
                scan_width: row_len,
                uncompressed_size: height as u16 * row_len,
            }
            .encode(&mut cursor)
            .map_err(BitmapEncodeError::Encode)?;
            BitmapStreamHeader {
                enable_rle_compression: false,
                use_alpha: false,
                color_plane_definition: ColorPlaneDefinition::Argb,
            }
            .encode(&mut cursor)
            .map_err(BitmapEncodeError::Encode)?;
            let header_len = cursor.pos();
            headers.push((header, header_len, height));
            length += 28 + width * height * 3;
        }
        let channels = match bitmap.format {
            PixelFormat::ARgb32 | PixelFormat::XRgb32 => [1, 2, 3],
            PixelFormat::RgbA32 | PixelFormat::RgbX32 => [0, 1, 2],
            PixelFormat::ABgr32 | PixelFormat::XBgr32 => [3, 2, 1],
            PixelFormat::BgrA32 | PixelFormat::BgrX32 => [2, 1, 0],
        };
        let byte_at = |position: usize| {
            if position < update_header.len() {
                return update_header[position];
            }
            let position = position - update_header.len();
            let full_chunk_size = 28 + width * chunk_height * 3;
            let index = position / full_chunk_size;
            let position = position % full_chunk_size;
            let (header, header_len, height) = &headers[index];
            if position < *header_len {
                return header[position];
            }
            let position = position - header_len;
            let pixels = width * height;
            if position == pixels * 3 {
                return 0; // raw planar trailing pad
            }
            let channel = channels[position / pixels];
            let pixel = position % pixels;
            let offset = (height - pixel / width - 1) * stride + pixel % width * 4;
            chunks[index][offset + channel]
        };
        let sample_len = length.min(super::PLANAR_ESTIMATE_SAMPLE_SIZE);
        let mut sample = vec![0; sample_len];
        for (index, byte) in sample.iter_mut().enumerate() {
            let position = if length <= sample_len {
                index
            } else {
                let strip = sample_len / 4;
                (index / strip) * (length - strip) / 3 + index % strip
            };
            *byte = byte_at(position);
        }
        Ok(Some((length, sample)))
    }

    pub(crate) fn encode(
        &mut self,
        bitmap: &BitmapUpdate,
        output: &mut [u8],
    ) -> Result<usize, BitmapEncodeError> {
        // cbScanWidth is the uncompressed row size in bytes, not pixels
        // (MS-RDPBCGR 2.2.9.1.1.3.1.2.3). Every 32-bpp row is aligned,
        // including odd-width XDamage rectangles. Keep the legacy header
        // only on the unchanged, non-bulk path.
        if !self.byte_scan_width && !bitmap.width.get().is_multiple_of(4) {
            return Err(BitmapEncodeError::Encode(invalid_field_err!(
                "bitmap",
                "Width must be a multiple of 4"
            )));
        }

        let bytes_per_pixel = u16::from(bitmap.format.bytes_per_pixel());
        // RLE is useful for repeated horizontal colours or vertical deltas.
        // On noisy pixels its literal/run search costs more than RemoteFX
        // itself. Use the standard lossless raw planar representation for
        // those pixels; the adaptive selector still compares compressed sizes.
        // This choice is restricted to the new bulk path.
        let rle = !self.byte_scan_width || has_repeated_pixels(bitmap);
        let row_len = bitmap
            .width
            .get()
            .checked_mul(bytes_per_pixel)
            .ok_or_else(|| {
                BitmapEncodeError::Encode(invalid_field_err!("bitmap", "Row size exceeds u16"))
            })?;
        let chunk_height = u16::MAX / row_len;

        let mut cursor = WriteCursor::new(output);
        let stride = bitmap.stride.get();
        let chunks = bitmap.data.chunks(stride * usize::from(chunk_height));

        let total = cast_int!("chunks length lower bound", chunks.size_hint().0)
            .map_err(BitmapEncodeError::Encode)?;
        BitmapUpdateData::encode_header(total, &mut cursor).map_err(BitmapEncodeError::Encode)?;

        for (i, chunk) in chunks.enumerate() {
            // A cropped dirty rectangle keeps its parent stride, but its last
            // row ends at the crop's width. That partial stride is a full row.
            let rows = if self.byte_scan_width {
                chunk.len().div_ceil(stride)
            } else {
                chunk.len() / stride
            };
            let height = cast_int!("bitmap height", rows).map_err(BitmapEncodeError::Encode)?;
            let i: u16 = cast_int!("chunk idx", i).map_err(BitmapEncodeError::Encode)?;
            let top = bitmap.y + i * chunk_height;

            let encoder = BitmapStreamEncoder::new(
                NonZeroUsize::from(bitmap.width).get(),
                usize::from(height),
            );

            let len = if !rle {
                encode_raw_chunk(
                    bitmap.format,
                    chunk,
                    stride,
                    usize::from(row_len),
                    usize::from(height),
                    &mut self.buffer,
                )?
            } else {
                let pixels = chunk
                    .chunks(stride)
                    .map(|row| &row[..usize::from(row_len)])
                    .rev()
                    .flat_map(|row| row.chunks(usize::from(bytes_per_pixel)));

                Self::encode_iter(
                    encoder,
                    bitmap.format,
                    pixels,
                    self.buffer.as_mut_slice(),
                    rle,
                )?
            };

            let data = BitmapData {
                rectangle: InclusiveRectangle {
                    left: bitmap.x,
                    top,
                    right: bitmap.x + bitmap.width.get() - 1,
                    bottom: top + height - 1,
                },
                width: u16::from(bitmap.width),
                height,
                bits_per_pixel: u16::from(bitmap.format.bytes_per_pixel()) * 8,
                compression_flags: Compression::BITMAP_COMPRESSION,
                compressed_data_header: Some(bitmap::CompressedDataHeader {
                    main_body_size: cast_length!("main body size", len)
                        .map_err(BitmapEncodeError::Encode)?,
                    scan_width: if self.byte_scan_width {
                        row_len
                    } else {
                        u16::from(bitmap.width)
                    },
                    uncompressed_size: height * row_len,
                }),
                bitmap_data: &self.buffer[..len],
            };

            data.encode(&mut cursor)
                .map_err(BitmapEncodeError::Encode)?;
        }

        Ok(cursor.pos())
    }

    fn encode_iter<'a, P>(
        mut encoder: BitmapStreamEncoder,
        format: PixelFormat,
        src: P,
        dst: &mut [u8],
        rle: bool,
    ) -> Result<usize, BitmapEncodeError>
    where
        P: Iterator<Item = &'a [u8]> + Clone,
    {
        let written = match format {
            PixelFormat::ARgb32 | PixelFormat::XRgb32 => {
                encoder.encode_pixels_stream::<_, ARgbChannels>(src, dst, rle)?
            }
            PixelFormat::RgbA32 | PixelFormat::RgbX32 => {
                encoder.encode_pixels_stream::<_, RgbAChannels>(src, dst, rle)?
            }
            PixelFormat::ABgr32 | PixelFormat::XBgr32 => {
                encoder.encode_pixels_stream::<_, ABgrChannels>(src, dst, rle)?
            }
            PixelFormat::BgrA32 | PixelFormat::BgrX32 => {
                encoder.encode_pixels_stream::<_, BgrAChannels>(src, dst, rle)?
            }
        };

        Ok(written)
    }
}

fn encode_raw_chunk(
    format: PixelFormat,
    src: &[u8],
    stride: usize,
    row_len: usize,
    height: usize,
    dst: &mut [u8],
) -> Result<usize, BitmapEncodeError> {
    let mut cursor = WriteCursor::new(dst);
    BitmapStreamHeader {
        enable_rle_compression: false,
        use_alpha: false,
        color_plane_definition: ColorPlaneDefinition::Argb,
    }
    .encode(&mut cursor)
    .map_err(BitmapEncodeError::Encode)?;
    let pixels = row_len / 4 * height;
    let needed = pixels * 3 + 1;
    if cursor.len() < needed {
        return Err(BitmapEncodeError::Encode(not_enough_bytes_err!(
            "BitmapStreamData",
            cursor.len(),
            needed
        )));
    }
    let (red, gb) = cursor.remaining_mut()[..pixels * 3].split_at_mut(pixels);
    let (green, blue) = gb.split_at_mut(pixels);
    match format {
        PixelFormat::ARgb32 | PixelFormat::XRgb32 => {
            raw_planes::<1, 2, 3>(src, stride, row_len, height, red, green, blue)
        }
        PixelFormat::RgbA32 | PixelFormat::RgbX32 => {
            raw_planes::<0, 1, 2>(src, stride, row_len, height, red, green, blue)
        }
        PixelFormat::ABgr32 | PixelFormat::XBgr32 => {
            raw_planes::<3, 2, 1>(src, stride, row_len, height, red, green, blue)
        }
        PixelFormat::BgrA32 | PixelFormat::BgrX32 => {
            raw_planes::<2, 1, 0>(src, stride, row_len, height, red, green, blue)
        }
    }
    cursor.advance(pixels * 3);
    cursor.write_u8(0);
    Ok(cursor.pos())
}

fn raw_planes<const R: usize, const G: usize, const B: usize>(
    src: &[u8],
    stride: usize,
    row_len: usize,
    height: usize,
    red: &mut [u8],
    green: &mut [u8],
    blue: &mut [u8],
) {
    let width = row_len / 4;
    for (y, ((red, green), blue)) in red
        .chunks_exact_mut(width)
        .zip(green.chunks_exact_mut(width))
        .zip(blue.chunks_exact_mut(width))
        .enumerate()
    {
        let start = (height - y - 1) * stride;
        let row = &src[start..start + row_len];
        let pixels = row.as_chunks::<4>().0;
        // Independent fixed-layout loops let LLVM vectorize each channel
        // without a four-way zip's minimum-length and alias checks.
        for (output, pixel) in red.iter_mut().zip(pixels) {
            *output = pixel[R];
        }
        for (output, pixel) in green.iter_mut().zip(pixels) {
            *output = pixel[G];
        }
        for (output, pixel) in blue.iter_mut().zip(pixels) {
            *output = pixel[B];
        }
    }
}

fn has_repeated_pixels(bitmap: &BitmapUpdate) -> bool {
    let width = usize::from(bitmap.width.get());
    let height = usize::from(bitmap.height.get());
    if width < 2 || height < 2 {
        return true;
    }
    let stride = bitmap.stride.get();
    let mut repeated = 0;
    // Cover the whole rectangle with 256 neighbouring pixel pairs, not only
    // its first strip (which might contain a frame marker or toolbar).
    for row in 0..8 {
        let y = if height >= 3 {
            row * (height - 3) / 7 + 2
        } else {
            1
        };
        for column in 0..32 {
            let x = column * (width - 2) / 31 + 1;
            let offset = y * stride + x * 4;
            let pixel = &bitmap.data[offset..offset + 4];
            if pixel == &bitmap.data[offset - 4..offset]
                || pixel == &bitmap.data[offset - stride..offset - stride + 4]
                || (y >= 2
                    && (0..4).all(|channel| {
                        bitmap.data[offset + channel]
                            .wrapping_sub(bitmap.data[offset - stride + channel])
                            == bitmap.data[offset - stride + channel]
                                .wrapping_sub(bitmap.data[offset - stride * 2 + channel])
                    }))
            {
                repeated += 1;
            }
        }
    }
    // A merged 64x64-tile crop can include plain desktop around a photo.
    // Require a majority of coherent samples so those borders do not force
    // an expensive RLE attempt over the noisy interior.
    repeated >= 128
}

#[cfg(test)]
mod tests {
    use super::*;
    use core::num::NonZeroU16;
    use ironrdp_core::decode;
    use ironrdp_graphics::rdp6::BitmapStreamDecoder;

    #[test]
    fn lazy_raw_planar_samples_match_materialized_bytes_across_crops_and_layouts() {
        for format in [
            PixelFormat::ARgb32,
            PixelFormat::XRgb32,
            PixelFormat::RgbA32,
            PixelFormat::RgbX32,
            PixelFormat::ABgr32,
            PixelFormat::XBgr32,
            PixelFormat::BgrA32,
            PixelFormat::BgrX32,
        ] {
            for width in [2u16, 3, 17, 253, 704] {
                for height in [3u16, 131] {
                    let stride = usize::from(width + 11) * 4;
                    let mut seed = 0x9e3779b9u32;
                    let data: Vec<_> = (0..stride * (usize::from(height) - 1)
                        + usize::from(width) * 4)
                        .map(|_| {
                            seed ^= seed << 13;
                            seed ^= seed >> 17;
                            seed ^= seed << 5;
                            seed as u8
                        })
                        .collect();
                    let bitmap = BitmapUpdate {
                        x: 13,
                        y: 19,
                        width: NonZeroU16::new(width).unwrap(),
                        height: NonZeroU16::new(height).unwrap(),
                        format,
                        data: data.into(),
                        stride: NonZeroUsize::new(stride).unwrap(),
                    };
                    let mut encoder = BitmapEncoder::for_bulk_compression();
                    let (length, sample) = encoder.raw_planar_sample(&bitmap).unwrap().unwrap();
                    let mut output = vec![0; encoder.output_size_hint(&bitmap)];
                    let written = encoder.encode(&bitmap, &mut output).unwrap();
                    output.truncate(written);
                    assert_eq!(length, output.len(), "{width}x{height} {format:?}");
                    let expected = if length <= sample.len() {
                        output.clone()
                    } else {
                        let strip = sample.len() / 4;
                        (0..4)
                            .flat_map(|index| {
                                let start = index * (length - strip) / 3;
                                output[start..start + strip].iter().copied()
                            })
                            .collect()
                    };
                    assert_eq!(sample, expected, "{width}x{height} {format:?}");
                    assert_eq!(
                        super::super::estimate_bulk_sample(length, &sample).unwrap(),
                        super::super::estimate_bulk_size(&output).unwrap(),
                    );
                }
            }
        }
    }

    #[test]
    fn photo_inside_a_merged_tile_crop_uses_raw_planar_but_smooth_ui_uses_rle() {
        let width = 704u16;
        let height = 384u16;
        let mut pixels = vec![48; usize::from(width) * usize::from(height) * 4];
        let mut seed = 0x9e3779b9u32;
        for y in 16..376usize {
            for x in 40..680usize {
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
                let value = (x / 4 + y / 8 + (seed & 31) as usize) as u8;
                let offset = (y * usize::from(width) + x) * 4;
                pixels[offset..offset + 4].copy_from_slice(&[
                    value,
                    value.wrapping_add(20),
                    value / 2,
                    255,
                ]);
            }
        }
        let mut bitmap = BitmapUpdate {
            x: 0,
            y: 0,
            width: NonZeroU16::new(width).unwrap(),
            height: NonZeroU16::new(height).unwrap(),
            format: PixelFormat::BgrA32,
            data: pixels.into(),
            stride: NonZeroUsize::new(usize::from(width) * 4).unwrap(),
        };
        assert!(
            !has_repeated_pixels(&bitmap),
            "plain borders must not force photo RLE"
        );
        let gradient: Vec<u8> = (0..usize::from(width) * usize::from(height))
            .flat_map(|i| {
                [
                    (i % usize::from(width)) as u8,
                    (i / usize::from(width)) as u8,
                    64,
                    255,
                ]
            })
            .collect();
        bitmap.data = gradient.into();
        assert!(
            has_repeated_pixels(&bitmap),
            "coherent vertical deltas benefit from RLE"
        );
    }

    #[test]
    fn noisy_raw_planar_crops_are_lossless_in_every_pixel_layout() {
        for format in [
            PixelFormat::ARgb32,
            PixelFormat::XRgb32,
            PixelFormat::RgbA32,
            PixelFormat::RgbX32,
            PixelFormat::ABgr32,
            PixelFormat::XBgr32,
            PixelFormat::BgrA32,
            PixelFormat::BgrX32,
        ] {
            let width = 253u16;
            let height = 131u16;
            let stride = usize::from(width + 11) * 4;
            let mut pixels = vec![0xcc; usize::from(height - 1) * stride + usize::from(width) * 4];
            for y in 0..usize::from(height) {
                for x in 0..usize::from(width) {
                    let (r, g, b) = ((x * x + y * 3) as u8, (y * y + x * 5) as u8, (x * y) as u8);
                    let pixel = match format {
                        PixelFormat::ARgb32 | PixelFormat::XRgb32 => [255, r, g, b],
                        PixelFormat::RgbA32 | PixelFormat::RgbX32 => [r, g, b, 255],
                        PixelFormat::ABgr32 | PixelFormat::XBgr32 => [255, b, g, r],
                        PixelFormat::BgrA32 | PixelFormat::BgrX32 => [b, g, r, 255],
                    };
                    pixels[y * stride + x * 4..][..4].copy_from_slice(&pixel);
                }
            }
            let bitmap = BitmapUpdate {
                x: 7,
                y: 13,
                width: NonZeroU16::new(width).unwrap(),
                height: NonZeroU16::new(height).unwrap(),
                format,
                data: pixels.into(),
                stride: NonZeroUsize::new(stride).unwrap(),
            };
            assert!(!has_repeated_pixels(&bitmap));
            let mut encoder = BitmapEncoder::for_bulk_compression();
            let mut output = vec![0; usize::from(width) * usize::from(height) * 8 + 4096];
            let length = encoder.encode(&bitmap, &mut output).unwrap();
            let update: BitmapUpdateData<'_> = decode(&output[..length]).unwrap();
            let mut rows = 0;
            let mut decoder = BitmapStreamDecoder::default();
            for rectangle in update.rectangles {
                let header: BitmapStreamHeader = decode(rectangle.bitmap_data).unwrap();
                assert!(!header.enable_rle_compression);
                let mut rgb = Vec::new();
                decoder
                    .decode_bitmap_stream_to_rgb24(
                        rectangle.bitmap_data,
                        &mut rgb,
                        usize::from(width),
                        usize::from(rectangle.height),
                    )
                    .unwrap();
                for (local_y, row) in rgb.chunks_exact(usize::from(width) * 3).rev().enumerate() {
                    let y = usize::from(rows) + local_y;
                    for (x, pixel) in row.chunks_exact(3).enumerate() {
                        assert_eq!(
                            pixel,
                            [(x * x + y * 3) as u8, (y * y + x * 5) as u8, (x * y) as u8]
                        );
                    }
                }
                rows += rectangle.height;
            }
            assert_eq!(rows, height);
        }
    }

    #[test]
    fn odd_width_crops_keep_every_pixel_row_and_position_across_chunks() {
        for width in [1u16, 2, 3, 253, 254, 255, 256] {
            let height = 131u16;
            let stride = usize::from(width + 11) * 4;
            let mut pixels = vec![0xcc; usize::from(height - 1) * stride + usize::from(width) * 4];
            for y in 0..usize::from(height) {
                for x in 0..usize::from(width) {
                    pixels[y * stride + x * 4..][..4].copy_from_slice(&[x as u8, y as u8, 64, 255]);
                }
            }
            let bitmap = BitmapUpdate {
                x: 7,
                y: 13,
                width: NonZeroU16::new(width).unwrap(),
                height: NonZeroU16::new(height).unwrap(),
                format: PixelFormat::BgrA32,
                data: pixels.into(),
                stride: NonZeroUsize::new(stride).unwrap(),
            };
            let mut encoder = BitmapEncoder::for_bulk_compression();
            let mut output = vec![0; usize::from(width) * usize::from(height) * 8 + 4096];
            let length = encoder.encode(&bitmap, &mut output).unwrap();
            let update: BitmapUpdateData<'_> = decode(&output[..length]).unwrap();
            let mut rows = 0;
            let mut decoder = BitmapStreamDecoder::default();
            for rectangle in update.rectangles {
                assert_eq!(rectangle.rectangle.left, 7);
                assert_eq!(rectangle.rectangle.right, 7 + width - 1);
                assert_eq!(rectangle.rectangle.top, 13 + rows);
                assert_eq!(
                    rectangle.compressed_data_header.unwrap().scan_width,
                    width * 4
                );
                let mut rgb = Vec::new();
                decoder
                    .decode_bitmap_stream_to_rgb24(
                        rectangle.bitmap_data,
                        &mut rgb,
                        usize::from(width),
                        usize::from(rectangle.height),
                    )
                    .unwrap();
                for (local_y, row) in rgb.chunks_exact(usize::from(width) * 3).rev().enumerate() {
                    for (x, pixel) in row.chunks_exact(3).enumerate() {
                        assert_eq!(
                            pixel,
                            [64, (usize::from(rows) + local_y) as u8, x as u8],
                            "width={width} x={x} y={local_y} rows={rows}"
                        );
                    }
                }
                rows += rectangle.height;
            }
            assert_eq!(rows, height);
        }
    }

    #[test]
    fn legacy_bitmap_header_keeps_its_original_bytes() {
        let bitmap = BitmapUpdate {
            x: 0,
            y: 0,
            width: NonZeroU16::new(4).unwrap(),
            height: NonZeroU16::new(2).unwrap(),
            format: PixelFormat::BgrA32,
            data: vec![42; 32].into(),
            stride: NonZeroUsize::new(16).unwrap(),
        };
        let mut encoder = BitmapEncoder::new();
        let mut output = vec![0; 1024];
        let length = encoder.encode(&bitmap, &mut output).unwrap();
        let update: BitmapUpdateData<'_> = decode(&output[..length]).unwrap();
        assert_eq!(
            update.rectangles[0]
                .compressed_data_header
                .as_ref()
                .unwrap()
                .scan_width,
            4
        );
    }
}
