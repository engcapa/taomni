use super::frames::FrameQueue;
use super::frames::TimedFrame;
use super::model::RecordFormat;
use crate::screenshot::capture::DisplayInfo;
use crate::screenshot::capture::FrameSource;
use anyhow::Context;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::sync::mpsc::SyncSender;
use std::thread;
use std::time::Duration;
use std::time::Instant;
use tauri::AppHandle;

/// Output size for a region: even (H.264 4:2:0) and width-capped.
pub(super) fn output_dims(w: u32, h: u32, max_w: u32) -> (u32, u32) {
    let (w, h) = if w > max_w {
        (
            max_w,
            ((h as f64 * max_w as f64 / w as f64).round() as u32).max(2),
        )
    } else {
        (w, h)
    };
    ((w & !1).max(2), (h & !1).max(2))
}

#[allow(clippy::too_many_arguments)]
pub(super) fn capture_loop(
    app: &AppHandle,
    display: DisplayInfo,
    region: (u32, u32, u32, u32),
    format: RecordFormat,
    fps: u32,
    stop: &AtomicBool,
    tx: SyncSender<TimedFrame>,
    ready: std::sync::mpsc::Sender<anyhow::Result<()>>,
) -> anyhow::Result<()> {
    let mut source = FrameSource::for_region(app, display, region);
    // Reuse the readiness frame; a second read can block on a static screen.
    let mut initial = match source.grab() {
        Ok(image) => Some(image),
        Err(e) => {
            let _ = ready.send(Err(e.context("start screen capture")));
            return Ok(());
        }
    };
    let _ = ready.send(Ok(()));

    let interval = Duration::from_secs_f64(1.0 / fps as f64);
    let start = source.captured_at().unwrap_or_else(Instant::now);
    let deadline = start + format.max_duration();
    let (out_w, out_h) = output_dims(region.2, region.3, format.max_width());
    let mut queue = FrameQueue::default();
    let mut failures = 0u32;

    while !stop.load(Ordering::SeqCst) && Instant::now() < deadline {
        let tick = Instant::now();
        let polled = if let Some(image) = initial.take() {
            Ok(Some(image))
        } else {
            source.poll().map(|f| f.cloned())
        };
        match polled {
            Ok(Some(mut image)) => {
                failures = 0;
                if image.dimensions() != (out_w, out_h) {
                    image = image::imageops::resize(
                        &image,
                        out_w,
                        out_h,
                        image::imageops::FilterType::Triangle,
                    );
                }
                let at_ms = if queue.previous.is_none() {
                    0
                } else {
                    source
                        .captured_at()
                        .unwrap_or_else(Instant::now)
                        .saturating_duration_since(start)
                        .as_millis() as u64
                };
                queue.update(image, at_ms);
            }
            Ok(None) => {}
            Err(e) => {
                failures += 1;
                log::warn!("screenshot recording: frame capture failed: {e:#}");
                if failures >= 20 {
                    return Err(e.context("screen capture keeps failing"));
                }
            }
        }
        queue.try_flush(&tx)?;
        let elapsed = tick.elapsed();
        if elapsed < interval {
            thread::sleep(interval - elapsed);
        }
    }
    // The end timestamp closes the last frame's duration.
    let end_ms = start.elapsed().as_millis() as u64;
    queue.finish(&tx, end_ms)
}
