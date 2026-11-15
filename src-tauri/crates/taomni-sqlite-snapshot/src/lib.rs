//! A standalone online backup, not a copy of a database's main file.
//!
//! The caller owns profile/data leases and any cross-database barrier. This
//! helper provides a consistent single SQLite snapshot, includes committed WAL
//! pages, never initializes the source schema, and publishes only after checks.
//! The core and host can share this crate without Tauri or an async runtime.

mod backup;
mod context;
mod error;

pub use backup::{SnapshotOutcome, SnapshotSummary, snapshot_connection, snapshot_existing};
pub use context::{
    SnapshotControl, SnapshotObserver, SnapshotOptions, SnapshotPhase, SnapshotProgress,
};
pub use error::SnapshotError;

#[cfg(test)]
mod tests;
