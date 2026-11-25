use super::*;

fn sample() -> RgbaImage {
    // 3x2 so rows need no padding at 32 bpp but do at 24 bpp.
    RgbaImage::new(
        3,
        2,
        vec![
            255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, //
            10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255,
        ],
    )
    .unwrap()
}

#[test]
fn levels_are_ordered_and_parse_strictly() {
    assert_eq!(ClipboardLevel::parse(" Rich "), Some(ClipboardLevel::Rich));
    assert_eq!(ClipboardLevel::parse("everything"), None);
    assert!(ClipboardLevel::All.allows_files());
    assert!(!ClipboardLevel::Rich.allows_files());
    assert!(ClipboardLevel::Rich.allows_rich() && ClipboardLevel::Rich.allows_text());
    assert!(!ClipboardLevel::Text.allows_rich());
    assert!(!ClipboardLevel::Off.allows_text());
}

#[test]
fn cf_html_offsets_point_at_the_fragment() {
    let encoded = cf_html_encode("<b>雪 ❄</b>");
    let text = String::from_utf8(encoded.clone()).unwrap();
    let field = |name: &str| -> usize {
        let at = text.find(name).unwrap() + name.len();
        text[at..at + 10].parse().unwrap()
    };
    let (start, end) = (field("StartFragment:"), field("EndFragment:"));
    assert_eq!(&encoded[start..end], "<b>雪 ❄</b>".as_bytes());
    assert_eq!(
        field("EndHTML:"),
        encoded.len() - 1,
        "trailing NUL is outside EndHTML"
    );
    assert_eq!(cf_html_fragment(&encoded).as_deref(), Some("<b>雪 ❄</b>"));
}

#[test]
fn cf_html_uses_the_body_of_a_full_document() {
    let encoded = cf_html_encode("<html><BODY class=x><p>hi</p></BODY></html>");
    assert_eq!(cf_html_fragment(&encoded).as_deref(), Some("<p>hi</p>"));
    let text = String::from_utf8(encoded).unwrap();
    assert_eq!(
        text.matches("<html>").count(),
        1,
        "the document is not nested"
    );
}

#[test]
fn cf_html_decodes_foreign_producers() {
    // Shape written by Chromium on Windows: StartHTML/EndHTML may be -1.
    let body = "<html><body><!--StartFragment--><i>x</i><!--EndFragment--></body></html>";
    let header = "Version:1.0\r\nStartHTML:-1\r\nEndHTML:-1\r\nStartFragment:0000000000\r\nEndFragment:0000000000\r\n";
    let start = header.len() + body.find("<i>").unwrap();
    let end = header.len() + body.find("<!--EndFragment-->").unwrap();
    let header = header
        .replacen(
            "StartFragment:0000000000",
            &format!("StartFragment:{start:010}"),
            1,
        )
        .replacen(
            "EndFragment:0000000000",
            &format!("EndFragment:{end:010}"),
            1,
        );
    let data = format!("{header}{body}\0\0");
    assert_eq!(
        cf_html_fragment(data.as_bytes()).as_deref(),
        Some("<i>x</i>")
    );
    assert_eq!(cf_html_fragment(b"not a header"), None);
}

#[test]
fn dib_round_trip_keeps_pixels_and_orientation() {
    let image = sample();
    let decoded = dib_to_rgba(&rgba_to_dib(&image)).unwrap();
    // CF_DIB is BI_RGB, so alpha reads back opaque.
    let mut opaque = image.clone();
    opaque.pixels.chunks_exact_mut(4).for_each(|px| px[3] = 255);
    assert_eq!(decoded, opaque);
}

#[test]
fn dibv5_round_trip_keeps_alpha() {
    let image = sample();
    assert_eq!(dib_to_rgba(&rgba_to_dibv5(&image)).unwrap(), image);
}

#[test]
fn decodes_top_down_24_bit_with_row_padding() {
    // 3 pixels * 3 bytes = 9, padded to 12 per row; negative height = top-down.
    let mut dib = Vec::new();
    put_u32(&mut dib, 40);
    put_u32(&mut dib, 3);
    put_u32(&mut dib, (-2i32) as u32);
    put_u16(&mut dib, 1);
    put_u16(&mut dib, 24);
    put_u32(&mut dib, BI_RGB);
    dib.extend_from_slice(&[0; 20]);
    dib.extend_from_slice(&[0, 0, 255, 0, 255, 0, 255, 0, 0, 0, 0, 0]);
    dib.extend_from_slice(&[30, 20, 10, 60, 50, 40, 90, 80, 70, 0, 0, 0]);
    let decoded = dib_to_rgba(&dib).unwrap();
    assert_eq!(&decoded.pixels[..4], &[255, 0, 0, 255]);
    assert_eq!(&decoded.pixels[12..16], &[10, 20, 30, 255]);
}

#[test]
fn decodes_bitfields_masks_after_an_info_header() {
    // RGB565-like masks are rejected (16 bpp), 32-bit custom masks work.
    let mut dib = Vec::new();
    put_u32(&mut dib, 40);
    put_u32(&mut dib, 1);
    put_u32(&mut dib, 1);
    put_u16(&mut dib, 1);
    put_u16(&mut dib, 32);
    put_u32(&mut dib, BI_BITFIELDS);
    dib.extend_from_slice(&[0; 20]);
    put_u32(&mut dib, 0x0000_00FF); // red in the low byte
    put_u32(&mut dib, 0x0000_FF00);
    put_u32(&mut dib, 0x00FF_0000);
    dib.extend_from_slice(&[11, 22, 33, 0]);
    assert_eq!(dib_to_rgba(&dib).unwrap().pixels, vec![11, 22, 33, 255]);
}

#[test]
fn rejects_hostile_dibs() {
    assert!(dib_to_rgba(&[1, 2, 3]).is_err());
    let mut huge = rgba_to_dib(&sample());
    huge[4..8].copy_from_slice(&100_000u32.to_le_bytes());
    huge[8..12].copy_from_slice(&100_000u32.to_le_bytes());
    assert!(dib_to_rgba(&huge).unwrap_err().contains("limit"));
    let mut truncated = rgba_to_dib(&sample());
    truncated.truncate(50);
    assert!(dib_to_rgba(&truncated).unwrap_err().contains("truncated"));
}
