use std::time::Duration;

/// ScreenCaptureKit's native queue must remain shallow: values above this add
/// whole display frames of latency before the delegate is even called.
pub(super) const NATIVE_QUEUE_DEPTH: isize = 3;
/// GUI sources may themselves draw at ~30 Hz. Sampling at the same rate with
/// an independent phase loses changes; a 60 Hz capture budget also reduces
/// the input-to-frame wait. The shallow slot still coalesces work.
pub(super) const FRAME_RATE: i32 = 60;
pub(super) const CONTENT_TIMEOUT: Duration = Duration::from_secs(5);
pub(super) const STOP_TIMEOUT: Duration = Duration::from_millis(750);
/// How long one poll waits for new desktop content before reporting an idle
/// tick. ScreenCaptureKit delivers no usable frame at all while the desktop is
/// static, so this is the interval at which the capture loop gets a chance to
/// notice a disconnected client. It is deliberately far below
/// [`FRAME_TIMEOUT`], which stays reserved for the initial frame.
pub(super) const IDLE_POLL: Duration = Duration::from_millis(250);
/// A mode switch can produce a few malformed samples while CoreVideo rebuilds
/// its IOSurface. Persistent corruption must wake the consumer instead of
/// leaving it waiting on a healthy-looking mailbox.
pub(super) const MALFORMED_SAMPLE_LIMIT: usize = 8;
