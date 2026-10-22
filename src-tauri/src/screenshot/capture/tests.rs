use super::artifacts::artifact_dir;
use super::artifacts::ensure_artifact_path;
use super::artifacts::save_png;
use super::displays::DisplayInfo;
use super::pixels::clamp_region;
use super::pixels::crop;
use super::pixels::frame_region_to_rgba;
use super::pixels::frame_to_rgba;
use super::pixels::map_region;
use crate::servers::rdp::capture::Frame;
use image::RgbaImage;

#[cfg(target_os = "linux")]
#[test]
fn gdk_geometry_restores_each_monitors_logical_origin_and_size() {
    let display = DisplayInfo {
        id: "-3840,0".into(),
        name: "left 200%".into(),
        x: -3840,
        y: 0,
        width: 2560,
        height: 1440,
        scale_factor: 2.0,
        primary: false,
    };
    assert_eq!(display.logical_rect(), (-1920, 0, 1280, 720));
}

#[test]
fn clamp_region_stays_inside_image() {
    assert_eq!(clamp_region(100, 50, (90, 40, 30, 30)), (90, 40, 10, 10));
    assert_eq!(clamp_region(100, 50, (500, 500, 10, 10)), (99, 49, 1, 1));
    assert_eq!(clamp_region(100, 50, (0, 0, 0, 0)), (0, 0, 1, 1));
}

#[test]
fn map_region_scales_into_point_sized_frames() {
    // A Retina display streamed at points: half the physical size.
    assert_eq!(
        map_region((200, 100, 400, 300), (2880, 1800), (1440, 900)),
        (100, 50, 200, 150)
    );
    assert_eq!(
        map_region((10, 20, 30, 40), (1920, 1080), (1920, 1080)),
        (10, 20, 30, 40)
    );
}

#[test]
fn display_contains_uses_half_open_bounds() {
    let d = DisplayInfo {
        id: "-1920,0".into(),
        name: "Left".into(),
        width: 1920,
        height: 1080,
        x: -1920,
        y: 0,
        scale_factor: 1.0,
        primary: false,
    };
    assert!(d.contains(-1920.0, 0.0));
    assert!(d.contains(-1.0, 1079.0));
    assert!(!d.contains(0.0, 0.0));
}

#[test]
fn artifact_paths_are_confined_to_the_artifact_dir() {
    let (path, _, _) = save_png(&RgbaImage::new(2, 2), "unit").unwrap();
    assert!(ensure_artifact_path(&path.to_string_lossy()).is_ok());
    let outside = std::env::temp_dir().join(format!("taomni-outside-{}.png", std::process::id()));
    std::fs::write(&outside, b"x").unwrap();
    assert!(ensure_artifact_path(&outside.to_string_lossy()).is_err());
    let traversal = artifact_dir()
        .unwrap()
        .join("..")
        .join("..")
        .join(outside.file_name().unwrap());
    assert!(ensure_artifact_path(&traversal.to_string_lossy()).is_err());
    std::fs::remove_file(outside).ok();
    std::fs::remove_file(path).ok();
}

#[test]
fn cropped_frame_conversion_matches_full_crop_with_stride_padding() {
    let (width, height, stride) = (7u16, 6u16, 36usize);
    let mut data = vec![0u8; stride * usize::from(height)];
    for y in 0..usize::from(height) {
        for x in 0..usize::from(width) {
            let i = y * stride + x * 4;
            data[i..i + 4].copy_from_slice(&[x as u8, y as u8, (x + y) as u8, 255]);
        }
    }
    let frame = Frame::bgra(data, 0, 0, width, height, stride);
    let full = frame_to_rgba(&frame).unwrap();
    for rect in [(2, 1, 3, 4), (5, 4, 20, 20), (0, 0, 7, 6)] {
        let (x, y, w, h) = rect;
        assert_eq!(
            frame_region_to_rgba(&frame, rect).unwrap(),
            crop(&full, x, y, w, h)
        );
    }
    let small = frame_region_to_rgba(&frame, (2, 1, 3, 4)).unwrap();
    assert_eq!(small.dimensions(), (3, 4));
    assert_eq!(small.get_pixel(0, 0).0, [3, 1, 2, 255]);
}

#[test]
fn cropped_frame_conversion_rejects_incomplete_rows() {
    let frame = Frame::bgra(vec![0u8; 12], 0, 0, 3, 2, 12);
    assert!(frame_region_to_rgba(&frame, (1, 1, 1, 1)).is_err());
    let frame = Frame::bgra(vec![0u8; 24], 0, 0, 3, 2, 8);
    assert!(frame_region_to_rgba(&frame, (0, 0, 1, 1)).is_err());
}

#[test]
fn frame_conversion_swaps_channels_and_honours_stride() {
    // 1x2 frame with 8 bytes of padding per row.
    let mut data = vec![0u8; 2 * 12];
    data[0..4].copy_from_slice(&[10, 20, 30, 255]);
    data[12..16].copy_from_slice(&[1, 2, 3, 4]);
    let frame = Frame::bgra(data, 0, 0, 1, 2, 12);
    let image = frame_to_rgba(&frame).unwrap();
    assert_eq!(image.get_pixel(0, 0).0, [30, 20, 10, 255]);
    assert_eq!(image.get_pixel(0, 1).0, [3, 2, 1, 4]);
}
