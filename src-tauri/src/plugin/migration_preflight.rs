//! Read-only discovery and file-plan helpers for 0.5.x upgrades.
//!
//! This module is kept separate from the journal executor so the migration
//! orchestration remains small and the preflight can be reused by the upgrade
//! UI without pulling in execution state.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::Connection;

use super::{
    LegacyInstallSnapshot, LegacyVaultEvidence, MigrationCandidate, MigrationItem, MigrationSpec,
    source, source_fingerprint,
};

#[path = "migration_database.rs"]
mod database;

fn detect_legacy_files(data_dir: &Path) -> Vec<MigrationCandidate> {
    let mut candidates = Vec::new();
    let files = [
        ("mfa.db", MigrationItem::Mfa, "mfa"),
        ("sockscap/config.json", MigrationItem::SocksCap, "sockscap"),
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
/// reads schema and bounded row-existence queries, without running migrations
/// or writing application data. A malformed or unreadable database is surfaced to the caller
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
    let (database_tables, mut candidates, database_fingerprint) = match database_path.as_deref() {
        Some(path) => {
            let snapshot = database::read_legacy_database(path)?;
            (
                snapshot.tables,
                snapshot.candidates,
                Some(snapshot.fingerprint),
            )
        }
        None => (Vec::new(), Vec::new(), None),
    };
    candidates.extend(detect_legacy_files(&data_dir));

    let vault_path = data_dir.join("vault.db");
    let (vault, vault_fingerprint) = if vault_path.is_file() {
        let (fixed_key_present, fingerprint) =
            source::read_snapshot(&vault_path, read_vault_fixed_key_presence)?;
        (
            Some(LegacyVaultEvidence {
                path: vault_path.clone(),
                fixed_key_present,
            }),
            Some(fingerprint),
        )
    } else {
        (None, None)
    };
    // A fixed MFA data key is migration evidence even when the old database
    // file is absent. It still remains pending until the core Vault service and
    // a trusted MFA package can perform the scoped key handoff.
    if vault
        .as_ref()
        .is_some_and(|evidence| evidence.fixed_key_present)
        && !candidates
            .iter()
            .any(|candidate| candidate.item == MigrationItem::Mfa)
    {
        candidates.push(MigrationCandidate {
            item: MigrationItem::Mfa,
            evidence: vec!["vault.db".into()],
            plugin_slug: "mfa".into(),
        });
    }

    let mut source_fingerprints = BTreeMap::new();
    if let Some(fingerprint) = database_fingerprint {
        source_fingerprints.insert("taomni.db".into(), fingerprint);
    }
    if let Some(fingerprint) = vault_fingerprint
        && candidates
            .iter()
            .any(|candidate| candidate.item == MigrationItem::Mfa)
    {
        source_fingerprints.insert("vault.db".into(), fingerprint);
    }
    for candidate in &candidates {
        for evidence in &candidate.evidence {
            let path = data_dir.join(evidence);
            let relative = relative_display(&data_dir, &path);
            if (path.is_file() || path.is_dir()) && !source_fingerprints.contains_key(&relative) {
                let fingerprint = if evidence.ends_with(".db") {
                    source::stable_database_fingerprint(&path)?
                } else {
                    source_fingerprint(&path)?
                };
                source_fingerprints.insert(relative, fingerprint);
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
            MigrationItem::SocksCap => (
                PathBuf::from("sockscap/config.json"),
                PathBuf::from("data/config.json"),
            ),
            MigrationItem::Mobile
            | MigrationItem::RdpVncSessions
            | MigrationItem::VncSessions
            | MigrationItem::MailAccounts
            | MigrationItem::RdpCertificatePins
            | MigrationItem::ServerConfigs
            | MigrationItem::RdpServerConfigs
            | MigrationItem::VncServerConfigs => continue,
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

pub(super) fn read_vault_fixed_key_presence(connection: &Connection) -> Result<bool, String> {
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
