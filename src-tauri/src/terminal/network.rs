//! Per-session network settings: proxy chain, keep-alive, TCP_NODELAY,
//! IP-version preference, and local port forwarding rows.
//!
//! Frontend marshals these as `networkSettings` on the IPC payload; we
//! deserialize once per connect and apply them when establishing the
//! TCP socket and when configuring the russh client.

mod model;
pub(crate) mod proxy_selection;

mod transport;

mod http;

mod socks;

mod endpoint;

#[cfg(test)]
mod tests;

pub use model::{NetworkForward, NetworkSettings};

pub use transport::establish_transport;

pub use endpoint::parse_endpoint;
