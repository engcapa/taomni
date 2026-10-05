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
