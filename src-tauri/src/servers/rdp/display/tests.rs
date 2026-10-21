use super::capture_loop::capture_loop_polling;
#[cfg(target_os = "macos")]
use super::display::CaptureResizeRequest;
use super::mailbox::LatestFrameMailbox;
use super::mailbox::PendingFrames;
use super::mailbox::PublishResult;
use super::updates::DisplayUpdatesImpl;
use crate::servers::rdp::capture::Capturer;
use crate::servers::rdp::capture::Frame;
use crate::servers::rdp::metrics::RdpMetrics;
use ironrdp::server::DesktopSize;
use ironrdp::server::DisplayUpdate;
use ironrdp::server::RdpServerDisplayUpdates;
use std::sync::Arc;
use std::sync::Mutex;
#[cfg(target_os = "macos")]
use tokio::sync::oneshot;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

fn frame(value: u8) -> Frame {
    Frame::bgra(vec![value, 0, 0, 0], 0, 0, 1, 1, 4)
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn resize_precedes_the_first_frame_at_the_new_geometry() {
    let mailbox = Arc::new(LatestFrameMailbox::new());
    let metrics = RdpMetrics::silent();
    let mut updates = DisplayUpdatesImpl::from_warmed_linux_capture(
        mailbox.clone(),
        DesktopSize {
            width: 1,
            height: 1,
        },
        metrics,
    );
    mailbox.publish_full(Frame::bgra(vec![0; 2 * 2 * 4], 0, 0, 2, 2, 8));

    assert!(matches!(
        updates.next_update().await.unwrap(),
        Some(DisplayUpdate::Resize(DesktopSize {
            width: 2,
            height: 2
        }))
    ));
    assert!(matches!(
        updates.next_update().await.unwrap(),
        Some(DisplayUpdate::Bitmap(bitmap)) if bitmap.width.get() == 2 && bitmap.height.get() == 2
    ));
}

/// Capturer that reports idle ticks, mimicking ScreenCaptureKit on a static
/// desktop, and produces one real frame every `frame_every` polls.
///
/// `disconnect_at` closes the mailbox from inside the poll so the test does
/// not depend on thread scheduling: the real backends block for their idle
/// budget on each poll, while this stub returns instantly.
struct IdleCapturer {
    polls: Arc<AtomicUsize>,
    frame_every: usize,
    stop_after: usize,
    disconnect_at: Option<(usize, Arc<LatestFrameMailbox>)>,
    /// Reported through [`Capturer::is_self_paced`].
    self_paced: bool,
    /// Reported through [`Capturer::needs_frame_deduplication`].
    needs_deduplication: bool,
    /// Time spent inside one producing poll before the pixels exist, standing
    /// in for a backend that blocks until the next frame is available.
    wait: Duration,
}

impl IdleCapturer {
    fn new(polls: Arc<AtomicUsize>, frame_every: usize, stop_after: usize) -> Self {
        Self {
            polls,
            frame_every,
            stop_after,
            disconnect_at: None,
            self_paced: false,
            needs_deduplication: true,
            wait: Duration::ZERO,
        }
    }
}

impl Capturer for IdleCapturer {
    fn desktop_size(&self) -> (u16, u16) {
        (1, 1)
    }

    fn is_self_paced(&self) -> bool {
        self.self_paced
    }

    fn needs_frame_deduplication(&self) -> bool {
        self.needs_deduplication
    }

    fn capture(&mut self) -> anyhow::Result<Frame> {
        anyhow::bail!("polling loop must use poll_frame")
    }

    fn poll_frame(&mut self) -> anyhow::Result<Option<Frame>> {
        let poll = self.polls.fetch_add(1, Ordering::Relaxed) + 1;
        if poll > self.stop_after {
            anyhow::bail!("capture source failed");
        }
        if let Some((at, mailbox)) = &self.disconnect_at
            && poll == *at
        {
            mailbox.close();
        }
        if self.frame_every > 0 && poll.is_multiple_of(self.frame_every) {
            // Wait first, then build the frame: both regimes hand back
            // pixels that are fresh when the call returns, whatever the
            // call itself spent getting there.
            std::thread::sleep(self.wait);
            #[expect(clippy::cast_possible_truncation, reason = "test frame payload")]
            return Ok(Some(frame(poll as u8)));
        }
        Ok(None)
    }
}

#[cfg(target_os = "macos")]
struct ResizeCapturer {
    requested: Arc<std::sync::Mutex<Option<(u16, u16)>>>,
}

#[cfg(target_os = "macos")]
impl Capturer for ResizeCapturer {
    fn desktop_size(&self) -> (u16, u16) {
        (4, 4)
    }

    fn capture(&mut self) -> anyhow::Result<Frame> {
        anyhow::bail!("polling loop must use poll_frame")
    }

    fn supports_output_resize(&self) -> bool {
        true
    }

    fn resize_output(&mut self, width: u16, height: u16) -> anyhow::Result<Frame> {
        *self.requested.lock().unwrap() = Some((width, height));
        Ok(Frame::bgra(
            vec![0; usize::from(width) * usize::from(height) * 4],
            0,
            0,
            width,
            height,
            usize::from(width) * 4,
        ))
    }

    fn poll_frame(&mut self) -> anyhow::Result<Option<Frame>> {
        anyhow::bail!("capture source stopped after resize")
    }
}

#[tokio::test]
async fn newest_full_frame_replaces_an_unconsumed_frame() {
    let mailbox = LatestFrameMailbox::new();
    assert!(matches!(
        mailbox.publish_full(frame(1)),
        PublishResult::Published { replaced: false }
    ));
    assert!(matches!(
        mailbox.publish_full(frame(2)),
        PublishResult::Published { replaced: true }
    ));

    let PendingFrames::Full(frame) = mailbox.take().await.unwrap() else {
        panic!("expected a full frame");
    };
    assert_eq!(frame.data[0], 2);
}

#[tokio::test]
async fn retained_full_frame_replays_immediately_without_copying_pixels() {
    // ScreenCaptureKit emits idle markers while the desktop is static. A
    // newly authenticated client must still receive the last complete
    // desktop immediately, without waiting for a future screen change.
    let mailbox = LatestFrameMailbox::new();
    let original = frame(7);
    let pixels = original.data.as_ptr();
    assert!(matches!(
        mailbox.publish_full(original),
        PublishResult::Published { replaced: false }
    ));

    let PendingFrames::Full(first) = mailbox.take().await.unwrap() else {
        panic!("expected the first full frame");
    };
    assert_eq!(first.data.as_ptr(), pixels);

    mailbox.replay_latest_full();
    let replay = tokio::time::timeout(Duration::from_millis(50), mailbox.take())
        .await
        .expect("retained frame must not wait for a new capture")
        .expect("mailbox must stay open across client subscriptions");
    let PendingFrames::Full(replay) = replay else {
        panic!("expected the retained full frame");
    };
    assert_eq!(replay.data[0], 7);
    assert_eq!(
        replay.data.as_ptr(),
        pixels,
        "replay should only clone the Bytes handle, not the pixel buffer"
    );
}

#[tokio::test]
async fn damage_backlog_requests_a_safe_full_refresh() {
    let mailbox = LatestFrameMailbox::new();
    assert!(matches!(
        mailbox.publish_damage(vec![frame(1)]),
        PublishResult::Published { replaced: false }
    ));
    assert!(matches!(
        mailbox.take().await,
        Some(PendingFrames::Damage(_))
    ));

    assert!(matches!(
        mailbox.publish_damage(vec![frame(2)]),
        PublishResult::NeedsFullRefresh
    ));
    assert!(matches!(
        mailbox.publish_full(frame(3)),
        PublishResult::Published { replaced: true }
    ));
    assert!(mailbox.full_refresh_waiting());

    mailbox.finish_damage();
    let PendingFrames::Full(frame) = mailbox.take().await.unwrap() else {
        panic!("expected the full refresh");
    };
    assert_eq!(frame.data[0], 3);
}

#[cfg(target_os = "macos")]
#[test]
fn capture_resize_acknowledges_only_after_publishing_the_new_surface() {
    let mailbox = LatestFrameMailbox::new();
    let metrics = RdpMetrics::silent();
    let requested = Arc::new(std::sync::Mutex::new(None));
    let mut capturer = ResizeCapturer {
        requested: requested.clone(),
    };
    let (resize_tx, resize_rx) = std::sync::mpsc::channel();
    let (result_tx, result_rx) = tokio::sync::oneshot::channel();
    let requested_size = ironrdp::server::DesktopSize {
        width: 2,
        height: 3,
    };
    resize_tx
        .send(CaptureResizeRequest {
            size: requested_size,
            result: result_tx,
        })
        .unwrap();

    capture_loop_polling(
        &mut capturer,
        &mailbox,
        &metrics,
        Some(&resize_rx),
        #[cfg(target_os = "linux")]
        None,
    );

    assert_eq!(*requested.lock().unwrap(), Some((2, 3)));
    assert_eq!(result_rx.blocking_recv().unwrap().unwrap(), requested_size);
    let state = mailbox.state.lock().unwrap();
    let Some(PendingFrames::Full(frame)) = state.pending.as_ref() else {
        panic!("resize response must follow publication of a full frame");
    };
    assert_eq!((frame.width, frame.height), (2, 3));
    assert_eq!(frame.sequence, 1);
}

#[test]
fn idle_ticks_do_not_end_the_capture_thread() {
    // Regression: a static macOS desktop yields only idle ticks. Treating
    // one as fatal ended the capture thread, leaving `next_update` awaiting
    // a mailbox with no producer — the client froze on its last frame while
    // the connection stayed up.
    let mailbox = Arc::new(LatestFrameMailbox::new());
    let metrics = RdpMetrics::silent();
    let polls = Arc::new(AtomicUsize::new(0));
    let mut capturer = IdleCapturer {
        disconnect_at: Some((25, mailbox.clone())),
        ..IdleCapturer::new(polls.clone(), 0, 200)
    };

    capture_loop_polling(
        &mut capturer,
        &mailbox,
        &metrics,
        #[cfg(target_os = "macos")]
        None,
        #[cfg(target_os = "linux")]
        None,
    );

    // 24 idle ticks were survived; the loop ended only once the client left.
    assert_eq!(
        polls.load(Ordering::Relaxed),
        25,
        "loop must ride out idle ticks and stop exactly on disconnect"
    );
}

#[test]
fn capture_failure_still_ends_the_loop() {
    let mailbox = LatestFrameMailbox::new();
    let metrics = RdpMetrics::silent();
    let polls = Arc::new(AtomicUsize::new(0));
    let mut capturer = IdleCapturer {
        self_paced: true,
        ..IdleCapturer::new(polls.clone(), 2, 4)
    };

    capture_loop_polling(
        &mut capturer,
        &mailbox,
        &metrics,
        #[cfg(target_os = "macos")]
        None,
        #[cfg(target_os = "linux")]
        None,
    );

    assert_eq!(polls.load(Ordering::Relaxed), 5, "loop must stop on error");
}

/// Long enough to separate "waited for the next frame" from "produced the
/// pixels" in a wall-clock assertion, short enough to keep tests quick.
const WAIT: Duration = Duration::from_millis(40);

#[test]
fn a_self_paced_backend_is_not_paced_again() {
    // ScreenCaptureKit already caps itself at its configured frame rate.
    // Sleeping another frame interval per iteration served each frame one
    // interval after it was already sitting in the backend's mailbox.
    let mailbox = LatestFrameMailbox::new();
    let metrics = RdpMetrics::silent();
    let polls = Arc::new(AtomicUsize::new(0));
    let mut capturer = IdleCapturer {
        self_paced: true,
        ..IdleCapturer::new(polls.clone(), 1, 6)
    };

    let started = Instant::now();
    capture_loop_polling(
        &mut capturer,
        &mailbox,
        &metrics,
        #[cfg(target_os = "macos")]
        None,
        #[cfg(target_os = "linux")]
        None,
    );
    let elapsed = started.elapsed();

    assert_eq!(polls.load(Ordering::Relaxed), 7);
    // Six unpaced polls take microseconds; six paced ones take ~200ms.
    assert!(
        elapsed < Duration::from_millis(100),
        "self-paced backend was paced a second time: {elapsed:?}"
    );
}

#[test]
fn a_change_stream_does_not_hash_full_frames_again() {
    let mailbox = LatestFrameMailbox::new();
    let metrics = RdpMetrics::silent();
    let mut capturer = IdleCapturer {
        self_paced: true,
        needs_deduplication: false,
        ..IdleCapturer::new(Arc::new(AtomicUsize::new(0)), 1, 2)
    };

    capture_loop_polling(
        &mut capturer,
        &mailbox,
        &metrics,
        #[cfg(target_os = "macos")]
        None,
        #[cfg(target_os = "linux")]
        None,
    );

    assert_eq!(
        metrics.hash_sample_count(),
        0,
        "a native change stream must not pay for a second full-frame scan"
    );
}

#[test]
fn capture_metric_excludes_a_self_paced_backends_wait() {
    // `capture=` has to report what getting pixels costs us. Charging the
    // wait for the next frame to it just restates the frame interval, so a
    // genuinely slow capture becomes indistinguishable from an idle desktop.
    let mailbox = LatestFrameMailbox::new();
    let metrics = RdpMetrics::silent();
    let mut capturer = IdleCapturer {
        self_paced: true,
        wait: WAIT,
        ..IdleCapturer::new(Arc::new(AtomicUsize::new(0)), 1, 1)
    };

    capture_loop_polling(
        &mut capturer,
        &mailbox,
        &metrics,
        #[cfg(target_os = "macos")]
        None,
        #[cfg(target_os = "linux")]
        None,
    );

    let capture_us = metrics.capture_p50_us().expect("one frame was captured");
    assert!(
        capture_us < u64::try_from(WAIT.as_micros()).unwrap() / 2,
        "the self-paced wait was charged to capture: {capture_us}us"
    );
}

#[test]
fn capture_metric_covers_a_grab_on_demand_backends_work() {
    // The flip side: a backend that produces pixels inline must still have
    // that work measured, so the fix above cannot silently zero the metric
    // on X11-without-DAMAGE or the Wayland/xcap fallback.
    let mailbox = LatestFrameMailbox::new();
    let metrics = RdpMetrics::silent();
    let mut capturer = IdleCapturer {
        wait: WAIT,
        ..IdleCapturer::new(Arc::new(AtomicUsize::new(0)), 1, 1)
    };

    capture_loop_polling(
        &mut capturer,
        &mailbox,
        &metrics,
        #[cfg(target_os = "macos")]
        None,
        #[cfg(target_os = "linux")]
        None,
    );

    let capture_us = metrics.capture_p50_us().expect("one frame was captured");
    assert!(
        capture_us >= u64::try_from(WAIT.as_micros()).unwrap() / 2,
        "grab-on-demand capture work was not measured: {capture_us}us"
    );
}
