//! Scrolling ("long") screenshot: capture a region, synthesize wheel scrolls
//! over its scrollable content, capture again, and stitch by vertical overlap.
//!
//! Stitching model. Each frame of the region is split into a static header
//! (rows identical across frames, e.g. a sticky toolbar), a scrolling body
//! and a static footer. Consecutive bodies join within their shared overlap;
//! the header/footer and supported fixed side chrome occur only once.
//! Overlap between consecutive bodies is the largest shift-consistent match
//! (mean absolute luma difference below a threshold); ties resolve to the
//! largest overlap so flat content is never duplicated.
//!
//! The overlay window hides itself before this runs (it would otherwise be
//! captured and swallow the wheel events), then reopens on the result.

mod limits;

mod control;

mod capture;

mod sampling;

mod input;

mod frames;

mod matching;

mod stitching;

mod chrome;

#[cfg(test)]
mod tests;

pub use limits::MIN_REGION_HEIGHT;

pub use control::{ScrollCaptureResult, ScrollControl, ScrollMode};

pub use capture::{scroll_capture, scroll_capture_controlled, scroll_capture_with};

pub(super) use input::ensure_control_permission;

#[cfg(all(debug_assertions, target_os = "macos"))]
pub(super) use input::QaPermissionDenial;
