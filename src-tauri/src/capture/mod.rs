//! Shared core display, still capture and frame-source services.
//! Native backends live in taomni-capture; UI lifecycle stays with its caller.

pub(crate) mod displays;
mod frames;
pub(crate) mod log;
pub(crate) mod permissions;
pub(crate) mod plugin_service;
pub(crate) mod service;
pub(crate) mod snapshot;
pub(crate) mod source;
pub use displays::{DisplayInfo, list_displays, resolve_display};
pub use snapshot::capture_display;
pub use source::FrameSource;
pub(crate) use taomni_capture::pixels;
