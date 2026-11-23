//! Migrate the original RDP configuration into the signed server's data.

use std::path::Path;

use serde_json::Value;
use taomni_profile_locks::{PluginDataLease, PluginSlug, ProfileRoot};
use taomni_server_process::{ServerConfig, rdp};

use super::{
    CORE_API_VERSION, ModuleManifest, SnapshotMode,
    migration::{
        LEGACY_SOURCE_VERSION, MigrationItem, MigrationJournal, MigrationRunState,
        MigrationStepState, paths, source, valid_server_commit,
    },
    migration_server_config::{self, LEGACY_DATABASE, TABLE},
};

const ITEM: MigrationItem = MigrationItem::RdpServerConfigs;

pub(super) fn prepare(plugins: &Path, manifest: &ModuleManifest) -> Result<(), String> {
    if manifest.slug != rdp::SLUG || !manifest.commands.contains(rdp::SAVE_SETTINGS) {
        return Ok(());
    }
    if manifest.legacy_tables != [TABLE]
        || !manifest
            .backup_paths
            .iter()
            .any(|path| path == rdp::CONFIG_PATH)
        || manifest.snapshot != SnapshotMode::Rpc
        || !manifest.permissions.contains("fs.dataDir")
    {
        return Err("Invalid RDP Server migration manifest".into());
    }
    let profile = ProfileRoot::prepare(
        plugins
            .parent()
            .ok_or("RDP Server profile root unavailable")?,
    )
    .map_err(|error| error.to_string())?;
    let slug = PluginSlug::parse(rdp::SLUG).map_err(|error| error.to_string())?;
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
        return Err("RDP Server migration journal has an incompatible core API".into());
    }
    let mut entries = journal.entries.iter().filter(|entry| entry.item == ITEM);
    match (entries.next(), entries.next()) {
        (Some(entry), None)
            if entry.state == MigrationStepState::Committed && valid_server_commit(entry) =>
        {
            return Ok(());
        }
        (Some(entry), None)
            if entry.state == MigrationStepState::Pending
                && entry.target.as_os_str().is_empty() => {}
        (None, None) => {}
        _ => return Err("RDP Server migration journal requires recovery".into()),
    }

    let file = rdp::SettingsFile::new(profile);
    let legacy = profile.join(LEGACY_DATABASE);
    let fingerprint = match file.load().map_err(|error| error.to_string())? {
        Some(record) => record.legacy_source,
        None if paths::database_exists(&legacy)? => {
            let (config, fingerprint) = source::read_snapshot_checked(
                &legacy,
                |connection| migration_server_config::read(connection, "rdp"),
                &|| Ok(()),
            )?;
            let Some(config) = config else { return Ok(()) };
            file.save(&rdp::StoredSettings {
                settings: migrated_settings(config)?,
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
        return Err("RDP Server migration receipt is invalid".into());
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
        rdp::CONFIG_PATH.into(),
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

fn migrated_settings(value: Value) -> Result<ServerConfig, String> {
    use crate::vault::VAULT_REF_PREFIX;

    let mut config: ServerConfig = serde_json::from_value(value)
        .map_err(|error| format!("Invalid legacy RDP Server configuration: {error}"))?;
    let password = config.extra.remove("password");
    let reference = config.extra.remove("passwordRef");
    let reference = [reference.as_ref(), password.as_ref()]
        .into_iter()
        .flatten()
        .find_map(|entry| {
            entry.as_str().filter(|value| {
                value
                    .strip_prefix(VAULT_REF_PREFIX)
                    .is_some_and(|id| !id.is_empty())
            })
        });
    let has_plaintext = password
        .as_ref()
        .and_then(Value::as_str)
        .is_some_and(|password| !password.is_empty() && !password.starts_with(VAULT_REF_PREFIX));
    if let Some(reference) = reference {
        config.extra.insert("passwordRef".into(), reference.into());
    }
    if has_plaintext {
        config
            .extra
            .insert("credentialMigrationRequired".into(), true.into());
    } else {
        config.extra.remove("credentialMigrationRequired");
    }
    Ok(config)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use serde_json::json;

    #[test]
    fn keeps_the_rollback_row_and_recovers_the_journal_after_an_interruption() {
        let profile = tempfile::tempdir().unwrap();
        let root = profile.path();
        let legacy = root.join(LEGACY_DATABASE);
        let db = Connection::open(&legacy).unwrap();
        db.execute_batch(
            "CREATE TABLE server_configs (server_type TEXT PRIMARY KEY, config_json TEXT NOT NULL);",
        )
        .unwrap();
        let value = json!({"port":3395,"username":"old","password":"old-secret","viewOnly":true});
        db.execute(
            "INSERT INTO server_configs VALUES ('rdp', ?1), ('http', '{}')",
            [value.to_string()],
        )
        .unwrap();
        drop(db);
        let before = std::fs::read(&legacy).unwrap();
        import(root).unwrap();
        let file = rdp::SettingsFile::new(root);
        let mut record = file.load().unwrap().unwrap();
        assert_eq!(record.settings.port, 3395);
        assert!(record.settings.bool_field("viewOnly", false));
        assert!(record.needs_legacy_password());
        assert!(record.password_ref().is_none());
        assert!(
            !std::fs::read_to_string(root.join(rdp::CONFIG_PATH))
                .unwrap()
                .contains("old-secret")
        );

        let journal_path = root.join("migration/journal.json");
        std::fs::remove_file(&journal_path).unwrap();
        record.settings.port = 3396;
        file.save(&record).unwrap();
        import(root).unwrap();
        assert_eq!(file.load().unwrap().unwrap().settings.port, 3396);
        let journal = MigrationJournal::load(&journal_path).unwrap();
        assert_eq!(journal.entries.len(), 1);
        assert!(journal.has_valid_commit(ITEM));
        std::fs::remove_file(root.join(rdp::CONFIG_PATH)).unwrap();
        import(root).unwrap();
        assert!(file.load().unwrap().is_none());
        assert_eq!(std::fs::read(legacy).unwrap(), before);
    }

    #[test]
    fn preserves_the_early_vault_reference_format() {
        let settings = migrated_settings(json!({"port":3395,"password":"vault:legacy"})).unwrap();
        let record = rdp::StoredSettings {
            settings,
            legacy_source: None,
        };
        record.validate().unwrap();
        assert_eq!(record.password_ref(), Some("vault:legacy"));
        assert!(!record.needs_legacy_password());
    }
}
