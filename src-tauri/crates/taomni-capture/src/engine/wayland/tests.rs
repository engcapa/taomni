use super::frames::raw_to_frame;
use super::limits::MAX_DIMENSION;
use super::mailbox::FrameMailbox;
use super::pipewire::copy_pipewire_bgra;
use super::startup::MonitorTarget;
use super::startup::monitor_stream_index;
use pipewire::spa::param::video::VideoFormat;
use std::time::Duration;

#[test]
fn monitor_stream_selection_uses_logical_geometry_not_stream_order() {
    let target = MonitorTarget {
        position: (1920, 0),
        size: (1280, 720),
        single_monitor: false,
    };
    let streams = [
        (Some((0, 0)), Some((1920, 1080))),
        (Some((1920, 0)), Some((1280, 720))),
    ];
    assert_eq!(monitor_stream_index(&streams, target).unwrap(), 1);
    assert_eq!(
        monitor_stream_index(&[streams[1], streams[0]], target).unwrap(),
        0
    );
    assert!(monitor_stream_index(&[streams[0]], target).is_err());
    assert!(monitor_stream_index(&[(None, None)], target).is_err());
    assert!(monitor_stream_index(&[streams[1], streams[1]], target).is_err());
}

#[test]
fn only_an_os_single_monitor_allows_missing_portal_metadata() {
    let target = MonitorTarget {
        position: (-1920, 0),
        size: (1920, 1080),
        single_monitor: true,
    };
    assert_eq!(monitor_stream_index(&[(None, None)], target).unwrap(), 0);
    assert!(monitor_stream_index(&[(Some((0, 0)), None)], target).is_err());
}

#[test]
fn session_detection_prefers_wayland_even_with_xwayland() {
    assert!(session_is_wayland(Some("wayland-0"), Some("wayland")));
    assert!(session_is_wayland(None, Some("WAYLAND")));
    assert!(!session_is_wayland(None, Some("x11")));
}

fn session_is_wayland(wayland_display: Option<&str>, session_type: Option<&str>) -> bool {
    wayland_display.is_some()
        || session_type.is_some_and(|value| value.eq_ignore_ascii_case("wayland"))
}

#[test]
fn pipewire_bgrx_honors_stride_and_discards_padding() {
    let source = [
        1, 2, 3, 0, 4, 5, 6, 0, 99, 99, 99, 99, 7, 8, 9, 0, 10, 11, 12, 0, 88, 88, 88, 88,
    ];
    let frame = copy_pipewire_bgra(&source, 0, source.len(), 12, 2, 2, VideoFormat::BGRx).unwrap();
    assert_eq!(
        frame.bgra,
        vec![1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255,]
    );
}

#[test]
fn pipewire_rgba_swaps_red_and_blue_and_handles_bottom_up() {
    let source = [1, 2, 3, 4, 5, 6, 7, 8];
    let frame = copy_pipewire_bgra(&source, 0, source.len(), -4, 1, 2, VideoFormat::RGBA).unwrap();
    assert_eq!(frame.bgra, vec![7, 6, 5, 255, 3, 2, 1, 255]);
}

#[test]
fn pipewire_rejects_truncated_or_oversized_frames() {
    assert!(copy_pipewire_bgra(&[0; 4], 0, 4, 8, 2, 1, VideoFormat::BGRx).is_err());
    assert!(copy_pipewire_bgra(&[], 0, 0, 0, MAX_DIMENSION + 1, 1, VideoFormat::BGRx).is_err());
}

#[test]
fn pipewire_conversion_keeps_opaque_bgra_for_every_supported_format() {
    for format in [
        VideoFormat::BGRx,
        VideoFormat::BGRA,
        VideoFormat::RGBx,
        VideoFormat::RGBA,
        VideoFormat::BGR,
        VideoFormat::RGB,
    ] {
        let bgr = matches!(
            format,
            VideoFormat::BGRx | VideoFormat::BGRA | VideoFormat::BGR
        );
        let mut bytes = if bgr {
            vec![30, 20, 10]
        } else {
            vec![10, 20, 30]
        };
        if !matches!(format, VideoFormat::BGR | VideoFormat::RGB) {
            bytes.push(0);
        }
        let raw =
            copy_pipewire_bgra(&bytes, 0, bytes.len(), bytes.len() as i32, 1, 1, format).unwrap();
        let captured_at = raw.captured_at;
        let frame = raw_to_frame(raw).unwrap();
        assert_eq!(frame.data.as_ref(), &[30, 20, 10, 255]);
        assert_eq!(frame.captured_at, captured_at);
    }
}

#[test]
fn mailbox_close_wakes_waiters_and_reports_closed_stream() {
    let mailbox = FrameMailbox::default();
    mailbox.close();
    assert!(mailbox.is_closed());
    assert!(
        mailbox
            .take_timeout(Duration::from_millis(1))
            .unwrap()
            .is_none()
    );
}
