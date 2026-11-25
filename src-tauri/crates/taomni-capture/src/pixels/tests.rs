use super::*;
use crate::engine::Frame;

#[test]
fn luma_keeps_order_and_composites_transparent_backgrounds_over_white() {
    let rgba = [255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255, 0, 0, 0, 0];
    assert_eq!(rgba_to_luma(&rgba, 2, 2).unwrap(), [255, 0, 76, 255]);
    assert!(rgba_to_luma(&rgba, 3, 2).is_err());
    assert!(rgba_to_luma(&rgba, u32::MAX, u32::MAX).is_err());
    assert!(rgba_to_luma(&[], 0, 0).is_err());
}

#[test]
fn x11_luma_normalizes_both_server_byte_orders() {
    let bgrx = [255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 255, 0];
    let xrgb = [0, 255, 255, 255, 0, 0, 0, 0, 0, 255, 0, 0];
    assert_eq!(zpixmap_to_luma(&bgrx, 3, 1, true).unwrap(), [255, 0, 76]);
    assert_eq!(zpixmap_to_luma(&xrgb, 3, 1, false).unwrap(), [255, 0, 76]);
    assert!(zpixmap_to_luma(&bgrx, 4, 1, true).is_err());
    assert!(zpixmap_to_luma(&bgrx, u32::MAX, u32::MAX, false).is_err());
}

#[test]
fn bgra_region_conversion_retains_stride_and_frame_contract() {
    let frame = Frame::bgra(
        vec![10, 20, 30, 255, 0, 0, 0, 0, 1, 2, 3, 4, 0, 0, 0, 0],
        0,
        0,
        1,
        2,
        8,
    );
    assert_eq!(frame.byte_len(), 16);
    assert_eq!(frame.sequence, 0);
    let copy = frame.clone();
    assert_eq!(
        frame.bgra_bytes().unwrap().as_ptr(),
        copy.bgra_bytes().unwrap().as_ptr()
    );
    let rgba = frame_to_rgba(&frame).unwrap();
    assert_eq!(rgba.get_pixel(0, 0).0, [30, 20, 10, 255]);
    assert_eq!(rgba.get_pixel(0, 1).0, [3, 2, 1, 4]);
    assert_eq!(
        frame_region_to_rgba(&frame, (0, 1, 1, 1)).unwrap().as_raw(),
        &[3, 2, 1, 4]
    );
    assert!(frame_to_rgba(&Frame::bgra(vec![0; 4], 0, 0, 1, 2, 8)).is_err());
}
