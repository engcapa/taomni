//! Connection sequence and active-stage pump shared by every probe scenario.
//!
//! Mirrors the Taomni client's proven order (`src/rdp/session.rs`
//! `drive_ironrdp_connection`): X.224 negotiation → TLS → CredSSP/NLA →
//! capability exchange → active stage. Unlike the product client, the probe
//! accepts any server certificate (it targets disposable local servers) but
//! records the SHA-256 fingerprint so a report can still identify the server.

mod model;

mod configuration;

mod tls;

mod startup;

mod framebuffer;

mod pump;

mod input;

#[cfg(test)]
mod tests;

pub(crate) use model::{
    ChannelPlan, ConnectOptions, ProbeSession, PumpEvent, Stream, SvcMessagesOf,
};
