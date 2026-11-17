//! Discover actual legacy module records, without loading session credentials.
use std::path::Path;

use rusqlite::{Connection, OpenFlags};

use super::{MigrationCandidate, MigrationItem};

pub(super) fn read_legacy_database(
    path: &Path,
) -> Result<(Vec<String>, Vec<MigrationCandidate>), String> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("legacy database cannot be opened read-only: {error}"))?;
    // Schema and row classification must describe the same SQLite snapshot.
    let transaction = connection
        .unchecked_transaction()
        .map_err(|error| format!("legacy database snapshot cannot be read: {error}"))?;
    inspect_database(&transaction)
}

fn inspect_database(
    connection: &Connection,
) -> Result<(Vec<String>, Vec<MigrationCandidate>), String> {
    let mut statement = connection
        .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .map_err(|error| format!("legacy database schema cannot be read: {error}"))?;
    let tables = statement
        .query_map([], |row| row.get::<_, String>(0))
        .and_then(|rows| rows.collect::<Result<Vec<_>, _>>())
        .map_err(|error| format!("legacy database table query failed: {error}"))?;
    let mut candidates = Vec::new();
    // These are constant queries, never table/column names from the old file.
    // EXISTS avoids materializing records, hostnames, passwords or config JSON.
    let checks = [
        (
            "sessions",
            "SELECT EXISTS(SELECT 1 FROM sessions WHERE session_type = 'RDP')",
            MigrationItem::RdpVncSessions,
            "rdp-client",
        ),
        (
            "sessions",
            "SELECT EXISTS(SELECT 1 FROM sessions WHERE session_type = 'VNC')",
            MigrationItem::VncSessions,
            "vnc-client",
        ),
        (
            "rdp_certificate_pins",
            "SELECT EXISTS(SELECT 1 FROM rdp_certificate_pins)",
            MigrationItem::RdpCertificatePins,
            "rdp-client",
        ),
        (
            "server_configs",
            "SELECT EXISTS(SELECT 1 FROM server_configs)",
            MigrationItem::ServerConfigs,
            "servers",
        ),
    ];
    for (table, query, item, slug) in checks {
        if !tables.iter().any(|name| name == table) {
            continue;
        }
        let found: bool = connection
            .query_row(query, [], |row| row.get(0))
            .map_err(|error| format!("legacy {table} records cannot be inspected: {error}"))?;
        if found {
            candidates.push(MigrationCandidate {
                item,
                evidence: vec!["taomni.db".into()],
                plugin_slug: slug.into(),
            });
        }
    }
    Ok((tables, candidates))
}

#[cfg(test)]
#[path = "migration_database_tests.rs"]
mod tests;
