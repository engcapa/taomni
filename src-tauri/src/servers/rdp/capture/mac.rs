//! macOS screen capture for the RDP server via `xcap` (CGDisplay / ScreenCaptureKit).
//!
//! Requires **Screen Recording** permission (System Settings → Privacy & Security).
//! Without it, `xcap` fails at capture time with a clear error we surface to logs.

use super::Capturer;
use super::xcap_backend::XcapCapturer;
use crate::servers::engine::LogEmitter;

pub(crate) fn try_new(log: &LogEmitter) -> anyhow::Result<Box<dyn Capturer>> {
    log.line("macOS RDP capture: initializing xcap backend (requires Screen Recording permission)");
    Ok(Box::new(XcapCapturer::new(log)?))
}
