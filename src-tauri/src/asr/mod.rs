//! Local speech recognition. This module never calls an LLM or uploads audio.
pub mod catalog;
pub mod manager;
pub mod models;

#[cfg(all(test, feature = "asr-whisper"))]
mod benchmark;
