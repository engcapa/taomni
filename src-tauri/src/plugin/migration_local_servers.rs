//! Export Local servers settings from the monolithic database.

use std::{collections::BTreeMap, path::Path};

use rusqlite::Connection;
use taomni_profile_locks::{PluginDataLease, PluginSlug, ProfileRoot};
use taomni_server_process::{ServerConfig, local};

use super::{
    CORE_API_VERSION, ModuleManifest, SnapshotMode,
    migration::{
        LEGACY_SOURCE_VERSION, MigrationItem, MigrationJournal, MigrationJournalEntry,
        MigrationRunState, MigrationStepState, paths, source,
    },
    migration_server_config::{self, LEGACY_DATABASE, TABLE},
};

const ITEM: MigrationItem = MigrationItem::ServerConfigs;

pub(super) fn valid_commit(entry: &MigrationJournalEntry) -> bool {
    entry.item == ITEM
        && entry.source_path == Path::new(LEGACY_DATABASE)
        && entry.target == Path::new(local::CONFIG_PATH)
        && source::valid_fingerprint(&entry.source_fingerprint)
}

pub(super) fn prepare(plugins: &Path, manifest: &ModuleManifest) -> Result<(), String> {
    if manifest.slug != local::SLUG || !manifest.commands.contains(local::SAVE_SETTINGS) {
        return Ok(());
    }
    if manifest.legacy_tables != [TABLE]
        || !manifest
            .backup_paths
            .iter()
            .any(|path| path == local::CONFIG_PATH)
        || manifest.snapshot != SnapshotMode::Rpc
        || !manifest.permissions.contains("fs.dataDir")
    {
        return Err("Invalid Local servers migration manifest".into());
    }
    let profile = ProfileRoot::prepare(plugins.parent().ok_or("Local servers profile is missing")?)
        .map_err(|error| error.to_string())?;
    let slug = PluginSlug::parse(local::SLUG).map_err(|error| error.to_string())?;
    let _writer =
        PluginDataLease::try_acquire(&profile, &slug).map_err(|error| error.to_string())?;
    import(profile.path())
}

fn import(profile: &Path) -> Result<(), String> {
    let directory = profile.join("migration");
    if directory.try_exists().map_err(|error| error.to_string())? {
        paths::directory(&directory)?;
    }
    let journal_path = directory.join("journal.json");
    let mut journal = MigrationJournal::load(&journal_path)?;
    if !journal.from_version.is_empty() && journal.to_core_api_version != CORE_API_VERSION {
        return Err("Local servers migration journal has an incompatible core API".into());
    }
    let mut entries = journal.entries.iter().filter(|entry| entry.item == ITEM);
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
        _ => return Err("Local servers migration journal requires recovery".into()),
    }
    let file = local::SettingsFile::new(profile);
    let legacy = profile.join(LEGACY_DATABASE);
    let fingerprint = match file.load().map_err(|error| error.to_string())? {
        Some(record) => record.legacy_source,
        None if paths::database_exists(&legacy)? => {
            let (settings, fingerprint) = source::read_snapshot_checked(&legacy, read, &|| Ok(()))?;
            if settings.is_empty() {
                return Ok(());
            }
            file.save(&local::StoredSettings {
                settings,
                legacy_source: Some(fingerprint.clone()),
            })
            .map_err(|error| error.to_string())?;
            Some(fingerprint)
        }
        None => None,
    };
    let Some(fingerprint) = fingerprint else {
        return Ok(());
    };
    if !source::valid_fingerprint(&fingerprint) {
        return Err("Local servers migration receipt is invalid".into());
    }
    paths::create_directory(profile, "migration")?;
    if journal.from_version.is_empty() {
        journal.from_version = LEGACY_SOURCE_VERSION.to_owned();
        journal.to_core_api_version = CORE_API_VERSION.to_owned();
    }
    journal.mark_with_source(
        ITEM,
        MigrationStepState::Committed,
        fingerprint,
        LEGACY_DATABASE.into(),
        local::CONFIG_PATH.into(),
    );
    if journal
        .entries
        .iter()
        .all(|entry| entry.state == MigrationStepState::Committed)
    {
        journal.status = MigrationRunState::Complete;
    }
    journal.save_atomic(&journal_path)
}

fn read(connection: &Connection) -> Result<BTreeMap<local::Kind, ServerConfig>, String> {
    let mut settings = BTreeMap::new();
    for kind in local::Kind::ALL {
        let Some(value) = migration_server_config::read(connection, kind.as_str())? else {
            continue;
        };
        let mut config: ServerConfig = serde_json::from_value(value)
            .map_err(|error| format!("Invalid legacy {} settings: {error}", kind.as_str()))?;
        let password = config.extra.remove("password");
        config.extra.remove("passwordRef");
        config.extra.remove("removePassword");
        config.extra.remove("credentialMigrationRequired");
        if kind.uses_password()
            && password
                .as_ref()
                .and_then(serde_json::Value::as_str)
                .is_some_and(|password| !password.is_empty())
        {
            config
                .extra
                .insert("credentialMigrationRequired".into(), true.into());
        }
        settings.insert(kind, config);
    }
    Ok(settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrates_local_rows_once_and_retains_desktop_and_rollback_rows() {
        let profile = tempfile::tempdir().unwrap();
        let root = profile.path();
        let legacy = root.join(LEGACY_DATABASE);
        let db = Connection::open(&legacy).unwrap();
        db.execute_batch(
            "CREATE TABLE server_configs (server_type TEXT PRIMARY KEY, config_json TEXT NOT NULL);
             INSERT INTO server_configs VALUES
                ('ssh', '{\"port\":2222,\"password\":\"old-secret\"}'),
                ('http', '{\"port\":8080}'),
                ('rdp', '{\"port\":3389}'),
                ('vnc', '{\"port\":5900}');",
        )
        .unwrap();
        drop(db);
        let original = std::fs::read(&legacy).unwrap();
        import(root).unwrap();
        let file = local::SettingsFile::new(root);
        let mut record = file.load().unwrap().unwrap();
        assert_eq!(record.settings.len(), 2);
        assert_eq!(record.settings[&local::Kind::Ssh].port, 2222);
        assert!(local::needs_legacy_password(
            &record.settings[&local::Kind::Ssh]
        ));
        assert!(
            !std::fs::read_to_string(root.join(local::CONFIG_PATH))
                .unwrap()
                .contains("old-secret")
        );
        let journal = root.join("migration/journal.json");
        std::fs::remove_file(&journal).unwrap();
        record.settings.get_mut(&local::Kind::Http).unwrap().port = 8081;
        file.save(&record).unwrap();
        import(root).unwrap();
        assert!(valid_commit(
            &MigrationJournal::load(&journal).unwrap().entries[0]
        ));
        assert_eq!(
            file.load().unwrap().unwrap().settings[&local::Kind::Http].port,
            8081
        );
        assert_eq!(std::fs::read(legacy).unwrap(), original);
    }
}
