use super::startup_isolation::marker_pixels;
use image::{Rgba, RgbaImage};

#[test]
fn magenta_marker_does_not_mistake_a_desktop_icon_for_window_residue() {
    let icon = RgbaImage::from_pixel(8, 8, Rgba([188, 59, 231, 255]));
    assert_eq!(marker_pixels(&icon), 0);
    let marker = RgbaImage::from_pixel(8, 8, Rgba([255, 0, 255, 255]));
    assert_eq!(marker_pixels(&marker), 64);
    let mut mixed = icon;
    mixed.put_pixel(3, 4, Rgba([250, 8, 247, 255]));
    assert_eq!(marker_pixels(&mixed), 1);
}
