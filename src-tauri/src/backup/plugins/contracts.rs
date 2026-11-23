//! Data-only archive metadata. It never restores executable code or grants.
use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use taomni_plugin_api::services::{ProfileGeneration, SnapshotJobId};
use taomni_profile_locks::PluginSlug;

use super::super::manifest::BackupManifest;
use crate::plugin::data_contract::validate_relative;

pub const MODULAR_FORMAT_VERSION: u32 = 2;
pub const MAX_DATASETS: usize = 128;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PluginDataFileKind {
    File,
    Sqlite,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginDataFile {
    /// Relative to this owner's data subtree, not the profile or package root.
    pub path: String,
    pub kind: PluginDataFileKind,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginDataSet {
    pub slug: String,
    pub data_schema_version: u32,
    pub requires_vault: bool,
    pub job: SnapshotJobId,
    pub profile_generation: ProfileGeneration,
    pub files: Vec<PluginDataFile>,
}

pub(crate) fn owner_requires_vault(slug: &str) -> bool {
    slug == taomni_plugin_services::MFA_FIXED_KEY_OWNER.slug
        || slug == taomni_server_process::vnc::SLUG
        || slug == taomni_server_process::rdp::SLUG
        || slug == taomni_server_process::local::SLUG
}

pub(crate) fn dataset_requires_vault(slug: &str, files: &[PluginDataFile]) -> bool {
    use taomni_server_process::{local, rdp};

    let credentials_file = match slug {
        rdp::SLUG => rdp::CONFIG_FILENAME,
        local::SLUG => local::CONFIG_FILENAME,
        _ => return owner_requires_vault(slug),
    };
    files
        .iter()
        .any(|file| file.path.eq_ignore_ascii_case(credentials_file))
}

impl PluginDataSet {
    pub(crate) fn archive_path(&self, relative: &str) -> String {
        format!("plugins/{}/data/{relative}", self.slug)
    }

    pub(crate) fn owned_mailbox_names(&self) -> impl Iterator<Item = String> + '_ {
        self.files
            .iter()
            .filter(|_| self.slug == taomni_mail_api::SLUG)
            .filter_map(|file| {
                file.path.strip_suffix(".pop3-owner").or_else(|| {
                    file.path
                        .strip_suffix(taomni_mail_engine::imap_ownership::RECEIPT_SUFFIX)
                })
            })
            .map(|stem| format!("{stem}.db"))
    }

    pub(crate) fn validate(&self) -> Result<(), String> {
        PluginSlug::parse(&self.slug).map_err(|_| "Invalid plugin backup owner")?;
        if self.data_schema_version == 0 || self.files.is_empty() || self.files.len() > 16_384 {
            return Err("Invalid plugin backup schema or file count".into());
        }
        if self.requires_vault != dataset_requires_vault(&self.slug, &self.files) {
            return Err("Plugin backup Vault dependency disagrees with core policy".into());
        }
        let mut paths = BTreeSet::new();
        let mut spellings = BTreeMap::new();
        for file in &self.files {
            validate_relative(&file.path).map_err(|e| e.to_string())?;
            let mut prefix = String::new();
            for part in file.path.split('/') {
                if !prefix.is_empty() {
                    prefix.push('/');
                }
                prefix.push_str(part);
                if let Some(previous) = spellings.insert(prefix.to_lowercase(), prefix.clone()) {
                    if previous != prefix {
                        return Err("Case-conflicting plugin backup directory/file".into());
                    }
                }
            }
            if !paths.insert(file.path.to_lowercase()) {
                return Err("Duplicate or case-conflicting plugin backup path".into());
            }
        }
        for path in &paths {
            let mut parent = path.as_str();
            while let Some((next, _)) = parent.rsplit_once('/') {
                if paths.contains(next) {
                    return Err("Plugin backup file conflicts with a directory".into());
                }
                parent = next;
            }
        }
        if self.slug == taomni_mail_api::SLUG {
            let sqlite: BTreeSet<_> = self
                .files
                .iter()
                .filter(|file| file.kind == PluginDataFileKind::Sqlite)
                .map(|file| file.path.as_str())
                .collect();
            for file in &self.files {
                if let Some(stem) = file
                    .path
                    .strip_suffix(taomni_mail_engine::imap_ownership::RECEIPT_SUFFIX)
                    && (file.kind != PluginDataFileKind::File
                        || stem.contains('/')
                        || !sqlite.contains(format!("{stem}.db").as_str()))
                {
                    return Err(
                        "A Mail IMAP ownership receipt requires its account database snapshot"
                            .into(),
                    );
                }
            }
        }
        for file in self
            .files
            .iter()
            .filter(|file| file.kind == PluginDataFileKind::Sqlite)
        {
            for suffix in ["-wal", "-shm", "-journal"] {
                if paths.contains(&format!("{}{suffix}", file.path.to_lowercase())) {
                    return Err(
                        "SQLite sidecars must not be archived with a standalone snapshot".into(),
                    );
                }
            }
        }
        Ok(())
    }
}

/// Returns the exact plugin payload set. Both packing and restore use this
/// check; v1 cannot silently carry plugin files an older reader would ignore.
pub(crate) fn validate_manifest(
    manifest: &BackupManifest,
) -> Result<BTreeMap<String, PluginDataFileKind>, String> {
    match manifest.format_version {
        1 if manifest.plugin_datasets.is_empty() => (),
        MODULAR_FORMAT_VERSION if !manifest.plugin_datasets.is_empty() => (),
        _ => return Err("Unsupported or inconsistent backup format".into()),
    }
    if manifest.plugin_datasets.len() > MAX_DATASETS {
        return Err("Too many plugin backup datasets".into());
    }
    let mut owners = BTreeSet::new();
    let mut files = BTreeMap::new();
    let first = manifest.plugin_datasets.first();
    for dataset in &manifest.plugin_datasets {
        dataset.validate()?;
        if !owners.insert(dataset.slug.to_lowercase()) {
            return Err("Duplicate plugin backup owner".into());
        }
        if first.is_some_and(|first| {
            first.job != dataset.job || first.profile_generation != dataset.profile_generation
        }) {
            return Err("Plugin backup datasets have different snapshot generations/jobs".into());
        }
        for file in &dataset.files {
            files.insert(dataset.archive_path(&file.path), file.kind);
        }
    }
    let payloads: BTreeSet<_> = manifest
        .files
        .iter()
        .map(|entry| entry.path.as_str())
        .collect();
    for path in files.keys() {
        if !payloads.contains(path.as_str()) {
            return Err("Plugin dataset is missing its archive payload".into());
        }
    }
    for path in &payloads {
        if path.starts_with("plugins/") && !files.contains_key(*path) {
            return Err("Plugin payload is absent from the dataset inventory".into());
        }
    }
    let includes_mfa = payloads.contains("databases/mfa.db")
        || manifest
            .plugin_datasets
            .iter()
            .any(|dataset| dataset.requires_vault);
    if includes_mfa && !payloads.contains("databases/vault.db") {
        return Err("Encrypted MFA/plugin data requires vault.db in the same backup".into());
    }
    Ok(files)
}

pub(crate) fn is_sqlite(files: &BTreeMap<String, PluginDataFileKind>, name: &str) -> bool {
    files.get(name).map_or_else(
        || name.ends_with(".db") || name.ends_with(".sqlite"),
        |kind| *kind == PluginDataFileKind::Sqlite,
    )
}
