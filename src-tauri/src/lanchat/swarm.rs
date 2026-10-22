//! Swarm file & folder transfer (v3).
//!
//! Replaces the old base64-over-JSON `file-*` engine. A file is described by a
//! content-addressed [`Manifest`] (per-piece SHA-256). The origin seeds; every
//! accepting peer leeches *and* re-seeds the pieces it already holds, so members
//! of a group trade pieces with each other and the origin's uplink is shared.
//!
//! Memory is bounded by design: leechers cap outstanding requests (a window),
//! seeders serve one piece per request via positioned reads, and piece bytes
//! ride a *bounded* binary data channel (see `transport`), so a fast disk can
//! never outrun the network into an unbounded queue. Each received piece is
//! verified against its manifest hash before it is written.

mod limits;

mod progress;

mod bitfield;

mod manifest;

mod lifetime;

mod file_io;

mod offers;

mod pieces;

mod scheduling;

mod control;

#[cfg(test)]
mod tests;

pub use progress::TransferProgress;

pub use bitfield::Bitfield;

pub use manifest::Manifest;

pub use lifetime::{OfferInfo, SwarmFile};

pub use offers::{accept_offer, handle_accept, handle_offer, handle_reject, reject_offer, send};

pub use pieces::{handle_bitfield, handle_have, handle_piece, handle_request};

pub use control::{control, handle_cancel, send_dir, send_to_group};
