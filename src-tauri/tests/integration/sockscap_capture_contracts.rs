//! Reuse the helper's portable packet/flow contracts on every host. These tests
//! exercise production parsing, filter and expiry code without loading WinDivert;
//! the Windows helper binary tests separately compile the real OS integration.
#![allow(dead_code)]

#[path = "../../src/bin/sockscap-helper/capture/address.rs"]
mod address;
#[path = "../../src/bin/sockscap-helper/capture/filter.rs"]
mod filter;
#[path = "../../src/bin/sockscap-helper/capture/flow_table.rs"]
mod flow_table;
#[path = "../../src/bin/sockscap-helper/capture/packet.rs"]
mod packet;
#[path = "../../src/bin/sockscap-helper/capture/pid_map.rs"]
mod pid_map;
#[path = "../../src/bin/sockscap-helper/capture/tests.rs"]
mod tests;
