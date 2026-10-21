use super::avc::avcc_to_four_byte;
use super::encoder::H264Encoder;
use super::encoder::align_dimension;
use super::flow_control::ACK_STALL_TIMEOUT;
use super::flow_control::AckStall;
use super::flow_control::DECODE_STALL_TIMEOUT;
use super::flow_control::DecodeWatch;
use super::flow_control::ENCODE_TIMEOUT;
use super::flow_control::MAX_FRAMES_IN_FLIGHT;
use super::flow_control::StallVerdict;
use super::flow_control::decode_verdict;
use super::flow_control::stall_verdict;
use super::transport::desktop_monitor;
use super::transport::frame_timestamp_ms;

use std::time::{Duration, Instant};

use super::{
    ACK_STALL_TIMEOUT, AckStall, DECODE_STALL_TIMEOUT, DecodeWatch, ENCODE_TIMEOUT, H264Encoder,
    MAX_FRAMES_IN_FLIGHT, StallVerdict, align_dimension, avcc_to_four_byte, decode_verdict,
    desktop_monitor, frame_timestamp_ms, stall_verdict,
};
use crate::servers::rdp::capture::Frame;
use ironrdp::pdu::gcc::MonitorFlags;

#[test]
fn graphics_path_keeps_only_a_two_frame_ack_window() {
    assert_eq!(MAX_FRAMES_IN_FLIGHT, 2);
}

#[test]
fn a_live_but_slow_client_keeps_the_graphics_path() {
    // Backpressure has been active past the timeout, but acknowledgements
    // advanced in the meantime: the client is consuming, just one frame
    // behind. Dropping frames is correct here; disabling EGFX is not.
    let started = Instant::now();
    let stall = AckStall {
        since: started,
        acks: 4,
    };
    let now = started + ACK_STALL_TIMEOUT + Duration::from_millis(500);
    assert_eq!(stall_verdict(Some(stall), 5, now), StallVerdict::Restart);
}

#[test]
fn a_client_that_stops_acknowledging_falls_back_to_bitmaps() {
    // Same elapsed time, no ACK progress. Without this bound the desktop
    // would stay frozen for as long as the client stayed connected.
    let started = Instant::now();
    let stall = AckStall {
        since: started,
        acks: 4,
    };
    let now = started + ACK_STALL_TIMEOUT + Duration::from_millis(500);
    assert_eq!(stall_verdict(Some(stall), 4, now), StallVerdict::Disable);
}

#[test]
fn brief_backpressure_is_not_treated_as_a_stall() {
    let started = Instant::now();
    let stall = AckStall {
        since: started,
        acks: 4,
    };
    let now = started + ACK_STALL_TIMEOUT - Duration::from_millis(1);
    assert_eq!(stall_verdict(Some(stall), 4, now), StallVerdict::Wait);
    // No window recorded yet: open one against the current ACK count.
    assert_eq!(stall_verdict(None, 4, now), StallVerdict::Restart);
}

#[test]
fn reset_graphics_describes_one_primary_desktop_monitor() {
    let monitor = desktop_monitor(1920, 1080);
    assert_eq!((monitor.left, monitor.top), (0, 0));
    assert_eq!((monitor.right, monitor.bottom), (1919, 1079));
    assert!(monitor.flags.contains(MonitorFlags::PRIMARY));
}

#[test]
fn acknowledged_frames_without_decode_progress_fall_back_to_bitmaps() {
    let started = Instant::now();
    let watch = DecodeWatch {
        since: started,
        decoded: 7,
    };
    let now = started + DECODE_STALL_TIMEOUT + Duration::from_millis(1);
    assert_eq!(decode_verdict(watch, 7, now), StallVerdict::Disable);
}

#[test]
fn decoded_frame_progress_keeps_accelerated_graphics_enabled() {
    let started = Instant::now();
    let watch = DecodeWatch {
        since: started,
        decoded: 7,
    };
    let now = started + DECODE_STALL_TIMEOUT + Duration::from_millis(1);
    assert_eq!(decode_verdict(watch, 8, now), StallVerdict::Restart);
}

#[test]
fn first_decoded_frame_gets_a_bounded_validation_window() {
    let started = Instant::now();
    let watch = DecodeWatch {
        since: started,
        decoded: 0,
    };
    let now = started + DECODE_STALL_TIMEOUT - Duration::from_millis(1);
    assert_eq!(decode_verdict(watch, 0, now), StallVerdict::Wait);
}

#[test]
fn aligns_avc420_dimensions_to_macroblocks() {
    assert_eq!(align_dimension(16).unwrap(), 16);
    assert_eq!(align_dimension(1918).unwrap(), 1920);
    assert_eq!(align_dimension(970).unwrap(), 976);
    assert!(align_dimension(0).is_err());
    assert!(align_dimension(u16::MAX).is_err());
}

async fn encode_test_frame(encoder: &mut H264Encoder, frame: &Frame) -> Vec<u8> {
    encoder.submit(frame).expect("submit VideoToolbox frame");
    encoder
        .flush_pending()
        .expect("flush VideoToolbox test frame");
    tokio::time::timeout(ENCODE_TIMEOUT, encoder.next_output())
        .await
        .expect("VideoToolbox callback timed out")
        .expect("VideoToolbox callback channel closed")
        .result
        .expect("encode VideoToolbox frame")
}

#[tokio::test]
async fn video_toolbox_emits_an_avc_frame_for_rdpegfx() {
    // 16x16 is the smallest broadly-supported H.264 test surface. This
    // exercises the actual macOS hardware/software codec path without
    // requiring Screen Recording permission or a live RDP client.
    let frame = Frame::bgra(vec![0x80; 16 * 16 * 4], 0, 0, 16, 16, 16 * 4);
    let mut encoder = H264Encoder::new(16, 16).expect("create VideoToolbox encoder");
    let avc = encode_test_frame(&mut encoder, &frame).await;
    let nal_types = parse_avc_nal_types(&avc);

    assert!(nal_types.contains(&7), "frame must include an SPS");
    assert!(nal_types.contains(&8), "frame must include a PPS");
    assert!(
        nal_types.iter().any(|kind| matches!(kind, 1 | 5)),
        "frame must include a coded slice"
    );
}

#[tokio::test]
async fn video_toolbox_encodes_non_aligned_desktops_through_a_padded_surface() {
    let frame = Frame::bgra(vec![0x80; 18 * 18 * 4], 0, 0, 18, 18, 18 * 4);
    let mut encoder = H264Encoder::new(18, 18).expect("create padded VideoToolbox encoder");
    let avc = encode_test_frame(&mut encoder, &frame).await;

    assert_eq!((encoder.encoded_width, encoder.encoded_height), (32, 32));
    assert!(!avc.is_empty());
}

#[test]
fn graphics_timestamp_uses_the_session_clock() {
    let started = Instant::now();
    assert_eq!(
        frame_timestamp_ms(started, started + Duration::from_millis(1234)),
        1234
    );
}

#[test]
fn normalizes_avcc_nal_lengths_to_four_byte_prefixes() {
    let avcc = [0, 0, 0, 2, 0x67, 0xaa, 0, 0, 0, 3, 0x65, 0xbb, 0xcc];
    let mut normalized = Vec::new();
    avcc_to_four_byte(&avcc, 4, &mut normalized).unwrap();

    assert_eq!(
        normalized,
        [
            [0, 0, 0, 2].as_slice(),
            [0x67, 0xaa].as_slice(),
            [0, 0, 0, 3].as_slice(),
            [0x65, 0xbb, 0xcc].as_slice(),
        ]
        .concat()
    );
}

#[test]
fn rejects_truncated_avcc_nal_units() {
    let mut normalized = Vec::new();
    let error = avcc_to_four_byte(&[0, 0, 0, 4, 0x65], 4, &mut normalized).unwrap_err();
    assert!(error.to_string().contains("declares 4 bytes beyond"));
}

#[test]
fn normalizes_short_avcc_length_prefixes() {
    let avcc = [0, 2, 0x67, 0xaa, 0, 3, 0x65, 0xbb, 0xcc];
    let mut normalized = Vec::new();
    avcc_to_four_byte(&avcc, 2, &mut normalized).unwrap();

    assert_eq!(
        normalized,
        [
            [0, 0, 0, 2].as_slice(),
            [0x67, 0xaa].as_slice(),
            [0, 0, 0, 3].as_slice(),
            [0x65, 0xbb, 0xcc].as_slice(),
        ]
        .concat()
    );
}

fn parse_avc_nal_types(avc: &[u8]) -> Vec<u8> {
    let mut offset = 0;
    let mut types = Vec::new();
    while offset + 4 <= avc.len() {
        let length = u32::from_be_bytes([
            avc[offset],
            avc[offset + 1],
            avc[offset + 2],
            avc[offset + 3],
        ]) as usize;
        offset += 4;
        if length == 0 || offset + length > avc.len() {
            break;
        }
        types.push(avc[offset] & 0x1f);
        offset += length;
    }
    types
}
