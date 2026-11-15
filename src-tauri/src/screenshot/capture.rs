//! Screenshot artifacts and UI-specific capture orchestration.
//! Display and native capture ownership belong to the shared core capture module.

mod artifacts;
mod displays;
#[cfg(target_os = "linux")]
mod overlap;
mod scroll_source;
#[cfg(test)]
mod tests;

pub use crate::capture::displays::DisplayInfo;
#[cfg(all(debug_assertions, target_os = "macos"))]
pub(super) use crate::capture::permissions::QaPermissionDenial;
#[cfg(target_os = "macos")]
pub(super) use crate::capture::permissions::capture_permission_granted;
pub(super) use crate::capture::permissions::{
    ensure_capture_permission, request_capture_permission,
};
pub(crate) use crate::capture::pixels::frame_to_rgba;
pub use crate::capture::pixels::{clamp_region, crop, map_region};
#[cfg(all(debug_assertions, target_os = "macos"))]
pub(super) use crate::capture::source::qa_source_counts;
pub use crate::capture::{FrameSource, capture_display, list_displays, resolve_display};
pub(super) use artifacts::untrack_artifact;
pub use artifacts::{
    ScreenshotFile, artifact_dir, ensure_artifact_path, purge_stale_artifacts, purge_tracked,
    save_png, temp_artifact_path, untracked_artifact_path,
};
pub use displays::display_at_cursor;
#[cfg(target_os = "linux")]
pub(super) use displays::display_for_window;
#[cfg(target_os = "linux")]
pub(super) use overlap::capture_after_hidden;
