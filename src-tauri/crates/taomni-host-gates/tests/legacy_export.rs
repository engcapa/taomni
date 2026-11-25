//! Compile the production exporter, scanner and source binding unchanged.
//! Files, SQLite/WAL and OS leases run only in the explicit hosted gate.
#[allow(dead_code)]
#[path = "../../../src/plugin/migration.rs"]
mod migration;

#[path = "legacy_export/data.rs"]
mod data;
#[path = "legacy_export/failure.rs"]
mod failure;
#[path = "legacy_export/key_check.rs"]
mod key_check;
#[path = "legacy_export/ownership.rs"]
mod ownership;
#[path = "legacy_export/support.rs"]
mod support;
