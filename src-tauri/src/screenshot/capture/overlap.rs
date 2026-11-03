//! Open the Linux capturer while application windows hide. Only native frames
//! sampled after the acknowledged hide barrier may become the screenshot.
//! An idle pre-barrier stream is retired before a fresh serial source opens.

use super::displays::DisplayInfo;
use super::permissions::ensure_capture_permission;
use super::snapshot::ObservedSource;
use super::snapshot::capture_display;
use crate::screenshot::startup_timing;
use crate::servers::rdp::capture::stage_trace;
use image::RgbaImage;
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tokio_util::sync::CancellationToken;

const DRAIN: Duration = Duration::from_millis(250);
const POLL_STEP: Duration = Duration::from_millis(20);

/// `Some(barrier)` acknowledges hiding; `None`, disconnect or `cancel` cancels.
/// The caller retains the worker handle/lease until native cleanup completes.
pub fn capture_after_hidden(
    app: &AppHandle,
    display: &DisplayInfo,
    hidden: Receiver<Option<Instant>>,
    out: tokio::sync::oneshot::Sender<anyhow::Result<RgbaImage>>,
    cancel: CancellationToken,
) {
    stage_trace::observe_cancellable(startup_timing::mark, cancel, || {
        let result = capture_owned(app, display, &hidden);
        // Drop is deliberately complete before releasing worker ownership.
        let _ = out.send(result);
    });
}

fn capture_owned(
    app: &AppHandle,
    display: &DisplayInfo,
    hidden: &Receiver<Option<Instant>>,
) -> anyhow::Result<RgbaImage> {
    ensure_capture_permission()?;
    let mut source = ObservedSource::open(app, display)?;
    let barrier = wait_hidden(hidden)?;
    startup_timing::mark("capture_hidden_signal");
    let result = drain_latest(&mut source, barrier);
    startup_timing::mark("capture_drain_end");
    // Retiring the original session is a prerequisite for serial reopening.
    drop(source);
    stage_trace::check_cancelled()?;
    if let Some(image) = result? {
        return Ok(image);
    }
    startup_timing::note("captureSerialReopen", serde_json::Value::Bool(true));
    capture_display(app, display)
}

fn wait_hidden(hidden: &Receiver<Option<Instant>>) -> anyhow::Result<Instant> {
    loop {
        stage_trace::check_cancelled()?;
        match hidden.recv_timeout(POLL_STEP) {
            Ok(Some(barrier)) => return Ok(barrier),
            Err(RecvTimeoutError::Timeout) => continue,
            _ => anyhow::bail!("screenshot opening was cancelled"),
        }
    }
}

fn accept_frame<T>(latest: &mut Option<T>, frame: T, sampled: Option<Instant>, barrier: Instant) {
    // Missing timestamps are not evidence of post-hide isolation.
    if sampled.is_some_and(|at| at >= barrier) {
        *latest = Some(frame);
    }
}

fn drain_latest(
    source: &mut ObservedSource,
    barrier: Instant,
) -> anyhow::Result<Option<RgbaImage>> {
    let until = Instant::now() + DRAIN;
    let mut latest = None;
    let mut first = true;
    loop {
        stage_trace::check_cancelled()?;
        let native = source.source();
        if let Some(image) = native.poll()?.cloned() {
            if first {
                startup_timing::mark("capture_grab");
                first = false;
            }
            accept_frame(&mut latest, image, native.captured_at(), barrier);
        }
        if Instant::now() >= until {
            break;
        }
        std::thread::sleep(POLL_STEP);
    }
    startup_timing::note(
        "captureFrameAfterHidden",
        serde_json::Value::Bool(latest.is_some()),
    );
    Ok(latest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pre_hidden_or_untimestamped_frames_are_never_published() {
        let barrier = Instant::now();
        let mut latest = None;
        accept_frame(&mut latest, "app window", Some(barrier - DRAIN), barrier);
        accept_frame(&mut latest, "unknown age", None, barrier);
        assert_eq!(latest, None); // Caller must retire and reopen, not reuse these.
        accept_frame(&mut latest, "isolated", Some(barrier), barrier);
        accept_frame(
            &mut latest,
            "late delivery of stale pixels",
            Some(barrier - DRAIN),
            barrier,
        );
        assert_eq!(latest, Some("isolated"));
    }

    #[test]
    fn hidden_channel_preserves_the_acknowledged_instant_and_handles_cancellation() {
        let (tx, rx) = std::sync::mpsc::channel();
        let barrier = Instant::now() - DRAIN;
        tx.send(Some(barrier)).unwrap();
        assert_eq!(wait_hidden(&rx).unwrap(), barrier);
        tx.send(None).unwrap();
        assert!(wait_hidden(&rx).is_err());
        drop(tx);
        assert!(wait_hidden(&rx).is_err());
    }

    #[test]
    fn token_cancels_hidden_wait_even_if_sender_remains_alive() {
        let (_tx, rx) = std::sync::mpsc::channel();
        let cancel = CancellationToken::new();
        cancel.cancel();
        stage_trace::observe_cancellable(
            |_| {},
            cancel,
            || {
                assert!(wait_hidden(&rx).is_err());
            },
        );
    }
}
