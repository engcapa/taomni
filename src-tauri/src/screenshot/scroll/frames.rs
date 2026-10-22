use super::control::ScrollControl;
use super::control::ScrollMode;
use super::limits::LOST_LIMIT;
use super::limits::MANUAL_POLL;
use super::limits::MAX_FRAMES;
use super::limits::MAX_STITCHED_HEIGHT;
use super::limits::SETTLE_DELAY;
use super::limits::STILL_LIMIT;
use super::stitching::Step;
use super::stitching::Stitched;
use super::stitching::Stitcher;
use image::RgbaImage;
use std::sync::atomic::Ordering;
use std::time::Duration;

/// The capture policy is independent of OS input and frame acquisition so
/// delayed scrolling, manual pauses and overlap recovery can be tested.
pub(super) fn capture_frames(
    grab: &mut impl FnMut() -> anyhow::Result<Option<RgbaImage>>,
    scroll: &mut impl FnMut(i32) -> anyhow::Result<()>,
    wait: &mut impl FnMut(Duration),
    progress: &mut impl FnMut(u32),
    max_frames: u32,
    control: &ScrollControl,
) -> anyhow::Result<Stitched> {
    let first = loop {
        if control.stop.load(Ordering::SeqCst) {
            anyhow::bail!("scroll capture cancelled");
        }
        if let Some(frame) = grab()? {
            break frame;
        }
    };
    let mut stitcher = Stitcher::new(first);
    progress(stitcher.frames);
    // Keep one-notch steps so small viewports retain enough overlap.
    let mut notches: i32 = 1;
    let mut still = 0u32;
    let mut lost = 0u32;
    let mut previous_mode = control.mode();

    while !control.stop.load(Ordering::SeqCst)
        && stitcher.frames < max_frames.min(MAX_FRAMES)
        && stitcher.height() < MAX_STITCHED_HEIGHT
    {
        let mode = control.mode();
        if mode != previous_mode {
            still = 0;
            previous_mode = mode;
        }
        if mode == ScrollMode::Auto {
            if let Err(error) = scroll(notches) {
                control.set_input_error(format!("{error:#}"));
                control.set_mode(ScrollMode::Manual);
                progress(stitcher.frames);
                continue;
            }
        }
        wait(if mode == ScrollMode::Auto {
            SETTLE_DELAY
        } else {
            MANUAL_POLL
        });
        if control.stop.load(Ordering::SeqCst) {
            break;
        }
        let frame = loop {
            if control.stop.load(Ordering::SeqCst) {
                break None;
            }
            if let Some(frame) = grab()? {
                break Some(frame);
            }
            // Motion is still settling: do not inject another scroll step.
            wait(MANUAL_POLL);
        };
        let Some(frame) = frame else {
            break;
        };
        let mut step = stitcher.push(frame);
        // Animations/lazy rendering can momentarily destroy the overlap.
        // Re-read without injecting another scroll before trying recovery.
        if mode == ScrollMode::Auto {
            for _ in 0..3 {
                if !matches!(step, Step::Lost) || control.stop.load(Ordering::SeqCst) {
                    break;
                }
                wait(SETTLE_DELAY);
                if control.stop.load(Ordering::SeqCst) {
                    break;
                }
                if let Some(frame) = grab()? {
                    step = stitcher.push(frame);
                }
            }
        }
        match step {
            Step::Appended => {
                still = 0;
                lost = 0;
                control.needs_overlap.store(false, Ordering::SeqCst);
                progress(stitcher.frames);
            }
            Step::Unchanged => {
                // A pause is normal in manual mode, including at page end.
                // Keep the session alive until Finish or Cancel is requested.
                if mode == ScrollMode::Auto && control.mode() == ScrollMode::Auto {
                    still += 1;
                    if still >= STILL_LIMIT {
                        if stitcher.frames > 1 {
                            // Infinite lists can remain still while fetching
                            // the next batch. Confirm after a quiet interval,
                            // then retry input: newly loaded items may be
                            // below the unchanged viewport.
                            wait(Duration::from_secs(2));
                            if control.mode() != ScrollMode::Auto
                                || control.stop.load(Ordering::SeqCst)
                            {
                                continue;
                            }
                            if let Err(error) = scroll(notches) {
                                control.set_input_error(format!("{error:#}"));
                                control.set_mode(ScrollMode::Manual);
                                progress(stitcher.frames);
                                continue;
                            }
                            wait(SETTLE_DELAY);
                            let mut probe = None;
                            while probe.is_none() && !control.stop.load(Ordering::SeqCst) {
                                probe = grab()?;
                                if probe.is_none() {
                                    wait(MANUAL_POLL);
                                }
                            }
                            if let Some(frame) = probe {
                                match stitcher.push(frame) {
                                    Step::Appended => {
                                        still = 0;
                                        lost = 0;
                                        progress(stitcher.frames);
                                        continue;
                                    }
                                    Step::Lost => {
                                        control.needs_overlap.store(true, Ordering::SeqCst);
                                        control.set_mode(ScrollMode::Manual);
                                        progress(stitcher.frames);
                                        continue;
                                    }
                                    Step::Unchanged => {}
                                }
                            }
                            break;
                        }
                        // No movement may mean input was not accepted rather
                        // than page end. Let the user take over instead of
                        // returning a one-screen "long" screenshot.
                        control.set_mode(ScrollMode::Manual);
                        progress(stitcher.frames);
                    }
                }
            }
            Step::Lost => {
                still = 0;
                control.needs_overlap.store(true, Ordering::SeqCst);
                if mode == ScrollMode::Auto && control.mode() == ScrollMode::Auto {
                    if let Err(error) = scroll(-notches) {
                        control.set_input_error(format!("{error:#}"));
                        control.set_mode(ScrollMode::Manual);
                        progress(stitcher.frames);
                        continue;
                    }
                    wait(SETTLE_DELAY);
                    if control.stop.load(Ordering::SeqCst) {
                        break;
                    }
                    // Never rebase on an unverified frame: that would silently
                    // skip content or duplicate rows in the accumulated image.
                    let back = grab()?
                        .map(|frame| stitcher.push(frame))
                        .unwrap_or(Step::Lost);
                    if matches!(back, Step::Lost) {
                        control.set_mode(ScrollMode::Manual);
                    } else if notches > 1 {
                        notches = 1;
                        control.needs_overlap.store(false, Ordering::SeqCst);
                    } else {
                        // Already at one notch: lazy loading or late layout
                        // can break a single step. Retry a few times before
                        // asking the user to take over.
                        lost += 1;
                        if lost >= LOST_LIMIT {
                            control.set_mode(ScrollMode::Manual);
                        } else {
                            control.needs_overlap.store(false, Ordering::SeqCst);
                        }
                    }
                }
                progress(stitcher.frames);
            }
        }
    }

    if control.cancel.load(Ordering::SeqCst) {
        anyhow::bail!("scroll capture cancelled");
    }

    Ok(stitcher.finish())
}
