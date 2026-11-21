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

mod frames;

mod capture;

mod module_encoder;

#[cfg(test)]
mod tests;

pub use lifetime::{
    RECORDING_ENDED_EVENT, cancel_all, cancel_recording, recording_status, request_stop,
    start_recording, stop_recording,
};

pub(crate) use lifetime::output_path;

pub(super) use lifetime::{Recording, take_for_recovery};
pub(super) use module_encoder::available as module_recording_available;

pub use taomni_screenshot_recording::{ClipInfo, RecordFormat, RecordingInfo, inspect_clip};

pub(crate) use taomni_screenshot_recording::inspect_clip_frames;
