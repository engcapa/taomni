use std::borrow::Cow;

use ironrdp_bulk::{BulkCompressor, CompressionType, flags};
use ironrdp_core::encode_vec;
use ironrdp_graphics::image_processing::PixelFormat;
use ironrdp_pdu::Action;
use ironrdp_pdu::bitmap::{BitmapData, BitmapUpdateData, Compression};
use ironrdp_pdu::fast_path::{
    EncryptionFlags, FastPathHeader, FastPathUpdatePdu, Fragmentation, UpdateCode,
};
use ironrdp_pdu::geometry::InclusiveRectangle;
use ironrdp_pdu::mcs::{McsMessage, SendDataIndication};
use ironrdp_pdu::rdp::client_info::CompressionType as PduCompressionType;
use ironrdp_pdu::rdp::headers::CompressionFlags;
use ironrdp_pdu::rdp::headers::{ServerDeactivateAll, ShareControlHeader, ShareControlPdu};
use ironrdp_pdu::x224::X224;
use ironrdp_svc::StaticChannelSet;

use crate::image::DecodedImage;
use crate::{ActiveStage, ActiveStageBuilder, ActiveStageOutput};

fn stage(compression: Option<PduCompressionType>) -> ActiveStage {
    ActiveStageBuilder {
        static_channels: StaticChannelSet::new(),
        user_channel_id: 1007,
        io_channel_id: 1003,
        message_channel_id: None,
        share_id: 0x1234,
        compression_type: compression,
        enable_server_pointer: false,
        pointer_software_rendering: false,
    }
    .build()
}

fn bitmap(rgb: [u8; 3]) -> Vec<u8> {
    let pixels = [rgb[2], rgb[1], rgb[0]].repeat(32 * 32);
    encode_vec(&BitmapUpdateData {
        rectangles: vec![BitmapData {
            rectangle: InclusiveRectangle {
                left: 0,
                top: 0,
                right: 31,
                bottom: 31,
            },
            width: 32,
            height: 32,
            bits_per_pixel: 24,
            compression_flags: Compression::empty(),
            compressed_data_header: None,
            bitmap_data: &pixels,
        }],
    })
    .unwrap()
}

fn compress(sender: &mut BulkCompressor, data: &[u8]) -> (Vec<u8>, u32) {
    let (length, flags) = sender.compress(data).unwrap();
    assert_ne!(
        flags & flags::PACKET_COMPRESSED,
        0,
        "test must exercise compression"
    );
    (sender.compressed_data(length).to_vec(), flags)
}

fn slow_share_data(
    data: &[u8],
    compression_flags: u32,
    raw_length: usize,
    pdu_type: u8,
) -> Vec<u8> {
    let length = u16::try_from(18 + data.len()).unwrap();
    let mut user_data = Vec::new();
    user_data.extend_from_slice(&length.to_le_bytes());
    user_data.extend_from_slice(&0x0017u16.to_le_bytes());
    user_data.extend_from_slice(&1003u16.to_le_bytes());
    user_data.extend_from_slice(&0x1234u32.to_le_bytes());
    user_data.extend_from_slice(&[0, 1]);
    user_data.extend_from_slice(&u16::try_from(18 + raw_length).unwrap().to_le_bytes());
    user_data.extend_from_slice(&[pdu_type, u8::try_from(compression_flags).unwrap()]);
    user_data.extend_from_slice(&length.to_le_bytes());
    user_data.extend_from_slice(data);
    user_data
}

fn slow_frame(user_data: &[u8]) -> Vec<u8> {
    encode_vec(&X224(McsMessage::SendDataIndication(SendDataIndication {
        initiator_id: 1007,
        channel_id: 1003,
        user_data: Cow::Borrowed(user_data),
    })))
    .unwrap()
}

fn fast_frame(data: &[u8], compression_flags: u32, ct: PduCompressionType) -> Vec<u8> {
    let update = encode_vec(&FastPathUpdatePdu {
        fragmentation: Fragmentation::Single,
        update_code: UpdateCode::Bitmap,
        compression_flags: Some(CompressionFlags::from_bits_retain(
            u8::try_from(compression_flags).unwrap() & 0xf0,
        )),
        compression_type: Some(ct),
        data,
    })
    .unwrap();
    let mut frame =
        encode_vec(&FastPathHeader::new(EncryptionFlags::empty(), update.len())).unwrap();
    frame.extend_from_slice(&update);
    frame
}

#[test]
fn compressed_bitmap_pixels_survive_slow_fast_slow_interleaving_for_every_codec() {
    for (ct, bulk_ct) in [
        (PduCompressionType::K8, CompressionType::Rdp4),
        (PduCompressionType::K64, CompressionType::Rdp5),
        (PduCompressionType::Rdp6, CompressionType::Rdp6),
        (PduCompressionType::Rdp61, CompressionType::Rdp61),
    ] {
        let mut client = stage(Some(ct));
        let mut sender = BulkCompressor::new(bulk_ct).unwrap();
        let mut image = DecodedImage::new(PixelFormat::RgbA32, 32, 32);
        for (index, rgb) in [[255, 0, 255], [0, 255, 255], [255, 0, 255]]
            .into_iter()
            .enumerate()
        {
            let payload = bitmap(rgb);
            let (compressed, flags) = compress(&mut sender, &payload);
            let (action, frame) = if index == 1 {
                (Action::FastPath, fast_frame(&compressed, flags, ct))
            } else {
                (
                    Action::X224,
                    slow_frame(&slow_share_data(&compressed, flags, payload.len(), 2)),
                )
            };
            let outputs = client.process(&mut image, action, &frame).unwrap();
            assert!(
                outputs
                    .iter()
                    .any(|output| matches!(output, ActiveStageOutput::GraphicsUpdate(_)))
            );
            for pixel in image.data().chunks_exact(4) {
                assert_eq!(&pixel[..3], &rgb, "codec {ct:?}, update {index}");
            }
        }
    }
}

#[test]
fn uncompressed_bitmap_without_negotiation_still_renders() {
    let mut client = stage(None);
    let mut image = DecodedImage::new(PixelFormat::RgbA32, 32, 32);
    let payload = bitmap([255, 0, 255]);
    client
        .process(
            &mut image,
            Action::X224,
            &slow_frame(&slow_share_data(&payload, 0, payload.len(), 2)),
        )
        .unwrap();
    assert_eq!(&image.data()[..3], &[255, 0, 255]);
}

#[test]
fn compressed_bitmap_without_negotiation_fails_explicitly() {
    let mut client = stage(None);
    let payload = bitmap([255, 0, 255]);
    let mut sender = BulkCompressor::new(CompressionType::Rdp5).unwrap();
    let (compressed, flags) = compress(&mut sender, &payload);
    let error = client
        .process(
            &mut DecodedImage::new(PixelFormat::RgbA32, 32, 32),
            Action::X224,
            &slow_frame(&slow_share_data(&compressed, flags, payload.len(), 2)),
        )
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("without a negotiated decompressor")
    );
    assert!(
        client
            .normalize_reactivation_frame(&slow_frame(&slow_share_data(
                &compressed,
                flags,
                payload.len(),
                2,
            )))
            .unwrap_err()
            .to_string()
            .contains("without a negotiated decompressor")
    );
}

#[test]
fn malformed_compressed_lengths_are_rejected() {
    let mut sender = BulkCompressor::new(CompressionType::Rdp5).unwrap();
    let payload = bitmap([255, 0, 255]);
    let (compressed, flags) = compress(&mut sender, &payload);
    for offset in [0, 16] {
        let mut user_data = slow_share_data(&compressed, flags, payload.len(), 2);
        user_data[offset] ^= 1;
        let error = stage(Some(PduCompressionType::K64))
            .process(
                &mut DecodedImage::new(PixelFormat::RgbA32, 32, 32),
                Action::X224,
                &slow_frame(&user_data),
            )
            .unwrap_err();
        assert!(error.to_string().contains("invalid compressed Share"));
        assert!(
            stage(Some(PduCompressionType::K64))
                .normalize_reactivation_frame(&slow_frame(&user_data))
                .unwrap_err()
                .to_string()
                .contains("invalid compressed Share")
        );
    }
}

#[test]
fn raw_slow_path_flush_resets_history_before_the_next_fast_path_update() {
    let mut client = stage(Some(PduCompressionType::K64));
    let mut sender = BulkCompressor::new(CompressionType::Rdp5).unwrap();
    let mut image = DecodedImage::new(PixelFormat::RgbA32, 32, 32);
    let first = bitmap([255, 0, 255]);
    let (compressed, flags) = compress(&mut sender, &first);
    client
        .process(
            &mut image,
            Action::FastPath,
            &fast_frame(&compressed, flags, PduCompressionType::K64),
        )
        .unwrap();

    let raw = bitmap([0, 255, 255]);
    client
        .process(
            &mut image,
            Action::X224,
            &slow_frame(&slow_share_data(
                &raw,
                flags::PACKET_FLUSHED | 1,
                raw.len(),
                2,
            )),
        )
        .unwrap();
    assert_eq!(&image.data()[..3], &[0, 255, 255]);

    let mut fresh_sender = BulkCompressor::new(CompressionType::Rdp5).unwrap();
    let next = bitmap([255, 0, 255]);
    let (compressed, flags) = compress(&mut fresh_sender, &next);
    // The raw packet carried the flush; the fresh sender now only signals AT_FRONT.
    assert_eq!(flags & flags::PACKET_FLUSHED, 0);
    client
        .process(
            &mut image,
            Action::FastPath,
            &fast_frame(&compressed, flags, PduCompressionType::K64),
        )
        .unwrap();
    for pixel in image.data().chunks_exact(4) {
        assert_eq!(&pixel[..3], &[255, 0, 255]);
    }
}

#[test]
fn short_xrdp_and_full_deactivate_all_request_reactivation() {
    let full = encode_vec(&ShareControlHeader {
        share_control_pdu: ShareControlPdu::ServerDeactivateAll(ServerDeactivateAll),
        pdu_source: 1003,
        share_id: 0x1234,
    })
    .unwrap();
    for user_data in [vec![6, 0, 0x16, 0, 0xeb, 3], full] {
        let outputs = stage(Some(PduCompressionType::Rdp61))
            .process(
                &mut DecodedImage::new(PixelFormat::RgbA32, 32, 32),
                Action::X224,
                &slow_frame(&user_data),
            )
            .unwrap();
        assert_eq!(outputs.len(), 1);
        assert!(matches!(outputs[0], ActiveStageOutput::DeactivateAll));
    }
}

#[test]
fn malformed_short_deactivate_all_is_rejected() {
    for user_data in [
        vec![5, 0, 0x16, 0, 0xeb, 3],
        vec![6, 0, 0x17, 0, 0xeb, 3],
        vec![6, 0, 0x26, 0, 0xeb, 3],
        vec![7, 0, 0x16, 0, 0xeb, 3, 0],
    ] {
        assert!(
            stage(Some(PduCompressionType::Rdp61))
                .process(
                    &mut DecodedImage::new(PixelFormat::RgbA32, 32, 32),
                    Action::X224,
                    &slow_frame(&user_data),
                )
                .is_err()
        );
    }
}

#[test]
fn captured_xrdp_font_map_reset_preserves_resized_remotefx_pixels() {
    // Captured server packets from the real hosted xrdp resize failure. The
    // Font Map resets MPPC history even though the activation sequence, rather
    // than ActiveStage::process, consumes it. See testdata/README.md.
    let mut records = &include_bytes!("../testdata/xrdp-resize.bin")[..];
    let mut client = stage(Some(PduCompressionType::K64));
    let mut image = DecodedImage::new(PixelFormat::RgbA32, 994, 750);
    let mut saw_font_map = false;
    let mut saw_resize = false;
    while !records.is_empty() {
        let kind = records[0];
        let length = u32::from_le_bytes(records[1..5].try_into().unwrap()) as usize;
        let payload = &records[5..5 + length];
        records = &records[5 + length..];
        match kind {
            0 | 1 => {
                let action = if kind == 0 {
                    Action::FastPath
                } else {
                    Action::X224
                };
                client.process(&mut image, action, payload).unwrap();
            }
            2 => {
                let frame = client.normalize_reactivation_frame(payload).unwrap();
                let ctx = ironrdp_pdu::mcs::decode_send_data_indication(&frame).unwrap();
                if ctx.user_data[14] == 40 {
                    saw_font_map = true;
                    // The original compressed payload happens to consist of
                    // literal bytes, so ordinary Font Map parsing succeeds
                    // while leaving the graphics decompressor out of sync.
                    let _ = ironrdp_pdu::rdp::headers::decode_io_channel(ctx).unwrap();
                }
            }
            3 => {
                assert_eq!(&image.data()[(240 * 994 + 280) * 4..][..4], &[255; 4]);
                let width = u16::from_le_bytes(payload[..2].try_into().unwrap());
                let height = u16::from_le_bytes(payload[2..].try_into().unwrap());
                image = DecodedImage::new(PixelFormat::RgbA32, width, height);
                saw_resize = true;
            }
            _ => panic!("unknown capture record type"),
        }
    }
    assert!(saw_font_map && saw_resize);
    assert_eq!((image.width(), image.height()), (1492, 1030));
    assert_eq!(
        &image.data()[(240 * 1492 + 280) * 4..][..4],
        &[255; 4],
        "opaque white center after resize"
    );
    for (x, y, rgba) in [
        (60, 100, [255u8, 0, 255, 255]),
        (160, 100, [0u8, 255, 255, 255]),
    ] {
        let offset = (y * 1492 + x) * 4;
        let actual = &image.data()[offset..offset + 4];
        // RemoteFX color conversion is lossy; alpha must remain fully opaque.
        assert_eq!(actual[3], 255, "pixel ({x},{y}) alpha after resize");
        for channel in 0..3 {
            assert!(
                actual[channel].abs_diff(rgba[channel]) <= 3,
                "pixel ({x},{y}) after resize: {actual:?}, expected {rgba:?}"
            );
        }
    }
}

#[test]
fn reactivation_normalization_preserves_non_io_packets_and_graphics_history() {
    let mut client = stage(Some(PduCompressionType::K64));
    let mut sender = BulkCompressor::new(CompressionType::Rdp5).unwrap();
    let mut image = DecodedImage::new(PixelFormat::RgbA32, 32, 32);
    let payload = bitmap([255, 0, 255]);
    let (compressed, flags) = compress(&mut sender, &payload);
    client
        .process(
            &mut image,
            Action::FastPath,
            &fast_frame(&compressed, flags, PduCompressionType::K64),
        )
        .unwrap();

    let other_channel = encode_vec(&X224(McsMessage::SendDataIndication(SendDataIndication {
        initiator_id: 1007,
        channel_id: 1004,
        user_data: Cow::Owned(slow_share_data(&[0; 8], 0xe1, 8, 40)),
    })))
    .unwrap();
    let uncompressed = slow_frame(&slow_share_data(&[0; 8], 0, 8, 40));
    for frame in [&other_channel, &uncompressed] {
        assert!(matches!(
            client.normalize_reactivation_frame(frame).unwrap(),
            Cow::Borrowed(bytes) if bytes == frame.as_slice()
        ));
    }

    let (compressed, flags) = compress(&mut sender, &payload);
    assert_eq!(flags & (flags::PACKET_FLUSHED | flags::PACKET_AT_FRONT), 0);
    client
        .process(
            &mut image,
            Action::FastPath,
            &fast_frame(&compressed, flags, PduCompressionType::K64),
        )
        .unwrap();
    assert_eq!(&image.data()[..4], &[255, 0, 255, 255]);
}
