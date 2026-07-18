//! FlowEngine and egress connectors (Phase 2).
//!
//! Design plan §4.1 / §4.3 / §13 Phase 2:
//! - EgressConnector boundary: connect(target, context) → byte stream
//! - Direct / SOCKS5 / HTTP CONNECT reuse `terminal::network::establish_transport`
//! - SSH Jump uses SshChannelPool when credentials are available
//! - Hard-bypass set prevents capture loops on loopback / upstream endpoints

pub mod attribution;
pub mod bypass;
pub mod connectors;
pub mod engine;
pub mod runtime;

pub use attribution::*;
pub use bypass::*;
pub use connectors::*;
pub use engine::*;
pub use runtime::*;
