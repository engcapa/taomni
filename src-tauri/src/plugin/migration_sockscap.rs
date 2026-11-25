//! Adopt the monolith's saved settings and rule cache before activating SocksCap.
use std::{fs, io::Read, path::Path};

use sha2::{Digest, Sha256};
use taomni_profile_locks::{PluginDataLease, PluginSlug, ProfileRoot};
use taomni_sockscap_api::{
    CONFIG_PATH, RULES, RULES_PATH, SETTINGS, SLUG, SocksCapConfig,
    gfwlist_rules::{GfwListMeta, RuleCache},
};

use super::{
    CORE_API_VERSION, ModuleManifest,
    migration::{
        LEGACY_SOURCE_VERSION, MigrationItem, MigrationJournal, MigrationRunState,
        MigrationStepState, paths,
    },
};

const CONFIG: &str = "sockscap/config.json";
const ITEM: MigrationItem = MigrationItem::SocksCap;

pub(super) fn prepare(plugins: &Path, manifest: &ModuleManifest) -> Result<(), String> {
    if manifest.slug != SLUG || !manifest.commands.contains(SETTINGS) {
        return Ok(());
    }
    let profile = ProfileRoot::prepare(plugins.parent().ok_or("SocksCap profile is missing")?)
        .map_err(|e| e.to_string())?;
    let legacy = profile.path().join(SLUG);
    if !directory_exists(&legacy)? {
        return Ok(());
    }
    let slug = PluginSlug::parse(SLUG).map_err(|e| e.to_string())?;
    let _writer = PluginDataLease::try_acquire(&profile, &slug).map_err(|e| e.to_string())?;
    let rules = manifest.commands.contains(RULES);
    if !manifest.backup_paths.iter().any(|p| p == CONFIG_PATH)
        || (rules && !manifest.backup_paths.iter().any(|p| p == RULES_PATH))
    {
        return Err("SocksCap migration requires the declared backup paths".into());
    }
    import(profile.path(), rules)
}

fn directory_exists(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.to_string()),
        Ok(_) => paths::directory(path).map(|()| true),
    }
}

fn import(profile: &Path, rules: bool) -> Result<(), String> {
    let legacy = profile.join(SLUG);
    let has_config = paths::file_exists(&profile.join(CONFIG))?;
    let rules_dir = legacy.join("rules");
    let has_rules = rules
        && directory_exists(&rules_dir)?
        && paths::file_exists(&rules_dir.join("gfwlist.raw"))?;
    if !has_config && !has_rules {
        return Ok(());
    }
    let plugins = paths::create_directory(profile, "plugins")?;
    let module = paths::create_directory(&plugins, SLUG)?;
    paths::create_directory(&module, "data")?;
    if has_rules && !paths::file_exists(&profile.join(RULES_PATH))? {
        let mut raw = String::new();
        paths::open_file(&rules_dir.join("gfwlist.raw"))?
            .read_to_string(&mut raw)
            .map_err(|e| e.to_string())?;
        let path = rules_dir.join("gfwlist.meta.json");
        let meta = if paths::file_exists(&path)? {
            serde_json::from_reader(paths::open_file(&path)?).map_err(|e| e.to_string())?
        } else {
            GfwListMeta {
                source: "cache".into(),
                rule_count: 0,
                skipped: 0,
                last_refresh: None,
                etag: None,
            }
        };
        let mut cache = RuleCache { raw, meta };
        cache.meta = cache.compile()?.meta;
        paths::write_json_durable(&profile.join(RULES_PATH), &cache)?;
    }
    if !has_config {
        return Ok(());
    }
    let journal_path = paths::create_directory(profile, "migration")?.join("journal.json");
    let mut journal = MigrationJournal::load(&journal_path)?;
    if journal.has_valid_commit(ITEM) {
        return Ok(());
    }
    if !journal.from_version.is_empty() && journal.to_core_api_version != CORE_API_VERSION {
        return Err("SocksCap migration journal has an incompatible core API".into());
    }
    let mut entries = journal.entries.iter().filter(|entry| entry.item == ITEM);
    if let Some(entry) = entries.next()
        && (entries.next().is_some()
            || entry.state != MigrationStepState::Pending
            || !entry.target.as_os_str().is_empty())
    {
        return Err("SocksCap migration journal requires recovery".into());
    }
    let mut original = Vec::new();
    paths::open_file(&profile.join(CONFIG))?
        .read_to_end(&mut original)
        .map_err(|e| e.to_string())?;
    let target = profile.join(CONFIG_PATH);
    if !paths::file_exists(&target)? {
        let mut settings: SocksCapConfig = serde_json::from_slice(&original)
            .map_err(|e| format!("Invalid legacy SocksCap configuration: {e}"))?;
        settings.normalize();
        paths::write_json_durable(&target, &settings)?;
    } else {
        // A previous host may already own newer settings. Validate and preserve them.
        serde_json::from_reader::<_, SocksCapConfig>(paths::open_file(&target)?)
            .map_err(|e| e.to_string())?;
    }
    if journal.from_version.is_empty() {
        journal.from_version = LEGACY_SOURCE_VERSION.into();
        journal.to_core_api_version = CORE_API_VERSION.into();
    }
    let fingerprint = format!(
        "sha256:{}:bytes:{}",
        hex::encode(Sha256::digest(&original)),
        original.len()
    );
    journal.mark_with_source(
        ITEM,
        MigrationStepState::Committed,
        fingerprint,
        CONFIG.into(),
        CONFIG_PATH.into(),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installs_settings_and_rules_before_first_use_and_preserves_owned_edits() {
        let profile = tempfile::tempdir().unwrap();
        let root = profile.path();
        let rules_dir = root.join("sockscap/rules");
        fs::create_dir_all(&rules_dir).unwrap();
        let original = br#"{"restoreOnLogin":true}"#;
        fs::write(root.join(CONFIG), original).unwrap();
        fs::write(rules_dir.join("gfwlist.raw"), "||example.test\n").unwrap();

        import(root, true).unwrap();
        assert!(
            serde_json::from_reader::<_, SocksCapConfig>(
                paths::open_file(&root.join(CONFIG_PATH)).unwrap()
            )
            .unwrap()
            .restore_on_login
        );
        let cache: RuleCache =
            serde_json::from_reader(paths::open_file(&root.join(RULES_PATH)).unwrap()).unwrap();
        assert_eq!(cache.meta.rule_count, 1);
        let journal = root.join("migration/journal.json");
        assert!(
            MigrationJournal::load(&journal)
                .unwrap()
                .has_valid_commit(ITEM)
        );

        fs::write(root.join(CONFIG_PATH), b"{}").unwrap();
        fs::remove_file(&journal).unwrap();
        import(root, true).unwrap();
        assert_eq!(fs::read(root.join(CONFIG_PATH)).unwrap(), b"{}");
        assert_eq!(fs::read(root.join(CONFIG)).unwrap(), original);
        assert!(
            MigrationJournal::load(&journal)
                .unwrap()
                .has_valid_commit(ITEM)
        );
    }
}
