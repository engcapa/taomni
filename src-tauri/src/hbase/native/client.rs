//! High-level native HBase client: connection management, ZooKeeper bootstrap,
//! `hbase:meta` region location with caching, and the data/control plane
//! operations (get/put/delete/scan + list/describe/create/drop/status).
//!
//! This is the orchestration layer. It is deliberately synchronous-per-call
//! (locate region → RPC → parse) with a region-location cache; it does not yet
//! implement the full single-flight reconnect dance — on a NotServingRegion /
//! stale-cache error it invalidates the cached location and retries with a
//! bounded budget.

mod limits;

mod model;

mod connection;

mod names;

mod regions;

mod mutations;

mod scan;

mod catalog;

mod schema;

mod cells;

#[cfg(test)]
mod live_tests;

pub use model::{ClientError, FamilyDesc, NativeConfig, ResultRow};

pub use connection::NativeClient;
