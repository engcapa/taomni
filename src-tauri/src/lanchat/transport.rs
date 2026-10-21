//! TCP control channel (phase 4).
//!
//! Length-prefixed JSON frames (`[u32 BE length][UTF-8 JSON]`) via
//! `tokio-util` `LengthDelimitedCodec` + `serde_json`, carrying
//! `protocol::Envelope`. Owns the listener, on-demand dialing with
//! single-connection-per-peer dedup, the `hello`/`hello-ack` handshake, and
//! `ping`/`pong` keepalive with disconnect cleanup.
//!
//! Inbound application frames (text-msg, file-*, signal-*, wb-*) are routed to
//! `dispatch_inbound`, extended by later phases; phase 4 handles the
//! handshake + keepalive set and logs the rest.

mod limits;

mod framing;

mod outgoing;

mod connection;

mod handshake;

mod peer_exchange;

mod inbound;

#[cfg(test)]
mod tests;

pub use outgoing::{ConnHandle, send_data, send_media, send_to_peer, try_send};

pub use connection::{ensure_connection, run_listener};
