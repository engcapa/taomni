use super::control::ScrollControl;
use super::limits::FRAME_CONFIRM;
use image::RgbaImage;
use std::sync::atomic::Ordering;
use std::time::Duration;

/// Check RGB pixels in small tiles, sampling alternate rows. A thin border must not be
/// diluted by a large unchanged center as it is in an image-wide luma mean.
pub(super) fn stable_frame(a: &RgbaImage, b: &RgbaImage) -> bool {
    if a.dimensions() != b.dimensions() {
        return false;
    }
    let (w, h) = a.dimensions();
    let mut moving_tiles = 0;
    let mut tiles = 0;
    for y in (0..h).step_by(32) {
        for x in (0..w).step_by(32) {
            let mut changed = 0;
            let (right, bottom) = ((x + 32).min(w), (y + 32).min(h));
            for cy in (y..bottom).step_by(2) {
                for cx in x..right {
                    let p = a.get_pixel(cx, cy);
                    let q = b.get_pixel(cx, cy);
                    if (0..3).any(|c| p[c].abs_diff(q[c]) > 12) {
                        changed += 1;
                    }
                }
            }
            if changed * 100 > (right - x) * (bottom - y).div_ceil(2) * 4 {
                // Keep strict edge checks: transient window borders must not
                // be stitched. A localized preview inside a settled page can
                // animate without preventing every subsequent capture.
                if x == 0 || y == 0 || right == w || bottom == h {
                    return false;
                }
                moving_tiles += 1;
            }
            tiles += 1;
        }
    }
    moving_tiles * 100 <= tiles * 15
}

/// Wait for two mostly agreeing samples, including in manual mode. Return no frame
/// during motion: never stitch a transient frame just because its center fits.
pub(super) fn settled_frame(
    grab: &mut impl FnMut() -> anyhow::Result<RgbaImage>,
    wait: &mut impl FnMut(Duration),
    control: &ScrollControl,
) -> anyhow::Result<Option<RgbaImage>> {
    let mut previous = grab()?;
    for _ in 0..8 {
        wait(FRAME_CONFIRM);
        if control.stop.load(Ordering::SeqCst) {
            return Ok(None);
        }
        let frame = grab()?;
        if stable_frame(&previous, &frame) {
            control.waiting_for_content.store(false, Ordering::SeqCst);
            return Ok(Some(frame));
        }
        previous = frame;
    }
    control.waiting_for_content.store(true, Ordering::SeqCst);
    Ok(None)
}
