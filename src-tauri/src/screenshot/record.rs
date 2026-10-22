//! Screen recording to GIF (`gif` crate) and MP4 (built-in OpenH264 encoder
//! + `mp4` muxer, no external tools).
//!
//! Threads: a capture thread owns the platform frame source (capture
//! backends are not `Send`) and timestamps frames; an encoder thread turns
//! them into the output file. Frames travel over a small bounded channel; a
//! frame that would block is dropped, which lengthens the previous frame's
//! display time instead of distorting the clip's duration. Unchanged frames
//! are never re-encoded: the previous frame simply lasts longer. Every frame
//! duration therefore comes from real capture timestamps, so playback speed
//! matches wall-clock time even when capture or encoding is slow.

mod lifetime;

mod model;

mod frames;

mod capture;

mod encoding;

mod gif;

mod mp4;

mod inspection;

#[cfg(test)]
mod tests;

pub use lifetime::{
    RECORDING_ENDED_EVENT, cancel_all, cancel_recording, recording_status, request_stop,
    start_recording, stop_recording,
};

pub(crate) use lifetime::output_path;

pub(super) use lifetime::{Recording, take_for_recovery};

pub use model::{RecordFormat, RecordingInfo};

pub(crate) use mp4::annex_b_nals;

pub use inspection::{ClipInfo, inspect_clip};

pub(crate) use inspection::inspect_clip_frames;
