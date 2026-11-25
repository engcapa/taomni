//! Offline speech recognition with caller-owned model storage and audio capture.

mod manager;
mod segments;
mod sensevoice;
mod zipformer;

pub use manager::AsrManager;
pub use segments::run_segments;
pub use zipformer::{LocalTranscript, run_zipformer};
