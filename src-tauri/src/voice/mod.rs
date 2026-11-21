//! Local dictation: explicit recording, reviewed text, no command execution.
#[cfg(feature = "voice-capture")]
pub mod capture;
pub mod commands;
pub(crate) mod local_host;
pub mod streaming;

pub mod cleanup;
pub mod vocabulary;
