//! Encode already captured frames at their original timestamps.

mod encoding;
mod gif;
mod inspection;
mod mp4;

pub use encoding::{encode_file, encode_loop};
pub use inspection::{inspect_clip, inspect_clip_frames};
pub use mp4::annex_b_nals;
