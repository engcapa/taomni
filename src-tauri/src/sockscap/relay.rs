//! Local loopback relay: accept NAT'd connections from WinDivert helper,
//! attribute hostname (SNI / HTTP Host), apply policy, dial egress, bridge.

mod limits;

mod lifetime;

mod admission;

mod context;

mod flow;

mod sniffing;

mod bridge;

#[cfg(test)]
mod tests;

pub(crate) use limits::{
    ACCEPT_BACKOFF_INITIAL, ACCEPT_BACKOFF_MAX, MAX_ACTIVE_RELAY_FLOWS, RELAY_PERMIT_WAIT,
};

pub use lifetime::{RelayHandle, start_relay};

pub(crate) use lifetime::handle_captured_client;

pub(crate) use admission::{acquire_relay_flow_permit, new_relay_flow_limiter};

pub use context::{
    RelayContext, ResolvedUpstream, relay_loopback_ip, upstream_from_config,
    upstream_from_config_ref,
};

pub(crate) use context::CapturedFlow;

pub(crate) use flow::handle_captured_stream;
