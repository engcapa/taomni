use std::time::Duration;

pub(super) const FRAME_WAIT: Duration = Duration::from_millis(100);
// The capture worker also drains portal input. Waiting a whole idle frame
// timeout delays the very input that would make the compositor produce a
// new frame. Bound that queue delay for interactive sessions only; this is
// a Condvar wait, and never fabricates or duplicates a frame.
pub(super) const INPUT_POLL_WAIT: Duration = Duration::from_millis(5);
pub(super) const INITIAL_FRAME_TIMEOUT: Duration = Duration::from_secs(10);
pub(super) const MAX_DIMENSION: u32 = 16_384;
