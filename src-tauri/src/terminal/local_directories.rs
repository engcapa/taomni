//! Welcome "Local directories" persistence: confirmed-use tracking, legacy
//! command-history migration, cross-platform path identity and the unified
//! sorted listing consumed by `WelcomePanel`.
//!
//! Design contract: docs-feature/welcome-recents-session-restore-design.md
//! §4.1. Only confirmed uses (a successful native-local PTY start, or a live
//! local terminal reporting its cwd via OSC 7) advance `last_used_at_ms`;
//! legacy `command_history` observations never do.

mod schema;

mod limits;

mod model;

mod identity;

mod recording;

mod migration;

mod listing;

mod probes;

#[cfg(test)]
mod tests;

pub use schema::{
    METADATA_DIRECTORY_REVISION, METADATA_MIGRATION_COMPLETE, directory_revision, init_tables,
};

pub use limits::{PROBE_BUDGET, SOURCE_LOCAL_CWD, SOURCE_LOCAL_START};

pub use model::{
    Availability, DirectoryListEnvelope, DirectoryRow, DirectoryShortcut,
    RecordDirectoryUseResponse,
};

pub(crate) use model::PersistedRow;

pub use identity::{
    IdentityProbe, ResolvedIdentity, begin_identity_probe, finish_identity_probe,
    normalize_path_key, resolved_path_key,
};

pub use recording::{record_directory_use, system_now_ms};

pub use migration::migrate_legacy_history;

pub use listing::{compare_directories, default_candidates, list_directory_shortcuts};

pub(crate) use listing::merge_directory_candidates;

pub use probes::probe_availability;
