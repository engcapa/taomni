//! Restore data dependencies and destinations are enforced by core owner policy.
use super::super::manifest::BackupManifest;
use super::{
    contracts::{owner_requires_vault, validate_manifest},
    discover_owners,
};
use crate::plugin::{
    data_contract::{PluginDataRoot, require_directory},
    retained_data,
};
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};
use taomni_profile_locks::{PluginDataLease, PluginSlug, ProfileRoot};

/// Runs before creating a restore intent, and again before applying it. The
/// second check catches encrypted plugin data created after the intent.
pub(crate) fn check_restore_dependencies(
    profile: &Path,
    manifest: &BackupManifest,
) -> Result<(), String> {
    validate_manifest(manifest)?;
    if !manifest
        .files
        .iter()
        .any(|entry| entry.path == "databases/vault.db")
    {
        return Ok(());
    }
    let restored: BTreeSet<_> = manifest
        .plugin_datasets
        .iter()
        .map(|dataset| dataset.slug.as_str())
        .collect();
    let plugins = profile.join("plugins");
    for owner in discover_owners(&plugins)? {
        if owner_requires_vault(&owner) && !restored.contains(owner.as_str()) {
            let root = ProfileRoot::prepare(profile).map_err(|e| e.to_string())?;
            let slug = PluginSlug::parse(&owner).map_err(|e| e.to_string())?;
            let _lease = PluginDataLease::try_acquire(&root, &slug)
                .map_err(|e| format!("Cannot check encrypted plugin data for {owner}: {e}"))?;
            let data = retained_data::discover(&plugins, &owner, 1).map_err(|e| e.to_string())?;
            if !data.files.is_empty() {
                return Err(format!(
                    "Restoring Vault would leave encrypted plugin {owner} without its matching data key; use a backup containing this module or an empty profile"
                ));
            }
        }
    }
    // Until MFA migrates, the legacy business DB still consumes this Vault.
    // Reading its table is a core-known alias, never a manifest-selected path.
    let legacy_mfa = profile.join("mfa.db");
    if legacy_mfa.try_exists().map_err(|e| e.to_string())?
        && !manifest
            .files
            .iter()
            .any(|entry| entry.path == "databases/mfa.db")
    {
        let file =
            crate::plugin::data_contract::open_regular(&legacy_mfa).map_err(|e| e.to_string())?;
        if file.metadata().map_err(|e| e.to_string())?.len() != 0 {
            let conn = rusqlite::Connection::open_with_flags(
                &legacy_mfa,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )
            .map_err(|e| format!("Cannot check existing MFA data before Vault restore: {e}"))?;
            let has_table: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='mfa_accounts')", [], |row| row.get(0)).map_err(|e| e.to_string())?;
            if has_table {
                let accounts: bool = conn
                    .query_row("SELECT EXISTS(SELECT 1 FROM mfa_accounts)", [], |row| {
                        row.get(0)
                    })
                    .map_err(|e| e.to_string())?;
                if accounts {
                    return Err("Restoring Vault requires the matching existing MFA accounts in the same backup".into());
                }
            }
        }
    }
    Ok(())
}

pub(crate) fn destination(
    profile: &Path,
    manifest: &BackupManifest,
    name: &str,
) -> Result<Option<PathBuf>, String> {
    if !name.starts_with("plugins/") {
        return Ok(None);
    }
    // All callers validate the complete manifest's exact payload inventory
    // once, before resolving entries. Do not revalidate a whole data set for
    // each file (large module archives would otherwise be quadratic).
    let mut parts = name.splitn(4, '/');
    if parts.next() != Some("plugins") {
        return Err("Invalid plugin data prefix".into());
    }
    let slug = parts.next().ok_or("Missing plugin data owner")?;
    if parts.next() != Some("data") {
        return Err("Only plugin data can be restored".into());
    }
    let relative = parts.next().ok_or("Missing plugin data file")?;
    crate::plugin::data_contract::validate_relative(relative).map_err(|e| e.to_string())?;
    if !manifest
        .plugin_datasets
        .iter()
        .any(|dataset| dataset.slug == slug)
    {
        return Err("Plugin restore entry has no validated dataset".into());
    }
    Ok(Some(
        profile
            .join("plugins")
            .join(slug)
            .join("data")
            .join(relative),
    ))
}

/// Enumerate the entire old data set while holding every owner lease. Stale
/// files must be journaled and removed, not left beside restored DBs/sidecars.
pub(crate) fn restore_targets(
    profile: &Path,
    manifest: &BackupManifest,
) -> Result<(Vec<PluginDataLease>, Vec<PathBuf>), String> {
    if manifest.plugin_datasets.is_empty() {
        return Ok((Vec::new(), Vec::new()));
    }
    let root = ProfileRoot::prepare(profile).map_err(|e| e.to_string())?;
    let plugins = profile.join("plugins");
    if !plugins.exists() {
        fs::create_dir(&plugins).map_err(|e| e.to_string())?;
    }
    require_directory(&plugins).map_err(|e| e.to_string())?;
    let mut leases = Vec::new();
    let mut targets = Vec::new();
    let mut owners: Vec<_> = manifest.plugin_datasets.iter().collect();
    owners.sort_by(|a, b| a.slug.cmp(&b.slug));
    for dataset in owners {
        let slug = PluginSlug::parse(&dataset.slug).map_err(|e| e.to_string())?;
        leases.push(
            PluginDataLease::try_acquire(&root, &slug)
                .map_err(|e| format!("Plugin {} is in use during restore: {e}", dataset.slug))?,
        );
        let old = retained_data::discover(&plugins, &dataset.slug, dataset.data_schema_version)
            .map_err(|e| e.to_string())?;
        let data = PluginDataRoot::open(&plugins, &dataset.slug).map_err(|e| e.to_string())?;
        for file in old.files {
            targets.push(data.resolve_file(&file.path).map_err(|e| e.to_string())?);
        }
    }
    Ok((leases, targets))
}

pub(crate) fn owner_leases(
    profile: &Path,
    owners: &[String],
) -> Result<Vec<PluginDataLease>, String> {
    if owners.is_empty() {
        return Ok(Vec::new());
    }
    let root = ProfileRoot::prepare(profile).map_err(|e| e.to_string())?;
    let mut leases = Vec::new();
    let mut ordered = owners.to_vec();
    ordered.sort();
    ordered.dedup();
    for owner in ordered {
        let slug = PluginSlug::parse(&owner).map_err(|e| e.to_string())?;
        leases.push(
            PluginDataLease::try_acquire(&root, &slug)
                .map_err(|e| format!("Plugin {owner} is in use during recovery: {e}"))?,
        );
    }
    Ok(leases)
}

/// Locators are reconstructed by core from validated data metadata. They are
/// never copied from an archive or used to restore trust/activation state.
pub(crate) fn stage_locators(
    profile: &Path,
    staging: &Path,
    manifest: &BackupManifest,
) -> Result<Vec<(PathBuf, PathBuf)>, String> {
    let mut mappings = Vec::new();
    for dataset in &manifest.plugin_datasets {
        let plugins = profile.join("plugins");
        retained_data::load(&plugins, &dataset.slug).map_err(|e| e.to_string())?;
        let locator = retained_data::RetainedDataLocator {
            format_version: 1,
            slug: dataset.slug.clone(),
            data_schema_version: dataset.data_schema_version,
            files: dataset
                .files
                .iter()
                .map(|file| retained_data::RetainedDataFile {
                    path: file.path.clone(),
                    kind: match file.kind {
                        super::contracts::PluginDataFileKind::File => {
                            retained_data::DataFileKind::File
                        }
                        super::contracts::PluginDataFileKind::Sqlite => {
                            retained_data::DataFileKind::Sqlite
                        }
                    },
                })
                .collect(),
        };
        locator.validate(&dataset.slug).map_err(|e| e.to_string())?;
        let core_staging = staging.join(".core-locators");
        fs::create_dir_all(&core_staging).map_err(|e| e.to_string())?;
        retained_data::save(&core_staging, &locator).map_err(|e| e.to_string())?;
        mappings.push((
            core_staging
                .join(".retained-data")
                .join(format!("{}.json", dataset.slug)),
            plugins
                .join(".retained-data")
                .join(format!("{}.json", dataset.slug)),
        ));
    }
    Ok(mappings)
}

/// Remove only empty data directories. Package/control directories are never
/// visited, and rollback can recreate parents for every journaled old file.
pub(crate) fn prune_empty_data(profile: &Path, owners: &[String]) -> Result<(), String> {
    fn prune(path: &Path) -> Result<(), String> {
        if !path.try_exists().map_err(|e| e.to_string())? {
            return Ok(());
        }
        require_directory(path).map_err(|e| e.to_string())?;
        for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let metadata = fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
            if crate::plugin::data_contract::is_link(&metadata) {
                return Err("Linked plugin restore data".into());
            }
            if metadata.is_dir() {
                prune(&entry.path())?;
            }
        }
        if fs::read_dir(path)
            .map_err(|e| e.to_string())?
            .next()
            .is_none()
        {
            fs::remove_dir(path).map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    for owner in owners {
        PluginSlug::parse(owner).map_err(|e| e.to_string())?;
        let root =
            PluginDataRoot::open(&profile.join("plugins"), owner).map_err(|e| e.to_string())?;
        prune(&root.data)?;
    }
    Ok(())
}
