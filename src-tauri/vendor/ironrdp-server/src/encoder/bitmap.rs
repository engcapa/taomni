use core::num::NonZeroUsize;

use ironrdp_core::{Encode as _, WriteCursor, cast_int, cast_length, invalid_field_err};
use ironrdp_graphics::image_processing::PixelFormat;
use ironrdp_graphics::rdp6::{
    ABgrChannels, ARgbChannels, BgrAChannels, BitmapEncodeError, BitmapStreamEncoder, RgbAChannels,
};
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
            let height = cast_int!("bitmap height", chunk.len().div_ceil(stride))
                .map_err(BitmapEncodeError::Encode)?;
            let i: u16 = cast_int!("chunk idx", i).map_err(BitmapEncodeError::Encode)?;
            let top = bitmap.y + i * chunk_height;

            let encoder = BitmapStreamEncoder::new(
                NonZeroUsize::from(bitmap.width).get(),
                usize::from(height),
            );

            let len = {
                let pixels = chunk
                    .chunks(stride)
                    .map(|row| &row[..usize::from(row_len)])
                    .rev()
                    .flat_map(|row| row.chunks(usize::from(bytes_per_pixel)));

                Self::encode_iter(encoder, bitmap.format, pixels, self.buffer.as_mut_slice())?
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
    ) -> Result<usize, BitmapEncodeError>
    where
        P: Iterator<Item = &'a [u8]> + Clone,
    {
        let written = match format {
            PixelFormat::ARgb32 | PixelFormat::XRgb32 => {
                encoder.encode_pixels_stream::<_, ARgbChannels>(src, dst, true)?
            }
            PixelFormat::RgbA32 | PixelFormat::RgbX32 => {
                encoder.encode_pixels_stream::<_, RgbAChannels>(src, dst, true)?
            }
            PixelFormat::ABgr32 | PixelFormat::XBgr32 => {
                encoder.encode_pixels_stream::<_, ABgrChannels>(src, dst, true)?
            }
            PixelFormat::BgrA32 | PixelFormat::BgrX32 => {
                encoder.encode_pixels_stream::<_, BgrAChannels>(src, dst, true)?
            }
        };

        Ok(written)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use core::num::NonZeroU16;
    use ironrdp_core::decode;
    use ironrdp_graphics::rdp6::BitmapStreamDecoder;

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
