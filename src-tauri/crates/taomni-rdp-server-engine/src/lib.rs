//! RDP desktop server, with capture, authentication and local consent.

mod approval;
mod audio_input;
mod auth;
mod builder;
#[cfg(test)]
mod bulk_loopback_tests;
mod clipboard;
mod clipboard_formats;
mod diff;
mod display;
mod features;
#[cfg(target_os = "macos")]
mod gfx;
#[cfg(test)]
mod host_perf;
mod input;
mod lifetime;
#[cfg(test)]
mod loopback_tests;
mod metrics;
mod policy;
mod session;
mod sound;
mod tls;

pub use approval::{ApprovalBroker, EventSink};
pub use lifetime::start;

#[cfg(test)]
mod tests;
