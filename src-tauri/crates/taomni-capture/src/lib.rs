//! Shared native screen capture. It has no dependency on Taomni or Tauri.

pub mod engine;
mod logging;
pub mod permissions;
pub mod pixels;
pub mod still;
pub use logging::{CaptureLog, CaptureLogger};
