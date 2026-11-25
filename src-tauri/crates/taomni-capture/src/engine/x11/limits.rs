use std::time::Duration;

/// Upper bound on capture rate under continuous damage (e.g. dragging a window
/// or video playback). 16 ms ≈ 60 fps: responsive without spending the CPU to
/// encode faster than a client can usefully display.
pub(super) const MIN_FRAME_INTERVAL: Duration = Duration::from_millis(16);

/// How long a single `next_updates` call waits for damage before returning an
/// idle tick. Bounds shutdown latency (the capture thread notices a dropped
/// client within this window) while keeping idle wakeups rare.
pub(super) const DAMAGE_WAIT_BUDGET: Duration = Duration::from_millis(100);

/// Poll granularity while waiting for damage events. Small enough to feel
/// instant on the first change, large enough that idle polling of the socket is
/// negligible (no pixel readback happens here — just a check of the X socket).
pub(super) const DAMAGE_POLL_STEP: Duration = Duration::from_millis(2);
