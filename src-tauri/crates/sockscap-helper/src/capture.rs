//! FLOW (PID map) + NETWORK capture engine.
//!
//! TCP redirect uses the official WinDivert **streamdump reflection** pattern
//! (not NAT-to-127.0.0.1, which fails to deliver to loopback-only listeners):
//!
//! - Client C:sp → Remote R:dp  becomes  R:sp → C:relay  (inbound)
//! - Proxy reply C:relay → R:sp becomes  R:dp → C:sp     (inbound)
//!
//! Relay must listen on 0.0.0.0 (all interfaces), not only 127.0.0.1.

mod address;
mod classification;
mod engine;
mod filter;
mod flow_table;
mod maintenance;
mod packet;
mod packet_loop;
mod pid_map;
mod plan;
mod process_scope;
#[cfg(test)]
mod process_tests;
#[cfg(test)]
mod tests;

pub use engine::CaptureEngine;
pub use plan::{CapturePlan, Endpoint};
