//! Wire-level RDP PDUs.
//!
//! Implemented and unit-tested:
//!
//! - [`tpkt`] — RFC 1006 TPKT framing (4-byte header).
//! - [`x224`] — X.224 Class 0 connection PDUs and data PDU header.
//! - [`nego`] — MS-RDPBCGR §2.2.1.1 RDP Negotiation Request / Response /
//!   Failure embedded in X.224 Connection Request / Confirm.
//!
//! These are the layers every RDP connection — direct TCP, HTTP/SOCKS5
//! proxy, or RD Gateway — passes through before the TLS upgrade. Higher-
//! level MCS / Channel-Join / Capability Exchange PDUs land in
//! [`crate::rdp::session`] once the IronRDP integration is wired.

pub mod mcs;
pub mod nego;
pub mod tpkt;
pub mod x224;
