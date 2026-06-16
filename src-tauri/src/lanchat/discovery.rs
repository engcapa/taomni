//! mDNS / DNS-SD discovery (phase 3).
//!
//! Registers this node's `_taomni-lan._tcp.local.` service (TXT per
//! `protocol`), browses for peers, resolves the local broadcast/bind address
//! via `if-addrs` for multi-NIC hosts, and derives presence from announce +
//! heartbeat freshness. Roster changes are debounced and pushed to the
//! frontend over the `lanchat://roster` event.
//!
//! Implemented in phase 3; this module is an intentional placeholder so the
//! module tree and `feat/lanchat` file layout are fixed from phase 1.
