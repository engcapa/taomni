//! Reuse the helper's portable packet/flow contracts on every host. These tests
//! exercise production parsing, filter and expiry code without loading WinDivert;
//! the Windows helper binary tests separately compile the real OS integration.
#![allow(dead_code)]

#[path = "../../crates/sockscap-helper/src/capture/address.rs"]
mod address;
#[path = "../../crates/sockscap-helper/src/capture/filter.rs"]
mod filter;
#[path = "../../crates/sockscap-helper/src/capture/flow_table.rs"]
mod flow_table;
#[path = "../../crates/sockscap-helper/src/capture/packet.rs"]
mod packet;
#[path = "../../crates/sockscap-helper/src/capture/pid_map.rs"]
mod pid_map;
#[path = "../../crates/sockscap-helper/src/capture/tests.rs"]
mod tests;
