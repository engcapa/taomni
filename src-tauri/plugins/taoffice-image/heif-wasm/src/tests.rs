use std::io::Cursor;

use super::*;

const QUADRANTS: &[u8] =
    include_bytes!("../../../../../qa-ui-auto-tests/fixtures/taoffice/heif-quadrants.heic");
const HEIF_GRID: &[u8] =
    include_bytes!("../../../../../qa-ui-auto-tests/fixtures/taoffice/heif-grid-422-10bit.heic");

fn assert_colors(input: &[u8], size: (u32, u32), expected: [[u8; 3]; 4], tolerance: u8) {
    let thumbnail = decode_thumbnail(input).unwrap();
    assert_eq!((thumbnail.width, thumbnail.height), size);
    let decoder = png::Decoder::new(Cursor::new(thumbnail.png));
    let mut reader = decoder.read_info().unwrap();
    let mut pixels = vec![0; reader.output_buffer_size().unwrap()];
    let info = reader.next_frame(&mut pixels).unwrap();
    assert_eq!((info.width, info.height), size);
    assert_eq!(info.color_type, png::ColorType::Rgba);
    let (width, height) = (info.width as usize, info.height as usize);
    let positions = [
        (width / 4, height / 4),
        (width * 3 / 4, height / 4),
        (width / 4, height * 3 / 4),
        (width * 3 / 4, height * 3 / 4),
    ];
    for ((x, y), color) in positions.into_iter().zip(expected) {
        let index = (y * width + x) * 4;
        assert_eq!(pixels[index + 3], 255, "{x}, {y}");
        for (channel, value) in color.into_iter().enumerate() {
            let found = pixels[index + channel];
            assert!(
                found.abs_diff(value) <= tolerance,
                "{x}, {y}: {found} != {value}"
            );
        }
    }
}

#[test]
fn converts_heic_still_to_png_with_the_expected_colors() {
    assert_colors(
        QUADRANTS,
        (160, 96),
        [[220, 42, 42], [36, 183, 61], [39, 83, 207], [224, 174, 28]],
        6,
    );
}

#[test]
fn composites_the_10_bit_heif_grid_with_colors_matching_apple_sips() {
    assert_colors(
        HEIF_GRID,
        (192, 128),
        [[214, 181, 94], [40, 182, 91], [214, 52, 44], [40, 52, 209]],
        4,
    );
}

#[test]
fn malformed_input_has_a_format_error_and_large_dimensions_have_a_limit_error() {
    assert_eq!(
        decode_thumbnail(&QUADRANTS[..64]).unwrap_err(),
        PreviewError::Format
    );
    let mut oversized = QUADRANTS.to_vec();
    let property = oversized
        .windows(4)
        .position(|bytes| bytes == b"ispe")
        .unwrap();
    oversized[property + 8..property + 12].copy_from_slice(&9000u32.to_be_bytes());
    assert_eq!(
        decode_thumbnail(&oversized).unwrap_err(),
        PreviewError::Limits
    );
}

#[test]
fn downsizes_the_longest_axis_without_bleeding_transparent_pixels_into_visible_colors() {
    let mut image = heic_rs::Image::zeroed(3200, 4, PixelLayout::Rgba8, MAX_PIXELS).unwrap();
    for pair in image.data.chunks_exact_mut(8) {
        pair.copy_from_slice(&[255, 20, 0, 0, 0, 128, 255, 255]);
    }
    let (width, height, pixels) = thumbnail_pixels(image);
    assert_eq!((width, height), (1600, 2));
    assert!(
        pixels
            .chunks_exact(4)
            .all(|pixel| pixel == [0, 128, 255, 127])
    );
}
