use super::paths::clipboard_paths_from_uri_text;

#[test]
fn clipboard_uri_text_parses_uri_list() {
    let parsed = clipboard_paths_from_uri_text(
        "# copied from a file manager\nfile:///tmp/alpha%20one.txt\r\nfile:///tmp/beta\n",
    );

    assert_eq!(
        parsed,
        vec!["/tmp/alpha one.txt".to_string(), "/tmp/beta".to_string()]
    );
}

#[test]
fn clipboard_uri_text_parses_gnome_copied_files() {
    let parsed = clipboard_paths_from_uri_text(
        "copy\nfile:///home/me/project\nfile:///home/me/project/src\n",
    );

    assert_eq!(
        parsed,
        vec![
            "/home/me/project".to_string(),
            "/home/me/project/src".to_string()
        ]
    );
}

#[test]
fn clipboard_uri_text_deduplicates_paths() {
    let parsed =
        clipboard_paths_from_uri_text("file:///tmp/same\nfile:///tmp/same\nfile:///tmp/other\n");

    assert_eq!(
        parsed,
        vec!["/tmp/same".to_string(), "/tmp/other".to_string()]
    );
}

#[test]
fn clipboard_uri_text_parses_plain_absolute_paths() {
    let parsed = clipboard_paths_from_uri_text(
        "copy\n/home/me/plain file.txt\n/home/me/plain file.txt\n/home/me/dir\n",
    );

    assert_eq!(
        parsed,
        vec![
            "/home/me/plain file.txt".to_string(),
            "/home/me/dir".to_string()
        ]
    );
}

#[test]
fn clipboard_uri_text_parses_quoted_paths() {
    let single_quoted = clipboard_paths_from_uri_text("'/home/zhyhang/图片/2026-08-27_23-08.png'");
    assert_eq!(
        single_quoted,
        vec!["/home/zhyhang/图片/2026-08-27_23-08.png".to_string()]
    );

    let double_quoted = clipboard_paths_from_uri_text("\"/tmp/screenshot.png\"");
    assert_eq!(double_quoted, vec!["/tmp/screenshot.png".to_string()]);
}

#[test]
fn decode_clipboard_png_accepts_valid_png_and_rejects_empty_or_corrupt_bytes() {
    let mut encoded = Vec::new();
    let image = image::RgbaImage::from_pixel(2, 1, image::Rgba([12, 34, 56, 255]));
    image::DynamicImage::ImageRgba8(image)
        .write_to(
            &mut std::io::Cursor::new(&mut encoded),
            image::ImageFormat::Png,
        )
        .expect("encode 2x1 png");

    let decoded = super::clipboard::decode_clipboard_png(&encoded).expect("decode valid png");
    assert_eq!(decoded.dimensions(), (2, 1));
    assert_eq!(decoded.get_pixel(0, 0).0, [12, 34, 56, 255]);

    assert!(
        super::clipboard::decode_clipboard_png(&[])
            .expect_err("reject empty payload")
            .contains("empty")
    );
    assert!(
        super::clipboard::decode_clipboard_png(b"not a png")
            .expect_err("reject corrupt png")
            .contains("decode clipboard png")
    );
}
