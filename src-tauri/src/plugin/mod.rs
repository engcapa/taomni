//! Core side of the P1 plugin contract.
//!
//! The registry intentionally owns metadata and lifecycle state only. Plugin
//! implementation state belongs to a supervised host process and is never
//! deserialized into `AppState`.

use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, RwLock};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

pub const CORE_API_VERSION: &str = "1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PluginKind {
    RemoteClient,
    LocalServer,
    Collaboration,
    Media,
    Auth,
    AiLocal,
    Mobile,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PluginStatus {
    Stable,
    Provisional,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PluginEntry {
    pub host: Option<String>,
    pub frontend: Option<String>,
    pub protocol: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PluginTab {
    pub kind: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ModuleManifest {
    pub id: String,
    pub slug: String,
    pub name: String,
    pub version: String,
    #[serde(rename = "coreApiVersion")]
    pub core_api_version: String,
    pub kind: PluginKind,
    pub status: PluginStatus,
    #[serde(default, rename = "removalCandidate")]
    pub removal_candidate: bool,
    pub platforms: BTreeSet<String>,
    pub entry: PluginEntry,
    pub tabs: Vec<PluginTab>,
    pub commands: BTreeSet<String>,
    pub permissions: BTreeSet<String>,
    #[serde(rename = "dataDir")]
    pub data_dir: String,
    #[serde(rename = "backupPaths")]
    pub backup_paths: Vec<String>,
    #[serde(rename = "legacyTables")]
    pub legacy_tables: Vec<String>,
    #[serde(rename = "vaultFixedKeys")]
    pub vault_fixed_keys: Vec<String>,
    pub snapshot: SnapshotMode,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum SnapshotMode {
    #[default]
    File,
    Rpc,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum LifecycleState {
    Installed,
    Enabled,
    Disabled,
    Uninstalled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PluginRecord {
    pub manifest: ModuleManifest,
    pub state: LifecycleState,
    pub reason: Option<String>,
}

#[derive(Debug, Error)]
pub enum PluginError {
    #[error("plugin {0} is not installed")]
    NotFound(String),
    #[error("plugin {0} is disabled")]
    Disabled(String),
    #[error("plugin manifest is invalid: {0}")]
    InvalidManifest(String),
    #[error("plugin command {command} is not declared by {slug}")]
    CommandDenied { slug: String, command: String },
    #[error("plugin permission {permission} is not declared by {slug}")]
    PermissionDenied { slug: String, permission: String },
    #[error("plugin host is unavailable for {0}")]
    HostUnavailable(String),
    #[error("plugin registry I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("plugin registry JSON failed: {0}")]
    Json(#[from] serde_json::Error),
}

#[derive(Debug, Clone)]
pub struct PluginRegistry {
    root: PathBuf,
    core_api_version: String,
    records: Arc<RwLock<HashMap<String, PluginRecord>>>,
}

impl PluginRegistry {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            core_api_version: CORE_API_VERSION.to_owned(),
            records: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn scan(&self) -> Result<(), PluginError> {
        if !self.root.exists() {
            fs::create_dir_all(&self.root)?;
        }
        let mut records = self.records.write().expect("plugin registry lock poisoned");
        records.clear();
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            let path = entry.path();
            if !entry.file_type()?.is_dir() || path.file_name().is_some_and(|n| n == "state.json") {
                continue;
            }
            let slug = entry.file_name().to_string_lossy().into_owned();
            let manifest_path = path.join("module.json");
            let record = match fs::read_to_string(&manifest_path)
                .map_err(PluginError::from)
                .and_then(|raw| {
                    serde_json::from_str::<ModuleManifest>(&raw).map_err(PluginError::from)
                })
                .and_then(|manifest| self.validate_manifest(&manifest, &path).map(|_| manifest))
            {
                Ok(manifest) => PluginRecord {
                    manifest,
                    state: LifecycleState::Installed,
                    reason: None,
                },
                Err(error) => PluginRecord {
                    manifest: placeholder_manifest(&slug),
                    state: LifecycleState::Disabled,
                    reason: Some(error.to_string()),
                },
            };
            records.insert(slug, record);
        }
        self.load_enabled_state(&mut records)?;
        Ok(())
    }

    pub fn list(&self) -> Vec<PluginRecord> {
        let mut values = self
            .records
            .read()
            .expect("plugin registry lock poisoned")
            .values()
            .cloned()
            .collect::<Vec<_>>();
        values.sort_by(|a, b| a.manifest.slug.cmp(&b.manifest.slug));
        values
    }

    pub fn get(&self, slug: &str) -> Option<PluginRecord> {
        self.records
            .read()
            .expect("plugin registry lock poisoned")
            .get(slug)
            .cloned()
    }

    pub fn set_enabled(&self, slug: &str, enabled: bool) -> Result<PluginRecord, PluginError> {
        let mut records = self.records.write().expect("plugin registry lock poisoned");
        let record = records
            .get_mut(slug)
            .ok_or_else(|| PluginError::NotFound(slug.to_owned()))?;
        if record.reason.is_some() {
            return Err(PluginError::InvalidManifest(
                record.reason.clone().unwrap_or_default(),
            ));
        }
        record.state = if enabled {
            LifecycleState::Enabled
        } else {
            LifecycleState::Disabled
        };
        let snapshot = records.clone();
        drop(records);
        self.persist_enabled_state(&snapshot)?;
        self.get(slug)
            .ok_or_else(|| PluginError::NotFound(slug.to_owned()))
    }

    pub fn invoke(&self, slug: &str, command: &str, _payload: Value) -> Result<Value, PluginError> {
        let record = self
            .get(slug)
            .ok_or_else(|| PluginError::NotFound(slug.to_owned()))?;
        if record.state != LifecycleState::Enabled {
            return Err(PluginError::Disabled(slug.to_owned()));
        }
        if !record.manifest.commands.contains(command) {
            return Err(PluginError::CommandDenied {
                slug: slug.to_owned(),
                command: command.to_owned(),
            });
        }
        // The process supervisor is deliberately a separate M0 task. Returning
        // a stable error here prevents a missing host from becoming a blank UI
        // and gives the frontend a retry/install path.
        Err(PluginError::HostUnavailable(slug.to_owned()))
    }

    fn validate_manifest(&self, manifest: &ModuleManifest, dir: &Path) -> Result<(), PluginError> {
        if !valid_slug(&manifest.slug) || manifest.id != format!("taomni-plugin-{}", manifest.slug)
        {
            return Err(PluginError::InvalidManifest("id/slug is invalid".into()));
        }
        if manifest.version.trim().is_empty() || manifest.core_api_version != self.core_api_version
        {
            return Err(PluginError::InvalidManifest(
                "version or coreApiVersion is incompatible".into(),
            ));
        }
        if manifest.name.trim().is_empty() {
            return Err(PluginError::InvalidManifest("name is required".into()));
        }
        if dir
            .file_name()
            .is_none_or(|name| name != std::ffi::OsStr::new(&manifest.slug))
        {
            return Err(PluginError::InvalidManifest(
                "directory does not match slug".into(),
            ));
        }
        validate_relative_path(&manifest.data_dir)?;
        if manifest.data_dir != format!("plugins/{}", manifest.slug) {
            return Err(PluginError::InvalidManifest(
                "dataDir must be plugins/<slug>".into(),
            ));
        }
        for path in manifest.backup_paths.iter() {
            validate_relative_path(path)?;
        }
        Ok(())
    }

    fn state_path(&self) -> PathBuf {
        self.root.join("state.json")
    }

    fn load_enabled_state(
        &self,
        records: &mut HashMap<String, PluginRecord>,
    ) -> Result<(), PluginError> {
        let path = self.state_path();
        if !path.exists() {
            return Ok(());
        }
        let enabled: HashMap<String, bool> = serde_json::from_str(&fs::read_to_string(path)?)?;
        for (slug, is_enabled) in enabled {
            if let Some(record) = records.get_mut(&slug) {
                if record.reason.is_none() {
                    record.state = if is_enabled {
                        LifecycleState::Enabled
                    } else {
                        LifecycleState::Disabled
                    };
                }
            }
        }
        Ok(())
    }

    fn persist_enabled_state(
        &self,
        records: &HashMap<String, PluginRecord>,
    ) -> Result<(), PluginError> {
        let state = records
            .iter()
            .filter(|(_, record)| record.reason.is_none())
            .map(|(slug, record)| (slug.clone(), record.state == LifecycleState::Enabled))
            .collect::<HashMap<_, _>>();
        let tmp = self.root.join("state.json.tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(&state)?)?;
        fs::rename(tmp, self.state_path())?;
        Ok(())
    }
}

fn valid_slug(value: &str) -> bool {
    !value.is_empty()
        && value.split('-').all(|part| {
            !part.is_empty()
                && part
                    .chars()
                    .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit())
        })
}

fn validate_relative_path(value: &str) -> Result<(), PluginError> {
    let path = Path::new(value);
    if path.is_absolute()
        || value.trim().is_empty()
        || path.components().any(|part| {
            matches!(
                part,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(PluginError::InvalidManifest(format!(
            "unsafe relative path: {value}"
        )));
    }
    Ok(())
}

fn placeholder_manifest(slug: &str) -> ModuleManifest {
    ModuleManifest {
        id: format!("taomni-plugin-{slug}"),
        slug: slug.to_owned(),
        name: slug.to_owned(),
        version: "0.0.0".into(),
        core_api_version: CORE_API_VERSION.into(),
        kind: PluginKind::Media,
        status: PluginStatus::Provisional,
        removal_candidate: false,
        platforms: BTreeSet::new(),
        entry: PluginEntry {
            host: None,
            frontend: None,
            protocol: 0,
        },
        tabs: Vec::new(),
        commands: BTreeSet::new(),
        permissions: BTreeSet::new(),
        data_dir: format!("plugins/{slug}"),
        backup_paths: Vec::new(),
        legacy_tables: Vec::new(),
        vault_fixed_keys: Vec::new(),
        snapshot: SnapshotMode::File,
    }
}

pub mod migration;
pub mod protocol;

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn manifest(slug: &str) -> ModuleManifest {
        ModuleManifest {
            id: format!("taomni-plugin-{slug}"),
            slug: slug.into(),
            name: slug.into(),
            version: "1.0.0".into(),
            core_api_version: CORE_API_VERSION.into(),
            kind: PluginKind::Auth,
            status: PluginStatus::Stable,
            removal_candidate: false,
            platforms: ["linux-x86_64".into()].into_iter().collect(),
            entry: PluginEntry {
                host: Some("bin/host".into()),
                frontend: Some("frontend/index.js".into()),
                protocol: 1,
            },
            tabs: vec![PluginTab {
                kind: slug.into(),
                title: slug.into(),
            }],
            commands: ["ping".into()].into(),
            permissions: ["session.read".into()].into(),
            data_dir: format!("plugins/{slug}"),
            backup_paths: vec![format!("plugins/{slug}/data.db")],
            legacy_tables: vec![],
            vault_fixed_keys: vec![],
            snapshot: SnapshotMode::Rpc,
        }
    }

    #[test]
    fn scans_valid_and_retains_invalid_manifests_as_disabled_records() {
        let dir = tempdir().unwrap();
        let valid = dir.path().join("mfa");
        fs::create_dir(&valid).unwrap();
        fs::write(
            valid.join("module.json"),
            serde_json::to_vec(&manifest("mfa")).unwrap(),
        )
        .unwrap();
        let invalid = dir.path().join("invalid");
        fs::create_dir(&invalid).unwrap();
        fs::write(invalid.join("module.json"), b"{}").unwrap();
        let registry = PluginRegistry::new(dir.path());
        registry.scan().unwrap();
        assert_eq!(
            registry.get("mfa").unwrap().state,
            LifecycleState::Installed
        );
        assert!(registry.get("mfa").unwrap().reason.is_none());
        let invalid_record = registry.get("invalid").unwrap();
        assert_eq!(invalid_record.state, LifecycleState::Disabled);
        assert!(invalid_record.reason.is_some());
    }

    #[test]
    fn enable_state_is_persisted_and_command_is_allowlisted() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("plugins");
        fs::create_dir(&path).unwrap();
        let p = path.join("mfa");
        fs::create_dir(&p).unwrap();
        fs::write(
            p.join("module.json"),
            serde_json::to_vec(&manifest("mfa")).unwrap(),
        )
        .unwrap();
        let registry = PluginRegistry::new(&path);
        registry.scan().unwrap();
        registry.set_enabled("mfa", true).unwrap();
        assert_eq!(
            registry
                .invoke("mfa", "unknown", Value::Null)
                .unwrap_err()
                .to_string(),
            "plugin command unknown is not declared by mfa"
        );
        let reloaded = PluginRegistry::new(&path);
        reloaded.scan().unwrap();
        assert_eq!(reloaded.get("mfa").unwrap().state, LifecycleState::Enabled);
    }

    #[test]
    fn rejects_path_traversal() {
        assert!(validate_relative_path("../data").is_err());
        assert!(validate_relative_path("/tmp/data").is_err());
        assert!(validate_relative_path("data/file.db").is_ok());
    }
}
