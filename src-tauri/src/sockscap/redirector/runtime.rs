//! Runtime bridge for the signed Mitmproxy Redirector app (macOS only).

mod limits;

mod bridge;

mod lifetime;

mod telemetry;

mod recovery;

mod capture_loop;

mod flow;

mod udp;

#[cfg(test)]
mod tests;

pub use lifetime::{RedirectorCaptureHandle, RedirectorStartError, preflight, start};

pub use telemetry::RedirectorTelemetrySnapshot;

pub use recovery::recover;
