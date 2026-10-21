//! Welcome run-snapshot persistence (design §4.2.1, D-01 = scheme B).
//!
//! A single-row table stores the last committed *run batch snapshot*: the
//! ordered, recoverable session-tab set of the previous main-window run,
//! including whitelist local terminals (confirmed native cwd) but never whole
//! workspaces. Legacy candidates come from `sessions.last_connected_at` and
//! are always labelled as such — they never become confirmed-use records.

mod model;

mod validation;

mod metadata;

mod reading;

mod legacy;

mod commit;

mod clearing;

#[cfg(test)]
mod tests;

pub use model::{
    CommitRunSnapshotResponse, GetRunSnapshotResponse, RunSnapshotRecord, SNAPSHOT_SCHEMA_VERSION,
    SnapshotEntry, SnapshotIssue,
};

pub use validation::is_recoverable_saved_session_type;

pub use metadata::init_tables;

pub use reading::{get_run_snapshot, get_welcome_run_snapshot};

pub(crate) use reading::{
    __cmd__get_welcome_run_snapshot, __tauri_command_name_get_welcome_run_snapshot,
};

pub use commit::{commit_run_snapshot, commit_welcome_run_snapshot};

pub(crate) use commit::{
    __cmd__commit_welcome_run_snapshot, __tauri_command_name_commit_welcome_run_snapshot,
};

pub use clearing::{clear_run_snapshot, clear_welcome_run_snapshot};

pub(crate) use clearing::{
    __cmd__clear_welcome_run_snapshot, __tauri_command_name_clear_welcome_run_snapshot,
};
