use super::control::ScrollControl;
use super::control::ScrollMode;
use super::frames::capture_frames;
use super::limits::MAX_FRAMES;
use super::sampling::settled_frame;
use super::sampling::stable_frame;
use super::stitching::Step;
use super::stitching::Stitcher;
#[cfg(test)]
use crate::screenshot::capture::crop;
use image::RgbaImage;
use std::sync::atomic::Ordering;
use std::time::Duration;

fn preview(frame: &mut RgbaImage, shade: u8) {
    for y in 96..224 {
        for x in 160..352 {
            frame.put_pixel(x, y, image::Rgba([shade, shade, shade, 255]));
        }
    }
}

#[test]
fn localized_video_preview_does_not_block_a_settled_page() {
    let original = page(640, 480);
    let mut a = original.clone();
    let mut b = original;
    preview(&mut a, 20);
    preview(&mut b, 220);
    assert!(stable_frame(&a, &b));
    assert!(!stable_frame(
        &page(640, 600),
        &view(&page(640, 1000), 120, 600, 0, 0)
    ));
}

#[test]
fn moving_thumbnail_preserves_the_correct_overlap_and_static_pixels() {
    let source = page(640, 1000);
    let mut first = view(&source, 0, 480, 0, 0);
    preview(&mut first, 20);
    let mut next = view(&source, 120, 480, 0, 0);
    preview(&mut next, 220);
    let mut stitcher = Stitcher::new(first);
    assert!(matches!(stitcher.push(next), Step::Appended));
    let result = stitcher.finish();
    assert_eq!(result.image.height(), 600);
    for y in 0..600 {
        assert_eq!(
            result.image.get_pixel(100, y),
            source.get_pixel(100, y),
            "row {y}"
        );
    }
}

#[test]
fn widespread_content_changes_require_overlap_recovery() {
    let source = page(640, 1000);
    let mut next = view(&source, 120, 480, 0, 0);
    for y in 0..480 {
        for x in 0..640 {
            next.put_pixel(x, y, image::Rgba([0, 0, 0, 255]));
        }
    }
    let mut stitcher = Stitcher::new(view(&source, 0, 480, 0, 0));
    assert!(matches!(stitcher.push(next), Step::Lost));
    assert_eq!(stitcher.finish().image.height(), 480);
}

#[test]
fn transient_edges_are_rejected_even_when_the_scrolling_center_matches() {
    let original = page(640, 300);
    let mut transient = original.clone();
    for y in 0..300 {
        for x in [0, 1, 638, 639] {
            transient.put_pixel(x, y, image::Rgba([255, 0, 0, 255]));
        }
    }
    assert!(!stable_frame(&original, &transient));
    let mut frames = [transient, original.clone(), original.clone()].into_iter();
    let control = ScrollControl::new(ScrollMode::Manual);
    let settled = settled_frame(&mut || Ok(frames.next().unwrap()), &mut |_| {}, &control).unwrap();
    assert_eq!(settled, Some(original));
}

#[test]
fn automatic_capture_does_not_scroll_again_while_a_frame_is_settling() {
    let page = page(64, 1000);
    let mut frames = [
        Some(view(&page, 0, 300, 0, 0)),
        None,
        None,
        Some(view(&page, 120, 300, 0, 0)),
    ]
    .into_iter();
    let control = ScrollControl::new(ScrollMode::Auto);
    let mut wheels = Vec::new();
    let out = capture_frames(
        &mut || Ok(frames.next().unwrap()),
        &mut |n| {
            wheels.push(n);
            Ok(())
        },
        &mut |_| {},
        &mut |n| {
            if n == 2 {
                control.request_stop(false);
            }
        },
        MAX_FRAMES,
        &control,
    )
    .unwrap();
    assert_eq!(wheels, [1]);
    assert_eq!(out.image, crop(&page, 0, 0, 64, 420));
}

#[test]
fn whole_window_matches_scrolling_content_beside_a_fixed_sidebar_and_changing_gutter() {
    let page = page(640, 1000);
    let frame = |offset| {
        let mut image = view(&page, offset, 300, 24, 18);
        for y in 0..300 {
            for x in 0..200 {
                // A vertically patterned sidebar cannot match a vertical shift.
                image.put_pixel(x, y, image::Rgba([(y % 255) as u8, 70, 120, 255]));
            }
            for x in 624..640 {
                image.put_pixel(x, y, image::Rgba([offset as u8, (y % 255) as u8, 30, 255]));
            }
        }
        image
    };
    let mut stitcher = Stitcher::new(frame(0));
    assert!(matches!(stitcher.push(frame(100)), Step::Appended));
    assert!(matches!(stitcher.push(frame(200)), Step::Appended));
    let out = stitcher.finish().image;
    assert_eq!(out.height(), 500);
    // The bottom border occurs only once, after all the original body rows.
    assert_eq!(
        crop(&out, 220, 24, 380, 458),
        crop(&page, 220, 24, 380, 458)
    );
    assert_eq!(
        crop(&out, 220, 482, 380, 18),
        crop(&frame(200), 220, 282, 380, 18)
    );
}

#[test]
fn fixed_side_arrows_and_corners_are_retained_once_without_cropping() {
    let page = page(240, 1000);
    let frame = |offset| {
        let mut image = view(&page, offset, 300, 0, 0);
        for y in 0..300 {
            for x in (0..12).chain(224..240) {
                let value = if y < 12 || y >= 288 { 30 } else { 240 };
                image.put_pixel(x, y, image::Rgba([value, value, value, 255]));
            }
        }
        // The scrollbar thumb changes its viewport position.
        for y in 20 + offset / 2..50 + offset / 2 {
            for x in 227..235 {
                image.put_pixel(x, y, image::Rgba([100, 100, 100, 255]));
            }
        }
        // A stationary, detailed desktop beside the scrollbar has no
        // plain spacer. It must not block extension of the thumb's track.
        for y in 0..300 {
            for x in 236..240 {
                image.put_pixel(x, y, image::Rgba([(y % 255) as u8, 40, 80, 255]));
            }
        }
        image
    };
    let mut stitcher = Stitcher::new(frame(0));
    for offset in [100, 200, 300, 400] {
        assert!(matches!(stitcher.push(frame(offset)), Step::Appended));
    }
    let out = stitcher.finish().image;
    assert_eq!(out.dimensions(), (240, 700));
    assert_eq!(crop(&out, 12, 0, 212, 700), crop(&page, 12, 0, 212, 700));
    for x in [0, 11, 224, 235] {
        let ends = (0..700).filter(|&y| out.get_pixel(x, y)[0] == 30).count();
        assert_eq!(ends, 24, "repeated corner/arrow at x={x}");
    }
    let thumb = (0..700)
        .filter(|&y| out.get_pixel(230, y)[0] == 100)
        .count();
    assert_eq!(thumb, 30, "scrollbar thumb must occur once");
}

#[test]
fn fixed_icons_and_scrollbar_beyond_a_wide_blank_margin_appear_once() {
    // A terminal: text only in the left part, a blank background wider
    // than a third of the window, then a fixed rail icon and a scrollbar.
    let page = page(200, 1000);
    let bg = image::Rgba([29, 31, 33, 255]);
    let frame = |offset: u32| {
        let mut image = RgbaImage::from_pixel(480, 300, bg);
        image::imageops::replace(&mut image, &view(&page, offset, 300, 0, 0), 0, 0);
        for y in 0..300 {
            for x in 470..480 {
                image.put_pixel(x, y, image::Rgba([10, 10, 10, 255]));
            }
        }
        for y in 100..116 {
            for x in 450..466 {
                image.put_pixel(x, y, image::Rgba([223, 247, 243, 255]));
            }
        }
        for y in 10 + offset / 4..40 + offset / 4 {
            for x in 436..444 {
                image.put_pixel(x, y, image::Rgba([70, 72, 73, 255]));
            }
        }
        image
    };
    let mut stitcher = Stitcher::new(frame(0));
    for offset in [100, 200, 300, 400] {
        assert!(matches!(stitcher.push(frame(offset)), Step::Appended));
    }
    let out = stitcher.finish().image;
    assert_eq!(out.dimensions(), (480, 700));
    assert_eq!(crop(&out, 0, 0, 200, 700), crop(&page, 0, 0, 200, 700));
    let count = |x: u32, value: u8| {
        (0..700)
            .filter(|&y| out.get_pixel(x, y)[0] == value)
            .count()
    };
    assert_eq!(count(458, 223), 16, "rail icon must occur once");
    assert_eq!(count(440, 70), 30, "scrollbar thumb must occur once");
}

#[test]
fn manual_pauses_do_not_finish_and_never_inject_wheel_input() {
    let page = page(64, 1000);
    let control = ScrollControl::new(ScrollMode::Manual);
    let mut reads = 0;
    let out = capture_frames(
        &mut || {
            reads += 1;
            Ok(Some(view(
                &page,
                if reads <= 12 { 0 } else { 120 },
                300,
                0,
                0,
            )))
        },
        &mut |_| panic!("manual mode must not synthesize input"),
        &mut |_| {},
        &mut |frames| {
            if frames == 2 {
                control.request_stop(false);
            }
        },
        MAX_FRAMES,
        &control,
    )
    .unwrap();
    assert_eq!(reads, 13);
    assert_eq!(out.image, crop(&page, 0, 0, 64, 420));
}

#[test]
fn automatic_capture_waits_through_two_unchanged_frames_before_motion() {
    let page = page(64, 1000);
    let control = ScrollControl::new(ScrollMode::Auto);
    let mut reads = 0;
    let mut wheels = Vec::new();
    let out = capture_frames(
        &mut || {
            reads += 1;
            Ok(Some(view(
                &page,
                if reads <= 3 { 0 } else { 120 },
                300,
                0,
                0,
            )))
        },
        &mut |n| {
            wheels.push(n);
            Ok(())
        },
        &mut |_| {},
        &mut |frames| {
            if frames == 2 {
                control.request_stop(false);
            }
        },
        MAX_FRAMES,
        &control,
    )
    .unwrap();
    assert_eq!(wheels, [1, 1, 1]);
    assert_eq!(out.image, crop(&page, 0, 0, 64, 420));
}

#[test]
fn automatic_capture_rereads_a_transient_unmatchable_frame_without_scrolling_again() {
    let page = page(64, 1000);
    let control = ScrollControl::new(ScrollMode::Auto);
    let mut reads = 0;
    let mut wheels = Vec::new();
    let out = capture_frames(
        &mut || {
            reads += 1;
            Ok(Some(match reads {
                1 => view(&page, 0, 300, 0, 0),
                2 => image::RgbaImage::from_pixel(64, 300, image::Rgba([0, 0, 0, 255])),
                _ => view(&page, 120, 300, 0, 0),
            }))
        },
        &mut |n| {
            wheels.push(n);
            Ok(())
        },
        &mut |_| {},
        &mut |frames| {
            if frames == 2 {
                control.request_stop(false);
            }
        },
        MAX_FRAMES,
        &control,
    )
    .unwrap();
    assert_eq!(wheels, [1]);
    assert_eq!(out.image, crop(&page, 0, 0, 64, 420));
}

#[test]
fn lazy_list_retries_input_after_content_arrives_below_the_viewport() {
    use std::cell::Cell;
    let page = page(64, 1000);
    let control = ScrollControl::new(ScrollMode::Auto);
    let offset = Cell::new(0);
    let loaded = Cell::new(false);
    let out = capture_frames(
        &mut || Ok(Some(view(&page, offset.get(), 300, 0, 0))),
        &mut |_| {
            if offset.get() == 0 || loaded.get() {
                offset.set(offset.get() + 120);
            }
            Ok(())
        },
        &mut |duration| {
            if duration == Duration::from_secs(2) {
                loaded.set(true);
            }
        },
        &mut |_| {},
        3,
        &control,
    )
    .unwrap();
    assert!(loaded.get());
    assert_eq!(out.frames, 3);
    assert_eq!(out.image, crop(&page, 0, 0, 64, 540));
}

#[test]
fn manual_is_the_default_mode() {
    assert_eq!(ScrollMode::default(), ScrollMode::Manual);
    assert_eq!(ScrollControl::default().mode(), ScrollMode::Manual);
}

#[test]
fn automatic_capture_survives_a_single_lost_step_at_one_notch() {
    let page = page(64, 2000);
    let control = ScrollControl::new(ScrollMode::Auto);
    // Scroll position follows the wheel; one forward step lands on an
    // unmatchable (lazy-rendering) frame, then recovers.
    let position = std::cell::Cell::new(0i32);
    let mut reads = 0;
    let mut glitch = true;
    let out = capture_frames(
        &mut || {
            reads += 1;
            if position.get() == 240 && glitch {
                glitch = reads < 6;
                return Ok(Some(RgbaImage::from_pixel(
                    64,
                    300,
                    image::Rgba([0, 0, 0, 255]),
                )));
            }
            Ok(Some(view(&page, position.get() as u32, 300, 0, 0)))
        },
        &mut |n| {
            position.set((position.get() + n * 120).max(0));
            Ok(())
        },
        &mut |_| {},
        &mut |frames| {
            if frames == 4 {
                control.request_stop(false);
            }
        },
        MAX_FRAMES,
        &control,
    )
    .unwrap();
    assert_eq!(
        control.mode(),
        ScrollMode::Auto,
        "one lost step must not force manual mode"
    );
    assert_eq!(out.image, crop(&page, 0, 0, 64, 660));
}

#[test]
fn manual_overlap_loss_keeps_the_anchor_until_the_user_returns() {
    let page = page(64, 2000);
    let mut probe = Stitcher::new(view(&page, 0, 300, 0, 0));
    let lost = probe.push(view(&page, 600, 300, 0, 0));
    assert!(
        matches!(lost, Step::Lost),
        "unexpected jump match: {lost:?}"
    );
    let control = ScrollControl::new(ScrollMode::Manual);
    let mut positions = [0, 600, 0, 120, 240].into_iter();
    let out = capture_frames(
        &mut || {
            Ok(Some(view(
                &page,
                positions.next().expect("capture should finish"),
                300,
                0,
                0,
            )))
        },
        &mut |_| panic!("unexpected OS input"),
        &mut |_| {},
        &mut |frames| {
            if frames == 3 {
                control.request_stop(false);
            }
        },
        MAX_FRAMES,
        &control,
    )
    .unwrap();
    assert_eq!(out.image, crop(&page, 0, 0, 64, 540));
    assert!(!control.needs_overlap.load(Ordering::SeqCst));
}

#[test]
fn cancellation_during_a_manual_pause_discards_the_capture() {
    let control = ScrollControl::new(ScrollMode::Manual);
    let result = capture_frames(
        &mut || Ok(Some(page(64, 300))),
        &mut |_| panic!("unexpected OS input"),
        &mut |_| control.request_stop(true),
        &mut |_| {},
        MAX_FRAMES,
        &control,
    );
    assert!(result.is_err());
}

/// A tall "page" of independently hashed 20px bands with a diagonal
/// texture, so duplicated or missing rows are detectable.
fn page(width: u32, height: u32) -> RgbaImage {
    RgbaImage::from_fn(width, height, |x, y| {
        // Mix all bits before reducing to a shade; reducing a linear
        // sequence directly can produce near-periodic stripe matches.
        let mut band = y / 20;
        band = (band ^ (band >> 16)).wrapping_mul(0x7feb352d);
        band = (band ^ (band >> 15)).wrapping_mul(0x846ca68b);
        band ^= band >> 16;
        let shade = (band % 200) as u8 + 20;
        // A diagonal texture keeps rows within a band distinguishable.
        let tex = ((x + y) % 7) as u8 * 3;
        image::Rgba([shade, shade.wrapping_add(tex), 255 - shade, 255])
    })
}

fn view(page: &RgbaImage, scroll: u32, h: u32, header: u32, footer: u32) -> RgbaImage {
    let w = page.width();
    let mut out = crop(page, 0, scroll, w, h);
    for y in 0..header {
        for x in 0..w {
            out.put_pixel(x, y, image::Rgba([10, 10, 10, 255]));
        }
    }
    for y in (h - footer)..h {
        for x in 0..w {
            out.put_pixel(x, y, image::Rgba([240, 240, 240, 255]));
        }
    }
    out
}

#[test]
fn stitches_scrolled_views_back_into_the_page() {
    let page = page(64, 1000);
    let mut stitcher = Stitcher::new(view(&page, 0, 300, 0, 0));
    for s in [120, 240, 360, 480, 600, 700] {
        assert!(matches!(
            stitcher.push(view(&page, s, 300, 0, 0)),
            Step::Appended
        ));
    }
    // Bottom reached: the same view again is "unchanged".
    assert!(matches!(
        stitcher.push(view(&page, 700, 300, 0, 0)),
        Step::Unchanged
    ));
    let out = stitcher.finish();
    assert_eq!(out.image.dimensions(), (64, 1000));
    assert_eq!(out.frames, 7);
    assert_eq!(out.image.as_raw(), page.as_raw());
}

#[test]
fn sticky_header_and_footer_appear_once() {
    let page = page(64, 900);
    let (h, header, footer) = (300, 30, 20);
    let mut stitcher = Stitcher::new(view(&page, 0, h, header, footer));
    for s in [100, 200, 300] {
        assert!(matches!(
            stitcher.push(view(&page, s, h, header, footer)),
            Step::Appended
        ));
    }
    let out = stitcher.finish();
    // Header, page rows [header, 300 + h - footer), then the footer:
    // the same layout as one 600-row view of the page.
    let body_end = 300 + h;
    assert_eq!(out.image.height(), body_end);
    let expected = view(&page, 0, body_end, header, footer);
    // Body rows between header and footer match the page exactly.
    for y in header..(body_end - footer) {
        assert_eq!(
            out.image.get_pixel(5, y),
            expected.get_pixel(5, y),
            "row {y}"
        );
    }
    assert_eq!(out.image.get_pixel(0, 0).0, [10, 10, 10, 255]);
    assert_eq!(out.image.get_pixel(0, body_end - 1).0, [240, 240, 240, 255]);
}

#[test]
fn unrelated_frames_do_not_stitch() {
    let a = RgbaImage::from_pixel(48, 120, image::Rgba([200, 30, 30, 255]));
    let b = RgbaImage::from_fn(48, 120, |_, y| image::Rgba([30, (y * 2) as u8, 30, 255]));
    let mut stitcher = Stitcher::new(a);
    assert!(matches!(stitcher.push(b), Step::Lost));
    assert_eq!(stitcher.finish().image.height(), 120);
}

#[test]
fn narrow_regions_do_not_dilute_mismatched_pixels() {
    let a = RgbaImage::from_pixel(8, 120, image::Rgba([20, 20, 20, 255]));
    let b = RgbaImage::from_pixel(8, 120, image::Rgba([30, 30, 30, 255]));
    let mut stitcher = Stitcher::new(a);
    assert!(matches!(stitcher.push(b), Step::Lost));
    assert_eq!(stitcher.finish().image.height(), 120);
}

#[test]
fn identical_frames_are_unchanged() {
    let page = page(48, 400);
    let mut stitcher = Stitcher::new(view(&page, 50, 200, 0, 0));
    assert!(matches!(
        stitcher.push(view(&page, 50, 200, 0, 0)),
        Step::Unchanged
    ));
}

#[test]
fn scrolling_past_the_region_is_lost() {
    let page = page(48, 2000);
    let mut stitcher = Stitcher::new(view(&page, 0, 200, 0, 0));
    assert!(matches!(
        stitcher.push(view(&page, 600, 200, 0, 0)),
        Step::Lost
    ));
}

#[test]
fn flat_regions_prefer_the_largest_overlap() {
    // Bottom 80 rows of `a` and top 80 rows of `b` are the same flat
    // color; the true shift is 40 rows (overlap 160 of 200).
    let mut page = page(48, 400);
    for y in 100..260 {
        for x in 0..48 {
            page.put_pixel(x, y, image::Rgba([90, 90, 90, 255]));
        }
    }
    let mut stitcher = Stitcher::new(view(&page, 60, 200, 0, 0));
    assert!(matches!(
        stitcher.push(view(&page, 100, 200, 0, 0)),
        Step::Appended
    ));
    let out = stitcher.finish();
    assert_eq!(out.image.height(), 240);
    assert_eq!(out.image.as_raw(), crop(&page, 0, 60, 48, 240).as_raw());
}
