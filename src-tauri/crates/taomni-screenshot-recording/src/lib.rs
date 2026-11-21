//! Encode already captured frames at their original timestamps.

mod encoding;
mod gif;
mod inspection;
mod model;
mod mp4;

pub use encoding::{encode_file, encode_loop};
pub use inspection::{ClipInfo, inspect_clip, inspect_clip_frames};
pub use model::{ClipMetadata, RecordFormat, RecordingInfo};
pub use mp4::annex_b_nals;

pub struct TimedFrame {
    pub image: image::RgbaImage,
    /// Milliseconds since recording start.
    pub at_ms: u64,
}
