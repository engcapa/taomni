//! Core capture diagnostics never impersonate an RDP server.
use taomni_capture::CaptureLogger;

pub(crate) fn capture_log() -> CaptureLogger {
    CaptureLogger::new(|message| log::info!(target: "taomni::capture", "{message}"))
}
