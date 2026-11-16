//! A lightweight verification target for the production process adapter.
//! Nothing is copied: changes to the core supervisor or platform containment
//! are compiled directly in this crate on every hosted platform.

#[path = "../../../src/plugin/host.rs"]
pub mod host;

pub mod process_receipts;
