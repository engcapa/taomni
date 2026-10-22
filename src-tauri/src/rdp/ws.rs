//! RDP ↔ WebSocket relay.
//!
//! Mirror of `crate::vnc::ws`: bind a loopback listener on a dynamic port,
//! accept one WebSocket from the React canvas, then drive an RDP session in
//! the background. Bytes flow over a binary WS protocol with a one-byte
//! channel tag in front of every frame so display, audio, cursor,
//! clipboard, and drive-redirect events share the same socket.
//!
//! ```text
//! 0           1                                              N
//! +-----------+----------------------------------------------+
//! | tag (u8)  | payload (channel-specific)                   |
//! +-----------+----------------------------------------------+
//! ```
//!
//! See [`channel`] constants for the tag values.
//!
//! The connection itself is a three-step state machine:
//!
//! 1. Open a direct TCP, HTTP/SOCKS5 proxy, or RD Gateway tunnel via
//!    [`crate::rdp::transport::open_transport`].
//! 2. Bind the loopback WebSocket listener so the frontend can receive
//!    status updates while RDP authentication continues.
//! 3. Hand the TCP stream to [`crate::rdp::session::start_ironrdp_session`],
//!    which owns X.224 negotiation, TLS, CredSSP/NLA, active-stage display
//!    decoding, and input encoding.

mod relay;

mod wire;

mod model;

mod outgoing;

mod authorization;

#[cfg(test)]
mod tests;

pub use relay::spawn_rdp_relay;

pub use wire::{frame_payload_with_header, parse_binary_control};

pub use model::{RdpControl, RdpSession, RdpSpawnConfig};

pub use outgoing::WsOutgoing;

pub use wire::{channel, cursor};
