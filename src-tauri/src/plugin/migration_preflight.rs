//! Read-only discovery and file-plan helpers for 0.5.x upgrades.
//!
//! This module is kept separate from the journal executor so the migration
//! orchestration remains small and the preflight can be reused by the upgrade
//! UI without pulling in execution state.

use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};
use sha2::{Digest, Sha256};

use super::{
    LegacyInstallSnapshot, LegacyVaultEvidence, MigrationCandidate, MigrationItem, MigrationSpec,
    source_fingerprint,
};

pub fn detect_legacy_install(data_dir: &Path, db_tables: &[&str]) -> Vec<MigrationCandidate> {
    let mut candidates = Vec::new();
    let table = |name: &str| db_tables.iter().any(|value| *value == name);
    if table("sessions") || table("rdp_certificate_pins") {
        candidates.push(MigrationCandidate {
            item: MigrationItem::RdpVncSessions,
            evidence: vec!["session records".into()],
            plugin_slug: "rdp-client".into(),
        });
    }
    if table("rdp_certificate_pins") {
        candidates.push(MigrationCandidate {
            item: MigrationItem::RdpCertificatePins,
            evidence: vec!["rdp_certificate_pins".into()],
            plugin_slug: "rdp-client".into(),
        });
    }
    if table("server_configs") {
        candidates.push(MigrationCandidate {
            item: MigrationItem::ServerConfigs,
            evidence: vec!["server_configs".into()],
            plugin_slug: "servers".into(),
        });
    }
    let files = [
        ("mfa.db", MigrationItem::Mfa, "mfa"),
        ("sockscap/config.json", MigrationItem::SocksCap, "sockscap"),
        (
            "mobile-desktop-remote.json",
            MigrationItem::Mobile,
            "mobile",
        ),
    ];
    for (relative, item, slug) in files {
        if data_dir.join(relative).exists() {
            candidates.push(MigrationCandidate {
                item,
                evidence: vec![relative.into()],
                plugin_slug: slug.into(),
            });
        }
    }
    candidates
}

/// Inspect a 0.5.x app-data directory without mutating it.
///
/// The old database is opened with `SQLITE_OPEN_READ_ONLY`; the query only
/// reads `sqlite_master`, and therefore does not run migrations or create a
/// journal/WAL.  A malformed or unreadable database is surfaced to the caller
/// instead of being treated as an empty installation.  `lanchat.sqlite` is
/// intentionally only listed in `retained_paths`; it is never opened, copied,
/// or included in the migration candidates.
pub fn inspect_legacy_install(
    data_dir: &Path,
    from_version: impl Into<String>,
) -> Result<LegacyInstallSnapshot, String> {
    let from_version = from_version.into();
    if from_version.trim().is_empty() {
        return Err("legacy source version is required".into());
    }
    if !data_dir.exists() {
        return Ok(LegacyInstallSnapshot {
            from_version,
            database_path: None,
            database_tables: Vec::new(),
            candidates: Vec::new(),
            source_fingerprints: BTreeMap::new(),
            retained_paths: Vec::new(),
            vault: None,
        });
    }
    let metadata = fs::symlink_metadata(data_dir)
        .map_err(|error| format!("legacy data directory is unreadable: {error}"))?;
    if metadata.file_type().is_symlink() {
        return Err("legacy data directory cannot be a symlink".into());
    }
    let data_dir = data_dir
        .canonicalize()
        .map_err(|error| format!("legacy data directory is unreadable: {error}"))?;

    let database = data_dir.join("taomni.db");
    let database_path = if database.is_file() {
        Some(database.clone())
    } else {
        None
    };
    let database_tables = match database_path.as_deref() {
        Some(path) => read_legacy_database_tables(path)?,
        None => Vec::new(),
    };
    let table_refs = database_tables
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>();
    let candidates = detect_legacy_install(&data_dir, &table_refs);

    let mut source_fingerprints = BTreeMap::new();
    if let Some(path) = database_path.as_deref() {
        source_fingerprints.insert(relative_display(&data_dir, path), source_fingerprint(path)?);
    }
    for candidate in &candidates {
        for evidence in &candidate.evidence {
            let path = data_dir.join(evidence);
            if path.is_file() || path.is_dir() {
                source_fingerprints
                    .entry(relative_display(&data_dir, &path))
                    .or_insert(source_fingerprint(&path)?);
            }
        }
    }

    // LanChat was removed. Preserve the old file in place for manual backup,
    // but do not fingerprint it as a migration input or open its database.
    let retained_paths = ["lanchat.sqlite", "lanchat.db"]
        .into_iter()
        .map(|relative| data_dir.join(relative))
        .filter(|path| path.exists())
        .collect::<Vec<_>>();

    let vault_path = data_dir.join("vault.db");
    let vault = if vault_path.is_file() {
        Some(LegacyVaultEvidence {
            path: vault_path.clone(),
            fixed_key_present: read_vault_fixed_key_presence(&vault_path)?,
        })
    } else {
        None
    };
    Ok(LegacyInstallSnapshot {
        from_version,
        database_path,
        database_tables,
        candidates,
        source_fingerprints,
        retained_paths,
        vault,
    })
}

/// Build the filesystem portions of a migration plan from a preflight report.
///
/// `taomni.db` legacy tables are deliberately excluded: they must be exported
/// through the core's read-only data service, not copied wholesale into a
/// plugin directory. Callers can append those exported files as
/// [`MigrationSpec`] values after the export completes.
pub fn build_file_migration_specs(
    data_dir: &Path,
    candidates: &[MigrationCandidate],
) -> Result<Vec<MigrationSpec>, String> {
    let mut specs = Vec::new();
    for candidate in candidates {
        let (source, target) = match candidate.item {
            MigrationItem::Mfa => (PathBuf::from("mfa.db"), PathBuf::from("data/mfa.db")),
            MigrationItem::SocksCap => (PathBuf::from("sockscap"), PathBuf::from("data/sockscap")),
            MigrationItem::Mobile => (
                PathBuf::from("mobile-desktop-remote.json"),
                PathBuf::from("data/mobile-desktop-remote.json"),
            ),
            MigrationItem::RdpVncSessions
            | MigrationItem::RdpCertificatePins
            | MigrationItem::ServerConfigs => continue,
        };
        let source_path = data_dir.join(&source);
        if !source_path.exists() {
            return Err(format!(
                "migration candidate source is missing: {}",
                source.display()
            ));
        }
        specs.push(MigrationSpec {
            item: candidate.item,
            plugin_slug: candidate.plugin_slug.clone(),
            source,
            target,
        });
    }
    Ok(specs)
}

fn read_legacy_database_tables(path: &Path) -> Result<Vec<String>, String> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("legacy database cannot be opened read-only: {error}"))?;
    let mut statement = connection
        .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .map_err(|error| format!("legacy database schema cannot be read: {error}"))?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("legacy database table query failed: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("legacy database table row failed: {error}"))
}

fn read_vault_fixed_key_presence(path: &Path) -> Result<bool, String> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("legacy Vault cannot be opened read-only: {error}"))?;
    let has_table = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='vault_entries')",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("legacy Vault schema cannot be read: {error}"))?;
    if has_table == 0 {
        return Ok(false);
    }
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM vault_entries WHERE id = 'mfa.data-key-v1')",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|value| value != 0)
        .map_err(|error| format!("legacy Vault fixed-key query failed: {error}"))
}

fn relative_display(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}
