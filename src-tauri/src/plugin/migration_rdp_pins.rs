//! Export the one legacy table declared by the verified RDP package.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags, OptionalExtension};
use taomni_profile_locks::{PluginDataLease, PluginSlug, ProfileRoot};
use taomni_rdp_client_api::{
    PINS_DATABASE, PINS_SCHEMA, SLUG, TRUST_CERTIFICATE, normalize_fingerprint,
};

use super::{
    CORE_API_VERSION, ModuleManifest, SnapshotMode,
    migration::{
        LEGACY_SOURCE_VERSION, MigrationItem, MigrationJournal, MigrationStepState, paths, source,
    },
};

const LEGACY_DATABASE: &str = "taomni.db";
const TABLE: &str = "rdp_certificate_pins";
const RECEIPT_TABLE: &str = "legacy_rdp_pin_source";

pub(crate) fn owns_profile_pins(profile: &Path) -> Result<bool, String> {
    let plugins = profile.join("plugins");
    let installer = super::install::ModuleInstaller::new(&plugins);
    let pointer = installer
        .active_pointer(SLUG)
        .map_err(|error| error.to_string())?;
    if let Some(version) = pointer.active_version {
        let path = installer
            .version_dir(SLUG, &version)
            .map_err(|error| error.to_string())?;
        if let Ok(manifest) = super::verify::verify_installed(&path, super::current_platform())
            && manifest.slug == SLUG
        {
            return Ok(manifest.commands.contains(TRUST_CERTIFICATE));
        }
    }
    if paths::file_exists(&profile.join(PINS_DATABASE))? {
        return Ok(true);
    }
    let journal = MigrationJournal::load(&profile.join("migration/journal.json"))?;
    journal.committed_rdp_pins()
}

pub(crate) fn omit_rollback_pins(snapshot: &Connection) -> Result<(), String> {
    snapshot
        .execute_batch("DROP TABLE IF EXISTS rdp_certificate_pins;")
        .map_err(|error| error.to_string())
}

/// Project a verified legacy core backup into the RDP data schema.
/// The caller applies this file in the existing atomic restore transaction.
pub(crate) fn export_for_restore(legacy: &Path, staging: &Path) -> Result<Option<PathBuf>, String> {
    let (pins, fingerprint) = source::read_snapshot_checked(
        legacy,
        |connection| {
            table_exists(connection, TABLE)?
                .then(|| read_legacy_pins(connection))
                .transpose()
        },
        &|| Ok(()),
    )?;
    let Some(pins) = pins else {
        return Ok(None);
    };
    let output = staging.join("data.db");
    publish_pins(staging, &output, &pins, &fingerprint)?;
    Ok(Some(output))
}

pub(super) fn prepare(plugins: &Path, manifest: &ModuleManifest) -> Result<(), String> {
    if manifest.slug != SLUG || !manifest.commands.contains(TRUST_CERTIFICATE) {
        return Ok(());
    }
    if manifest.legacy_tables != [TABLE]
        || manifest.backup_paths != [PINS_DATABASE]
        || manifest.snapshot != SnapshotMode::Rpc
    {
        return Err("Incorrect RDP certificate migration manifest".into());
    }
    let profile = plugins.parent().ok_or("RDP profile root is unavailable")?;
    let root = ProfileRoot::prepare(profile).map_err(|error| error.to_string())?;
    let slug = PluginSlug::parse(SLUG.to_owned()).map_err(|error| error.to_string())?;
    let _writer = PluginDataLease::try_acquire(&root, &slug).map_err(|error| error.to_string())?;
    import(root.path())
}

fn import(profile: &Path) -> Result<(), String> {
    let journal_path = profile.join("migration/journal.json");
    if journal_path.parent().is_some_and(Path::exists) {
        paths::directory(journal_path.parent().expect("migration directory"))?;
    }
    let mut journal = MigrationJournal::load(&journal_path)?;
    if !journal.from_version.is_empty() && journal.to_core_api_version != CORE_API_VERSION {
        return Err("RDP certificate migration journal version is incompatible".into());
    }
    if journal.committed_rdp_pins()? {
        return Ok(());
    }
    let module = profile.join("plugins").join(SLUG);
    paths::directory(&module)?;
    let data = paths::create_directory(&module, "data")?;
    let target = profile.join(PINS_DATABASE);
    let legacy = profile.join(LEGACY_DATABASE);
    let fingerprint = if paths::database_exists(&target)? {
        // A previous attempt can have committed the complete SQLite file
        // before it could publish the profile journal. Read its original
        // receipt. A restored or already-owned database takes precedence.
        read_receipt(&target)?
    } else if paths::database_exists(&legacy)? {
        let (pins, fingerprint) =
            source::read_snapshot_checked(&legacy, read_legacy_pins, &|| Ok(()))?;
        if pins.is_empty() {
            None
        } else {
            publish_pins(&module, &target, &pins, &fingerprint)?;
            paths::sync_directory(&data)?;
            Some(fingerprint)
        }
    } else {
        None
    };
    if let Some(fingerprint) = fingerprint {
        if journal.from_version.is_empty() {
            journal.from_version = LEGACY_SOURCE_VERSION.to_owned();
            journal.to_core_api_version = CORE_API_VERSION.to_owned();
        }
        journal.mark_with_source(
            MigrationItem::RdpCertificatePins,
            MigrationStepState::Committed,
            fingerprint,
            PathBuf::from(LEGACY_DATABASE),
            PathBuf::from(PINS_DATABASE),
        );
        journal.save_atomic(&journal_path)?;
    }
    Ok(())
}

fn table_exists(connection: &Connection, name: &str) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?1)",
            [name],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())
}

type Pin = (String, String, i64);

fn read_legacy_pins(connection: &Connection) -> Result<Vec<Pin>, String> {
    if !table_exists(connection, TABLE)? {
        return Ok(Vec::new());
    }
    let mut query = connection
        .prepare(
            "SELECT endpoint, fingerprint, updated_at FROM rdp_certificate_pins ORDER BY endpoint",
        )
        .map_err(|error| error.to_string())?;
    let rows = query
        .query_map([], |row| {
            Ok((row.get(0)?, row.get::<_, String>(1)?, row.get(2)?))
        })
        .map_err(|error| error.to_string())?;
    rows.map(|row| {
        let (endpoint, pin, updated_at) = row.map_err(|error| error.to_string())?;
        Ok((endpoint, normalize_fingerprint(&pin)?, updated_at))
    })
    .collect()
}

fn read_receipt(target: &Path) -> Result<Option<String>, String> {
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NOFOLLOW;
    let db = Connection::open_with_flags(target, flags).map_err(|error| error.to_string())?;
    if !table_exists(&db, RECEIPT_TABLE)? {
        return Ok(None);
    }
    let fingerprint: Option<String> = db
        .query_row(
            "SELECT fingerprint FROM legacy_rdp_pin_source WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    fingerprint
        .filter(|value| source::valid_fingerprint(value))
        .map(Some)
        .ok_or("Invalid RDP certificate migration receipt".to_owned())
}

fn publish_pins(
    module: &Path,
    target: &Path,
    pins: &[Pin],
    fingerprint: &str,
) -> Result<(), String> {
    let staging = tempfile::NamedTempFile::new_in(module).map_err(|error| error.to_string())?;
    let mut db = Connection::open(staging.path()).map_err(|error| error.to_string())?;
    let transaction = db.transaction().map_err(|error| error.to_string())?;
    transaction
        .execute_batch(PINS_SCHEMA)
        .map_err(|error| error.to_string())?;
    {
        let mut insert = transaction
            .prepare("INSERT INTO rdp_certificate_pins VALUES (?1, ?2, ?3)")
            .map_err(|error| error.to_string())?;
        for (endpoint, pin, updated_at) in pins {
            insert
                .execute(rusqlite::params![endpoint, pin, updated_at])
                .map_err(|error| error.to_string())?;
        }
    }
    transaction.execute_batch(
        "CREATE TABLE legacy_rdp_pin_source (id INTEGER PRIMARY KEY CHECK(id = 1), fingerprint TEXT NOT NULL);",
    ).map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO legacy_rdp_pin_source VALUES (1, ?1)",
            [fingerprint],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    db.close().map_err(|(_, error)| error.to_string())?;
    staging
        .as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    staging
        .persist_noclobber(target)
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(test)]
#[path = "migration_rdp_pins_tests.rs"]
mod tests;
