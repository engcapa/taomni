//! Adopt the VNC row while leaving the original server table available to
//! the previous monolithic version.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension};
use taomni_profile_locks::{PluginDataLease, PluginSlug, ProfileRoot};
use taomni_server_process::vnc;

use super::{
    CORE_API_VERSION, ModuleManifest, SnapshotMode,
    migration::{
        LEGACY_SOURCE_VERSION, MigrationItem, MigrationJournal, MigrationJournalEntry,
        MigrationRunState, MigrationStepState, paths, source,
    },
};

const LEGACY_DATABASE: &str = "taomni.db";
const TABLE: &str = "server_configs";

pub(super) fn valid_commit(entry: &MigrationJournalEntry) -> bool {
    entry.item == MigrationItem::VncServerConfigs
        && entry.source_path == Path::new(LEGACY_DATABASE)
        && entry.target == Path::new(vnc::CONFIG_PATH)
        && source::valid_fingerprint(&entry.source_fingerprint)
}

pub(super) fn prepare(plugins: &Path, manifest: &ModuleManifest) -> Result<(), String> {
    if manifest.slug != vnc::SLUG || !manifest.commands.contains(vnc::SAVE_SETTINGS) {
        return Ok(());
    }
    if manifest.legacy_tables != [TABLE]
        || manifest.backup_paths != [vnc::CONFIG_PATH]
        || manifest.snapshot != SnapshotMode::Rpc
        || !manifest.permissions.contains("fs.dataDir")
    {
        return Err("Invalid VNC Server migration manifest".into());
    }
    let profile = ProfileRoot::prepare(
        plugins
            .parent()
            .ok_or("VNC Server profile root unavailable")?,
    )
    .map_err(|error| error.to_string())?;
    let slug = PluginSlug::parse(vnc::SLUG).map_err(|error| error.to_string())?;
    let _writer =
        PluginDataLease::try_acquire(&profile, &slug).map_err(|error| error.to_string())?;
    import(profile.path())
}

fn import(profile: &Path) -> Result<(), String> {
    let directory = profile.join("migration");
    if directory.exists() {
        paths::directory(&directory)?;
    }
    let journal_path = directory.join("journal.json");
    let mut journal = MigrationJournal::load(&journal_path)?;
    if !journal.from_version.is_empty() && journal.to_core_api_version != CORE_API_VERSION {
        return Err("VNC Server migration journal has an incompatible core API".into());
    }
    let mut entries = journal
        .entries
        .iter()
        .filter(|entry| entry.item == MigrationItem::VncServerConfigs);
    match (entries.next(), entries.next()) {
        (Some(entry), None)
            if entry.state == MigrationStepState::Committed && valid_commit(entry) =>
        {
            return Ok(());
        }
        (Some(entry), None)
            if entry.state == MigrationStepState::Pending
                && entry.target.as_os_str().is_empty() => {}
        (None, None) => {}
        _ => return Err("VNC Server migration journal requires recovery".into()),
    }

    let file = vnc::SettingsFile::new(profile);
    let legacy = profile.join(LEGACY_DATABASE);
    let fingerprint = match file.load().map_err(|error| error.to_string())? {
        Some(record) => record.legacy_source,
        None if paths::database_exists(&legacy)? => {
            let (settings, fingerprint) =
                source::read_snapshot_checked(&legacy, read_config, &|| Ok(()))?;
            if let Some(settings) = settings {
                file.save(&vnc::StoredSettings {
                    settings,
                    legacy_source: Some(fingerprint.clone()),
                })
                .map_err(|error| error.to_string())?;
                Some(fingerprint)
            } else {
                None
            }
        }
        None => None,
    };
    if let Some(fingerprint) = fingerprint {
        if !source::valid_fingerprint(&fingerprint) {
            return Err("VNC Server migration receipt is invalid".into());
        }
        paths::create_directory(profile, "migration")?;
        if journal.from_version.is_empty() {
            journal.from_version = LEGACY_SOURCE_VERSION.to_owned();
            journal.to_core_api_version = CORE_API_VERSION.to_owned();
        }
        journal.mark_with_source(
            MigrationItem::VncServerConfigs,
            MigrationStepState::Committed,
            fingerprint,
            PathBuf::from(LEGACY_DATABASE),
            PathBuf::from(vnc::CONFIG_PATH),
        );
        if journal
            .entries
            .iter()
            .all(|entry| entry.state == MigrationStepState::Committed)
        {
            journal.status = MigrationRunState::Complete;
        }
        journal.save_atomic(&journal_path)?;
    }
    Ok(())
}

fn read_config(connection: &Connection) -> Result<Option<vnc::Settings>, String> {
    let table_exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?1)",
            [TABLE],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if !table_exists {
        return Ok(None);
    }
    let row: Option<String> = connection
        .query_row(
            "SELECT config_json FROM server_configs WHERE server_type = 'vnc'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    row.map(|json| {
        let value: serde_json::Value =
            serde_json::from_str(&json).map_err(|error| error.to_string())?;
        let mut settings: vnc::Settings =
            serde_json::from_value(value.clone()).map_err(|error| error.to_string())?;
        settings.password_ref = None;
        settings.credential_migration_required = value
            .get("password")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|password| !password.is_empty());
        Ok(settings)
    })
    .transpose()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adopts_only_the_vnc_row_and_retries_without_overwriting_the_owner() {
        let profile = tempfile::tempdir().unwrap();
        let legacy = profile.path().join(LEGACY_DATABASE);
        let db = Connection::open(&legacy).unwrap();
        db.execute_batch(
            "CREATE TABLE server_configs (server_type TEXT PRIMARY KEY, config_json TEXT NOT NULL);
             INSERT INTO server_configs VALUES ('http', '{\"port\":8080}');
             INSERT INTO server_configs VALUES ('vnc', '{\"port\":5991,\"password\":\"old-secret\",\"viewOnly\":true}');",
        )
        .unwrap();
        drop(db);
        let before = std::fs::read(&legacy).unwrap();
        let root = profile.path();
        import(root).unwrap();
        let file = vnc::SettingsFile::new(root);
        let mut record = file.load().unwrap().unwrap();
        assert_eq!(record.settings.port, 5991);
        assert!(record.settings.view_only);
        assert!(record.settings.credential_migration_required);
        assert!(record.settings.password_ref.is_none());
        assert!(
            !std::fs::read_to_string(root.join(vnc::CONFIG_PATH))
                .unwrap()
                .contains("old-secret")
        );

        // A crash between publishing the file and saving the journal must
        // recover the same receipt and preserve any existing module settings.
        let journal_path = root.join("migration/journal.json");
        std::fs::remove_file(&journal_path).unwrap();
        record.settings.port = 5992;
        file.save(&record).unwrap();
        import(root).unwrap();
        let journal = MigrationJournal::load(&journal_path).unwrap();
        assert_eq!(journal.entries.len(), 1);
        assert!(valid_commit(&journal.entries[0]));
        assert_eq!(
            record.legacy_source.as_deref(),
            Some(journal.entries[0].source_fingerprint.as_str())
        );
        assert_eq!(file.load().unwrap().unwrap().settings.port, 5992);
        std::fs::remove_file(root.join(vnc::CONFIG_PATH)).unwrap();
        import(root).unwrap();
        assert!(file.load().unwrap().is_none());
        assert_eq!(std::fs::read(&legacy).unwrap(), before);
    }

    #[test]
    fn malformed_legacy_configuration_leaves_no_dataset_or_commit() {
        let profile = tempfile::tempdir().unwrap();
        let db = Connection::open(profile.path().join(LEGACY_DATABASE)).unwrap();
        db.execute_batch(
            "CREATE TABLE server_configs (server_type TEXT PRIMARY KEY, config_json TEXT NOT NULL);
             INSERT INTO server_configs VALUES ('vnc', '{\"port\":70000}');",
        )
        .unwrap();
        drop(db);
        assert!(import(profile.path()).is_err());
        assert!(!profile.path().join(vnc::CONFIG_PATH).exists());
        assert!(!profile.path().join("migration/journal.json").exists());
    }
}
