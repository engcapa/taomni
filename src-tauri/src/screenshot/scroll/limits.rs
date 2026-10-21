use std::time::Duration;

/// Upper bound for one stitched image (pixels); caps memory at ~4*w*h bytes.
pub(super) const MAX_STITCHED_HEIGHT: u32 = 20_000;
pub(super) const MAX_FRAMES: u32 = 400;
/// Let the hidden overlay leave the screen before the first frame.
pub(super) const INITIAL_SETTLE: Duration = Duration::from_millis(350);
/// Smooth-scroll animations in WebView2/WebKit finish well within this.
pub(super) const SETTLE_DELAY: Duration = Duration::from_millis(450);
/// Consecutive unchanged frames that end the capture (page bottom).
pub(super) const STILL_LIMIT: u32 = 6;
/// Consecutive one-notch steps without overlap before manual takeover.
pub(super) const LOST_LIMIT: u32 = 3;
pub(super) const MANUAL_POLL: Duration = Duration::from_millis(40);
pub(super) const FRAME_CONFIRM: Duration = Duration::from_millis(50);
/// Columns sampled per row for matching (frames are column-averaged to this).
pub(super) const MATCH_COLUMNS: usize = 128;
/// Mean absolute luma difference accepted as "same content".
pub(super) const MATCH_THRESHOLD: f64 = 6.0;
/// Rows whose difference stays below this are static between frames.
pub(super) const STATIC_THRESHOLD: f64 = 1.5;
/// Minimum overlap (rows) for a match to be trusted.
pub(super) const MIN_OVERLAP: usize = 16;
/// Shortest region a scroll capture accepts (three overlap bands).
pub const MIN_REGION_HEIGHT: u32 = (MIN_OVERLAP as u32) * 3;
