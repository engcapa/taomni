//! FlowEngine and egress connectors (Phase 2).
//!
//! Design plan §4.1 / §4.3 / §13 Phase 2:
//! - EgressConnector boundary: connect(target, context) → byte stream
//! - Direct / SOCKS5 / HTTP CONNECT reuse `terminal::network::establish_transport`
//! - SSH Jump opens one `direct-tcpip` channel per flow through a shared pool
//! - Hard-bypass set prevents capture loops on loopback / upstream endpoints
//! - Connect deadlines/cancellation and privacy-bounded stats are protocol-neutral

pub mod attribution;
pub mod bypass;
pub mod connectors;
pub mod engine;
pub mod stats;
