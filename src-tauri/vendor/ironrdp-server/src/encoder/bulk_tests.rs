use super::adaptive::{estimate_bulk_sample, estimate_bulk_size};
use super::*;
use core::num::NonZeroUsize;
use ironrdp_core::{ReadCursor, decode_cursor};
use ironrdp_pdu::fast_path::{FastPathHeader, FastPathUpdatePdu};
use ironrdp_pdu::rdp::headers::CompressionFlags;

fn encoder() -> UpdateEncoder {
    let mut codecs = UpdateEncoderCodecs::new();
    codecs.set_remotefx(Some((EntropyBits::Rlgr3, 3)));
    UpdateEncoder::new(
        DesktopSize {
            width: 256,
            height: 128,
        },
        CmdFlags::SET_SURFACE_BITS,
        codecs,
        8 * 1024 * 1024,
    )
    .unwrap()
    .with_bulk_compression(Some(CompressionType::Rdp61), None, true)
    .unwrap()
}

#[test]
fn desktop_resize_flushes_history_even_when_reusing_the_encoder() {
    let mut encoder = encoder();
    let original = vec![42; 4000];
    let mut receiver = BulkCompressor::new(BulkType::Rdp61).unwrap();
    for index in 0..3 {
        if index == 2 {
            encoder
                .set_desktop_size(DesktopSize {
                    width: 320,
                    height: 128,
                })
                .unwrap();
        }
        let mut fragment = UpdateFragmenter::new(UpdateCode::Bitmap, original.clone());
        let mut output = vec![0; fragment.size_hint()];
        let mut iter = encoder.update(DisplayUpdate::DefaultPointer);
        let size = iter
            .encode_fragment(&mut fragment, &mut output)
            .unwrap()
            .unwrap();
        let mut cursor = ReadCursor::new(&output[..size]);
        let _: FastPathHeader = decode_cursor(&mut cursor).unwrap();
        let update: FastPathUpdatePdu<'_> = decode_cursor(&mut cursor).unwrap();
        let packet_flags = update.compression_flags.unwrap();
        assert_eq!(
            packet_flags.contains(CompressionFlags::FLUSHED),
            index == 0 || index == 2
        );
        assert_eq!(
            receiver
                .decompress(update.data, u32::from(packet_flags.bits()) | 3)
                .unwrap(),
            original
        );
    }
}

#[tokio::test]
async fn a_disabled_compressor_returns_the_adaptive_encoder_to_remotefx() {
    let mut encoder = encoder();
    encoder.bulk.as_mut().unwrap().compressor = None;
    let mut fragment = UpdateFragmenter::new(UpdateCode::Bitmap, vec![1; 80]);
    let mut output = vec![0; fragment.size_hint()];
    let mut iter = encoder.update(DisplayUpdate::DefaultPointer);
    iter.encode_fragment(&mut fragment, &mut output).unwrap();
    drop(iter);
    assert!(matches!(
        encoder.bitmap_updater,
        Some(BitmapUpdater::RemoteFx(_))
    ));
    let bitmap = BitmapUpdate {
        x: 0,
        y: 0,
        width: NonZeroU16::new(256).unwrap(),
        height: NonZeroU16::new(128).unwrap(),
        format: ironrdp_graphics::image_processing::PixelFormat::BgrA32,
        data: vec![42; 256 * 128 * 4].into(),
        stride: NonZeroUsize::new(256 * 4).unwrap(),
    };
    assert_eq!(
        encoder.bitmap(bitmap).await.unwrap().code,
        UpdateCode::SurfaceCommands
    );
}

#[test]
fn unaligned_ui_rectangles_use_planar_instead_of_remotefx() {
    let mut encoder = encoder();
    for width in [1, 2, 3, 253, 254, 255] {
        let bitmap = BitmapUpdate {
            x: 0,
            y: 0,
            width: NonZeroU16::new(width).unwrap(),
            height: NonZeroU16::new(128).unwrap(),
            format: ironrdp_graphics::image_processing::PixelFormat::BgrA32,
            data: vec![42; usize::from(width) * 128 * 4].into(),
            stride: NonZeroUsize::new(usize::from(width) * 4).unwrap(),
        };
        let encoded = encoder
            .bitmap_updater
            .as_mut()
            .unwrap()
            .handle(&bitmap, None)
            .unwrap();
        assert_eq!(encoded.code, UpdateCode::Bitmap, "width={width}");
    }
}

#[test]
fn peers_without_header_omission_get_pixel_scan_width_and_odd_width_remotefx() {
    let mut handler = AdaptiveHandler {
        estimator: MppcSizeEstimator::default(),
        bitmap: BitmapHandler::for_bulk_compression(false),
        rfx: RemoteFxHandler::new(
            EntropyBits::Rlgr3,
            3,
            DesktopSize {
                width: 128,
                height: 128,
            },
        ),
    };
    for width in [64u16, 65] {
        let bitmap = BitmapUpdate {
            x: 0,
            y: 0,
            width: NonZeroU16::new(width).unwrap(),
            height: NonZeroU16::new(128).unwrap(),
            format: ironrdp_graphics::image_processing::PixelFormat::BgrA32,
            data: vec![42; usize::from(width) * 128 * 4].into(),
            stride: NonZeroUsize::new(usize::from(width) * 4).unwrap(),
        };
        let encoded = handler.handle(&bitmap).unwrap();
        if width == 64 {
            assert_eq!(encoded.code, UpdateCode::Bitmap);
            let bitmap: ironrdp_pdu::bitmap::BitmapUpdateData<'_> =
                ironrdp_core::decode(&encoded.data).unwrap();
            for rectangle in bitmap.rectangles {
                assert_eq!(rectangle.compressed_data_header.unwrap().scan_width, width);
            }
        } else {
            assert_eq!(encoded.code, UpdateCode::SurfaceCommands);
        }
    }
}

#[test]
fn scanlines_larger_than_mstsc_bitmap_buffers_use_remotefx() {
    for omit_header in [false, true] {
        let (width, height) = (8192u16, 2u16);
        let bitmap = BitmapUpdate {
            x: 0,
            y: 0,
            width: NonZeroU16::new(width).unwrap(),
            height: NonZeroU16::new(height).unwrap(),
            format: ironrdp_graphics::image_processing::PixelFormat::BgrA32,
            data: vec![42; usize::from(width) * usize::from(height) * 4].into(),
            stride: NonZeroUsize::new(usize::from(width) * 4).unwrap(),
        };
        let mut handler = AdaptiveHandler {
            estimator: MppcSizeEstimator::default(),
            bitmap: BitmapHandler::for_bulk_compression(omit_header),
            rfx: RemoteFxHandler::new(EntropyBits::Rlgr3, 3, DesktopSize { width, height }),
        };
        assert_eq!(
            handler.handle(&bitmap).unwrap().code,
            UpdateCode::SurfaceCommands
        );
    }
}

#[test]
fn photo_after_a_plain_planar_prefix_uses_remotefx() {
    let (width, height) = (704u16, 384u16);
    let mut pixels = vec![48; usize::from(width) * usize::from(height) * 4];
    let mut seed = 0x9e3779b9u32;
    for y in 0..256usize {
        for x in 32..672usize {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            let offset = (y * usize::from(width) + x) * 4;
            pixels[offset..offset + 4].copy_from_slice(&[
                seed as u8,
                (seed >> 8) as u8,
                (seed >> 16) as u8,
                255,
            ]);
        }
    }
    let bitmap = BitmapUpdate {
        x: 0,
        y: 0,
        width: NonZeroU16::new(width).unwrap(),
        height: NonZeroU16::new(height).unwrap(),
        format: ironrdp_graphics::image_processing::PixelFormat::BgrA32,
        data: pixels.into(),
        stride: NonZeroUsize::new(usize::from(width) * 4).unwrap(),
    };
    let mut handler = AdaptiveHandler {
        estimator: MppcSizeEstimator::default(),
        bitmap: BitmapHandler::for_bulk_compression(true),
        rfx: RemoteFxHandler::new(EntropyBits::Rlgr3, 3, DesktopSize { width, height }),
    };
    assert_eq!(
        handler.handle(&bitmap).unwrap().code,
        UpdateCode::SurfaceCommands
    );
}

#[test]
#[ignore = "offline CPU timings; run with --release --ignored --nocapture"]
fn profile_photo_encoder_costs() {
    use std::time::{Duration, Instant};
    for (width, height, cropped) in [
        (64u16, 64u16, false),
        (128, 64, false),
        (640, 360, false),
        (704, 384, true),
    ] {
        let stride = if cropped {
            1920 * 4
        } else {
            usize::from(width) * 4
        };
        let frames: Vec<_> = (0..16u32)
            .map(|frame| {
                let mut seed = 0x9e3779b9u32.wrapping_mul(frame + 1);
                let mut pixels =
                    vec![48; stride * (usize::from(height) - 1) + usize::from(width) * 4];
                let (left, top) = if cropped { (32, 16) } else { (0, 0) };
                for y in 0..usize::from(height.min(360)) {
                    for x in 0..usize::from(width.min(640)) {
                        seed ^= seed << 13;
                        seed ^= seed >> 17;
                        seed ^= seed << 5;
                        // The native photo target: panning gradient plus
                        // xorshift noise, correlated B/G/R colour planes.
                        let base = (x + (frame as usize * 3) % 640) * 180 / 640 + y * 60 / 360;
                        let value = (base as i32 + (seed & 31) as i32 - 16).clamp(0, 255) as u8;
                        let offset = (y + top) * stride + (x + left) * 4;
                        pixels[offset..offset + 4].copy_from_slice(&[
                            value,
                            value.wrapping_add(20),
                            value / 2,
                            255,
                        ]);
                    }
                }
                BitmapUpdate {
                    x: 0,
                    y: 0,
                    width: NonZeroU16::new(width).unwrap(),
                    height: NonZeroU16::new(height).unwrap(),
                    format: ironrdp_graphics::image_processing::PixelFormat::BgrA32,
                    data: pixels.into(),
                    stride: NonZeroUsize::new(stride).unwrap(),
                }
            })
            .collect();
        let mut planar = BitmapHandler::for_bulk_compression(true);
        let mut planar_time = Duration::ZERO;
        let mut estimate_time = Duration::ZERO;
        let mut sample_time = Duration::ZERO;
        let mut estimator = MppcSizeEstimator::default();
        for bitmap in frames.iter().cycle().take(512) {
            let started = Instant::now();
            let (length, sample) = planar.bitmap.raw_planar_sample(bitmap).unwrap().unwrap();
            estimate_bulk_sample(&mut estimator, length, &sample).unwrap();
            sample_time += started.elapsed();
            let started = Instant::now();
            let fragment = planar.handle(bitmap).unwrap();
            planar_time += started.elapsed();
            let started = Instant::now();
            estimate_bulk_size(&mut estimator, &fragment.data).unwrap();
            estimate_time += started.elapsed();
        }
        eprintln!(
            "photo {width}x{height} cropped={cropped}: planar={:.3}ms/frame estimate={:.3}ms/frame lazy-sample={:.3}ms/frame",
            planar_time.as_secs_f64() * 1000.0 / 512.0,
            estimate_time.as_secs_f64() * 1000.0 / 512.0,
            sample_time.as_secs_f64() * 1000.0 / 512.0,
        );
        let mut rfx = RemoteFxHandler::new(EntropyBits::Rlgr3, 3, DesktopSize { width, height });
        let mut handler = AdaptiveHandler {
            estimator: MppcSizeEstimator::default(),
            bitmap: BitmapHandler::for_bulk_compression(true),
            rfx: rfx.clone(),
        };
        let mut bulk = bulk::BulkEncoder::new(CompressionType::Rdp61).unwrap();
        let mut encoded_time = [Duration::ZERO; 2];
        let mut send_time = [Duration::ZERO; 2];
        let mut bytes = [0; 2];
        let samples = 512;
        // Warm the Rayon pool and alternate order on each matched frame.
        // Separate baseline/candidate loops can mistake scheduler noise
        // or first-frame startup for the adaptive selection cost.
        for (index, bitmap) in frames.iter().cycle().take(samples + 32).enumerate() {
            let mut payloads = [Vec::new(), Vec::new()];
            for mode in [index % 2, (index + 1) % 2] {
                let adaptive = mode == 1;
                let started = Instant::now();
                let mut fragment = if adaptive {
                    handler.handle(bitmap).unwrap()
                } else {
                    rfx.handle(bitmap).unwrap()
                };
                assert_eq!(fragment.code, UpdateCode::SurfaceCommands);
                if index >= 32 {
                    encoded_time[mode] += started.elapsed();
                }
                payloads[mode] = fragment.data.clone();
                let started = Instant::now();
                let mut output = vec![0; fragment.size_hint()];
                while let Some(size) = fragment
                    .next(&mut output, adaptive.then_some(&mut bulk), None)
                    .unwrap()
                {
                    if index >= 32 {
                        bytes[mode] += size;
                    }
                }
                if index >= 32 {
                    send_time[mode] += started.elapsed();
                }
            }
            assert_eq!(payloads[0], payloads[1], "matched photo payload {index}");
        }
        for mode in 0..2 {
            eprintln!(
                "photo {width}x{height} cropped={cropped} adaptive={}: encode={:.3}ms/frame bulk={:.3}ms/frame wire={}B/frame",
                mode == 1,
                encoded_time[mode].as_secs_f64() * 1000.0 / samples as f64,
                send_time[mode].as_secs_f64() * 1000.0 / samples as f64,
                bytes[mode] / samples
            );
        }
    }
}
