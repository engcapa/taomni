use super::cursor::read_rich_cursor;
use super::cursor::read_x_cursor;
use super::hextile::HEXTILE_ANY_SUBRECTS;
use super::hextile::HEXTILE_BG_SPECIFIED;
use super::hextile::HEXTILE_FG_SPECIFIED;
use super::hextile::HEXTILE_RAW;
use super::hextile::HextileState;
use super::hextile::decode_hextile_into;
use super::pixels::rgb_to_rgba;
use super::raw::decode_raw_into;
use super::raw::read_copyrect_source;
use super::zrle::ZRLE_PIPELINE_MIN_COMPRESSED;
use super::zrle::ZrleDecoder;
use super::zrle::decode_zrle_into;
use crate::vnc::limits::DecodeLimits;
use crate::vnc::pixel::PixelConverter;

use std::io::Cursor;

#[test]
fn raw_alpha_is_forced_opaque() {
    // 2x1 pixels, alpha bytes left at 0 by the server.
    let bytes: Vec<u8> = vec![10, 20, 30, 0, 40, 50, 60, 0];
    let mut cur = Cursor::new(bytes);
    let mut rgba = vec![0u8; 8];
    decode_raw_into(&mut cur, 2, 1, &PixelConverter::default(), &mut rgba).unwrap();
    assert_eq!(rgba, vec![10, 20, 30, 255, 40, 50, 60, 255]);
    assert!(
        decode_raw_into(
            &mut Cursor::new(vec![0u8; 8]),
            3,
            1,
            &PixelConverter::default(),
            &mut rgba
        )
        .is_err()
    );
}

#[test]
fn rich_cursor_applies_bitmask_alpha_and_hotspot() {
    let mut payload = vec![10, 20, 30, 0, 40, 50, 60, 0, 70, 80, 90, 0];
    payload.push(0b1010_0000);
    let mut reader = Cursor::new(payload);
    let cursor = read_rich_cursor(&mut reader, 1, 0, 3, 1, &PixelConverter::default()).unwrap();
    assert_eq!((cursor.hotspot_x, cursor.hotspot_y), (1, 0));
    assert_eq!((cursor.width, cursor.height), (3, 1));
    assert_eq!(
        cursor.rgba,
        vec![10, 20, 30, 255, 40, 50, 60, 0, 70, 80, 90, 255]
    );
}

#[test]
fn rich_cursor_rejects_invalid_geometry() {
    assert!(
        read_rich_cursor(
            &mut Cursor::new(Vec::<u8>::new()),
            3,
            0,
            3,
            1,
            &PixelConverter::default()
        )
        .is_err()
    );
    assert!(
        read_rich_cursor(
            &mut Cursor::new(Vec::<u8>::new()),
            0,
            0,
            513,
            1,
            &PixelConverter::default()
        )
        .is_err()
    );
}

#[test]
fn x_cursor_applies_colours_bitmap_mask_and_hotspot() {
    let mut payload = vec![10, 20, 30, 40, 50, 60];
    payload.extend_from_slice(&[0b1010_0000, 0b0100_0000]);
    payload.extend_from_slice(&[0b1100_0000, 0b0110_0000]);
    let mut reader = Cursor::new(payload);
    let cursor = read_x_cursor(&mut reader, 2, 1, 3, 2).unwrap();

    assert_eq!((cursor.hotspot_x, cursor.hotspot_y), (2, 1));
    assert_eq!((cursor.width, cursor.height), (3, 2));
    assert_eq!(
        cursor.rgba,
        vec![
            10, 20, 30, 255, 40, 50, 60, 255, 10, 20, 30, 0, 40, 50, 60, 0, 10, 20, 30, 255, 40,
            50, 60, 255,
        ]
    );
    assert_eq!(reader.position() as usize, reader.get_ref().len());
}

#[test]
fn x_cursor_rejects_invalid_geometry_and_truncated_payloads() {
    assert!(read_x_cursor(&mut Cursor::new(Vec::<u8>::new()), 3, 0, 3, 1).is_err());
    assert!(read_x_cursor(&mut Cursor::new(Vec::<u8>::new()), 0, 0, 513, 1).is_err());
    assert!(read_x_cursor(&mut Cursor::new(vec![0; 7]), 0, 0, 8, 1).is_err());
}

#[test]
fn zero_sized_x_cursor_is_hidden_without_consuming_payload() {
    let mut reader = Cursor::new(vec![1, 2, 3]);
    let cursor = read_x_cursor(&mut reader, 12, 34, 0, 10).unwrap();
    assert_eq!((cursor.width, cursor.height), (0, 0));
    assert!(cursor.rgba.is_empty());
    assert_eq!(reader.position(), 0);
}

#[test]
fn rgb_expansion_handles_the_last_pixel_without_overreading() {
    let src = [1u8, 2, 3, 4, 5, 6, 7, 8, 9];
    let mut dst = [0u8; 12];
    rgb_to_rgba(&src, &mut dst);
    assert_eq!(dst, [1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255]);
    let mut one = [0u8; 4];
    rgb_to_rgba(&src[..3], &mut one);
    assert_eq!(one, [1, 2, 3, 255]);
}

#[test]
fn copyrect_source_reads_exactly_four_bytes() {
    let mut payload = Cursor::new(vec![0u8, 2, 0, 3, 9]);
    assert_eq!(read_copyrect_source(&mut payload).unwrap(), (2, 3));
    assert_eq!(payload.position(), 4);
}

#[test]
fn hextile_raw_subencoding_reads_exact_bytes() {
    let mut payload = vec![HEXTILE_RAW]; // subenc byte
    payload.extend_from_slice(&[255, 0, 0, 0, 0, 255, 0, 0]); // 2 pixels
    // 2x1 rect, exactly one tile
    let mut cur = Cursor::new(&payload);
    let mut st = HextileState::new();
    let mut rgba = vec![0u8; 8];
    decode_hextile_into(
        &mut cur,
        2,
        1,
        &mut st,
        &PixelConverter::default(),
        &mut rgba,
    )
    .unwrap();
    // Alpha forced to 255.
    assert_eq!(rgba, vec![255, 0, 0, 255, 0, 255, 0, 255]);
    // No trailing bytes consumed from the cursor.
    assert_eq!(cur.position() as usize, payload.len());
}

#[test]
fn hextile_bg_fg_persist_across_tiles() {
    // Two 16x1 tiles. First tile sets bg to red, no subrects. Second tile
    // has no bg flag and no subrects — should still paint red.
    let mut payload = Vec::new();
    payload.push(HEXTILE_BG_SPECIFIED);
    payload.extend_from_slice(&[255, 0, 0, 0]);
    payload.push(0);
    let mut cur = Cursor::new(&payload);
    let mut st = HextileState::new();
    let mut rgba = vec![0u8; 32 * 4];
    decode_hextile_into(
        &mut cur,
        32,
        1,
        &mut st,
        &PixelConverter::default(),
        &mut rgba,
    )
    .unwrap();
    for p in rgba.chunks_exact(4) {
        assert_eq!(p, &[255, 0, 0, 255]);
    }
}

#[test]
fn hextile_subrects_paint_inside_their_tile_with_stride() {
    // 20x2 rect = tiles (16x2) and (4x2). Tile 2: bg blue, one fg subrect
    // at (1,1) size 2x1 in green; subrects must land at x=17..19, y=1.
    let mut payload = vec![HEXTILE_BG_SPECIFIED];
    payload.extend_from_slice(&[0, 0, 0, 0]);
    payload.push(HEXTILE_BG_SPECIFIED | HEXTILE_FG_SPECIFIED | HEXTILE_ANY_SUBRECTS);
    payload.extend_from_slice(&[0, 0, 255, 0]);
    payload.extend_from_slice(&[0, 255, 0, 0]);
    payload.push(1);
    payload.extend_from_slice(&[0x11, 0x10]);
    let mut st = HextileState::new();
    let mut rgba = vec![0u8; 20 * 2 * 4];
    decode_hextile_into(
        &mut Cursor::new(&payload),
        20,
        2,
        &mut st,
        &PixelConverter::default(),
        &mut rgba,
    )
    .unwrap();
    let px = |x: usize, y: usize| &rgba[(y * 20 + x) * 4..(y * 20 + x) * 4 + 4];
    assert_eq!(px(16, 0), &[0, 0, 255, 255]);
    assert_eq!(px(17, 1), &[0, 255, 0, 255]);
    assert_eq!(px(18, 1), &[0, 255, 0, 255]);
    assert_eq!(px(19, 1), &[0, 0, 255, 255]);
    assert_eq!(px(15, 1), &[0, 0, 0, 255]);
}

#[test]
fn zrle_solid_tile_with_persistent_stream() {
    use flate2::Compression;
    use flate2::write::ZlibEncoder;
    use std::io::Write;

    // One 64x64 ZRLE tile, subenc=1 (solid), CPIXEL = [R,G,B] = [255,0,0].
    let uncompressed: Vec<u8> = vec![1u8, 255, 0, 0];
    let mut enc = ZlibEncoder::new(Vec::new(), Compression::default());
    enc.write_all(&uncompressed).unwrap();
    let compressed = enc.finish().unwrap();

    let mut payload = Vec::new();
    payload.extend_from_slice(&(compressed.len() as u32).to_be_bytes());
    payload.extend_from_slice(&compressed);

    let mut cur = Cursor::new(&payload);
    let mut dec = ZrleDecoder::new();
    let mut rgba = vec![0u8; 64 * 64 * 4];
    decode_zrle_into(
        &mut cur,
        64,
        64,
        &mut dec,
        &DecodeLimits::default(),
        &PixelConverter::default(),
        &mut rgba,
    )
    .unwrap();
    assert_eq!(rgba.len(), 64 * 64 * 4);
    for p in rgba.chunks_exact(4) {
        assert_eq!(p, &[255, 0, 0, 255]);
    }
}

#[test]
fn zrle_plain_rle_with_run_length_continuation() {
    use flate2::Compression;
    use flate2::write::ZlibEncoder;
    use std::io::Write;

    // subenc=128, colour = green (0,255,0), run length = 1 + 255 + 0 = 256
    // (covers every pixel of a 16x16 tile == 256).
    let mut uncompressed = vec![128u8, 0, 255, 0];
    uncompressed.push(255); // keep reading
    uncompressed.push(0); // terminator
    let mut enc = ZlibEncoder::new(Vec::new(), Compression::default());
    enc.write_all(&uncompressed).unwrap();
    let compressed = enc.finish().unwrap();
    let mut payload = Vec::new();
    payload.extend_from_slice(&(compressed.len() as u32).to_be_bytes());
    payload.extend_from_slice(&compressed);

    let mut cur = Cursor::new(&payload);
    let mut dec = ZrleDecoder::new();
    let mut rgba = vec![0u8; 16 * 16 * 4];
    decode_zrle_into(
        &mut cur,
        16,
        16,
        &mut dec,
        &DecodeLimits::default(),
        &PixelConverter::default(),
        &mut rgba,
    )
    .unwrap();
    assert_eq!(rgba.len(), 16 * 16 * 4);
    for p in rgba.chunks_exact(4) {
        assert_eq!(p, &[0, 255, 0, 255]);
    }
}

#[test]
fn zrle_preserves_zlib_state_across_rects() {
    // Two ZRLE rectangles share a single zlib stream. We build the stream
    // with two FlushCompress::Sync-delimited chunks so the inflater can
    // pause mid-stream and resume on the next rectangle.
    use flate2::{Compress, Compression, FlushCompress};

    fn emit(zlib: &mut Compress, input: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        let in_before = zlib.total_in();
        let target_in = in_before + input.len() as u64;
        let mut src_pos = 0usize;

        // Loop until all input has been consumed AND the Sync flush has
        // flushed everything to the output buffer.
        loop {
            let mut scratch = vec![0u8; 256];
            let prod_before = zlib.total_out();
            zlib.compress(&input[src_pos..], &mut scratch, FlushCompress::Sync)
                .unwrap();
            let produced = (zlib.total_out() - prod_before) as usize;
            out.extend_from_slice(&scratch[..produced]);
            src_pos = (zlib.total_in() - in_before) as usize;

            if zlib.total_in() == target_in && produced < scratch.len() {
                break;
            }
            if produced == 0 {
                break;
            }
        }
        out
    }

    let mut zlib = Compress::new(Compression::default(), true);
    let rect1 = emit(&mut zlib, &[1u8, 255, 0, 0]); // solid red tile
    let rect2 = emit(&mut zlib, &[1u8, 0, 0, 255]); // solid blue tile

    let mut payload1 = Vec::new();
    payload1.extend_from_slice(&(rect1.len() as u32).to_be_bytes());
    payload1.extend_from_slice(&rect1);
    let mut cur1 = Cursor::new(&payload1);
    let mut dec = ZrleDecoder::new();
    let mut rgba = vec![0u8; 64 * 64 * 4];
    decode_zrle_into(
        &mut cur1,
        64,
        64,
        &mut dec,
        &DecodeLimits::default(),
        &PixelConverter::default(),
        &mut rgba,
    )
    .unwrap();
    assert_eq!(rgba[0..4], [255, 0, 0, 255]);

    let mut payload2 = Vec::new();
    payload2.extend_from_slice(&(rect2.len() as u32).to_be_bytes());
    payload2.extend_from_slice(&rect2);
    let mut cur2 = Cursor::new(&payload2);
    decode_zrle_into(
        &mut cur2,
        64,
        64,
        &mut dec,
        &DecodeLimits::default(),
        &PixelConverter::default(),
        &mut rgba,
    )
    .unwrap();
    assert_eq!(rgba[0..4], [0, 0, 255, 255]);
}

#[test]
fn zrle_large_rectangles_decode_through_the_overlapped_inflater() {
    use flate2::{Compress, Compression, FlushCompress};

    // 512x256 raw tiles of pseudo-random pixels: incompressible, so the
    // body exceeds the pipelined threshold. A second small rectangle on
    // the same zlib stream must still decode sequentially afterwards.
    let (w, h) = (512u16, 256u16);
    let mut seed = 0x1234_5678u32;
    let mut next = || {
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        seed
    };
    let mut expected = vec![0u8; usize::from(w) * usize::from(h) * 4];
    let mut tiles = Vec::new();
    for ty in (0..h).step_by(64) {
        for tx in (0..w).step_by(64) {
            tiles.push(0u8);
            for y in ty..ty + 64 {
                for x in tx..tx + 64 {
                    let value = next().to_le_bytes();
                    tiles.extend_from_slice(&value[..3]);
                    let at = (usize::from(y) * usize::from(w) + usize::from(x)) * 4;
                    expected[at..at + 4].copy_from_slice(&[value[0], value[1], value[2], 255]);
                }
            }
        }
    }
    let mut stream = Compress::new(Compression::fast(), true);
    let mut emit = |input: &[u8]| {
        let mut out = vec![0u8; input.len() + input.len() / 10 + 1024];
        let before = stream.total_out();
        stream
            .compress(input, &mut out, FlushCompress::Sync)
            .unwrap();
        out.truncate((stream.total_out() - before) as usize);
        let mut payload = (out.len() as u32).to_be_bytes().to_vec();
        payload.extend(out);
        payload
    };
    let first = emit(&tiles);
    assert!(first.len() > ZRLE_PIPELINE_MIN_COMPRESSED);
    let second = emit(&[1, 9, 8, 7]);

    let mut dec = ZrleDecoder::new();
    let mut rgba = vec![0u8; expected.len()];
    decode_zrle_into(
        &mut Cursor::new(&first),
        w,
        h,
        &mut dec,
        &DecodeLimits::default(),
        &PixelConverter::default(),
        &mut rgba,
    )
    .unwrap();
    assert!(
        rgba == expected,
        "pipelined decode differs from the source pixels"
    );
    assert_eq!(dec.pos, 0);
    assert!(dec.buf.is_empty());

    let mut small = vec![0u8; 4 * 4 * 4];
    decode_zrle_into(
        &mut Cursor::new(&second),
        4,
        4,
        &mut dec,
        &DecodeLimits::default(),
        &PixelConverter::default(),
        &mut small,
    )
    .unwrap();
    assert!(small.chunks_exact(4).all(|p| p == [9, 8, 7, 255]));
}

#[test]
fn zrle_decompresses_output_larger_than_initial_buffer() {
    // Regression for "zrle: eof cpixel": real ZRLE streams are a single
    // persistent zlib stream that spans the whole session, so the inflater
    // never sees a StreamEnd marker. It is NOT enough to stop decompressing
    // the moment the input slice is drained — the inflater can still have
    // bytes queued internally, and those need to be pulled out with one
    // more call (empty input) before we hand the buffer off to the tile
    // decoder. Otherwise the tile decoder runs off the end with `eof cpixel`.
    //
    // Build a rectangle whose tile stream is well over 64 KB and wrap it
    // in a Sync-flushed zlib frame (no StreamEnd), just like a real server
    // would transmit one rectangle within an ongoing session.
    use flate2::{Compress, Compression, FlushCompress};

    let rect_w: u16 = 256;
    let rect_h: u16 = 256;
    let tile_w: u16 = 64;
    let tile_h: u16 = 64;

    let mut uncompressed: Vec<u8> = Vec::new();
    let tiles_x = rect_w / tile_w;
    let tiles_y = rect_h / tile_h;
    for _ in 0..tiles_y {
        for _ in 0..tiles_x {
            uncompressed.push(0u8); // subenc = raw CPIXEL stream
            for _ in 0..(tile_w as usize * tile_h as usize) {
                // Distinctive colour so we detect any byte-alignment bug.
                uncompressed.extend_from_slice(&[0x12, 0x34, 0x56]);
            }
        }
    }
    assert!(uncompressed.len() > 64 * 1024);

    // Compress with Sync flush so the output is complete but the stream
    // is NOT terminated (zlib would otherwise emit StreamEnd, which hides
    // the bug via an early loop exit).
    let mut zlib = Compress::new(Compression::default(), true);
    let mut compressed: Vec<u8> = Vec::new();
    let mut src_pos = 0usize;
    loop {
        let mut scratch = vec![0u8; 32 * 1024];
        let in_before = zlib.total_in();
        let out_before = zlib.total_out();
        zlib.compress(&uncompressed[src_pos..], &mut scratch, FlushCompress::Sync)
            .unwrap();
        let consumed = (zlib.total_in() - in_before) as usize;
        let produced = (zlib.total_out() - out_before) as usize;
        compressed.extend_from_slice(&scratch[..produced]);
        src_pos += consumed;
        if src_pos >= uncompressed.len() && produced < scratch.len() {
            break;
        }
        if consumed == 0 && produced == 0 {
            break;
        }
    }

    let mut payload = Vec::new();
    payload.extend_from_slice(&(compressed.len() as u32).to_be_bytes());
    payload.extend_from_slice(&compressed);

    let mut cur = Cursor::new(&payload);
    let mut dec = ZrleDecoder::new();
    let mut rgba = vec![0u8; rect_w as usize * rect_h as usize * 4];
    decode_zrle_into(
        &mut cur,
        rect_w,
        rect_h,
        &mut dec,
        &DecodeLimits::default(),
        &PixelConverter::default(),
        &mut rgba,
    )
    .unwrap();
    assert_eq!(
        dec.pos, 0,
        "every inflated byte of the {tiles_x}x{tiles_y} tiles is consumed"
    );
    for p in rgba.chunks_exact(4) {
        assert_eq!(p, &[0x12, 0x34, 0x56, 255]);
    }
}
