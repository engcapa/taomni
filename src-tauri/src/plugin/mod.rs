//! Core side of the P1 plugin contract.
//!
//! The registry intentionally owns metadata and lifecycle state only. Plugin
//! implementation state belongs to a supervised host process and is never
//! deserialized into `AppState`.

mod dispatch;
pub mod download;
mod frontend;
pub mod host;
pub mod install;
mod installation;
pub(crate) mod marketplace;
mod mfa_calls;
pub mod migration;
pub(crate) mod migration_commit;
pub(crate) mod migration_execute_mfa;
mod migration_key_check;
pub(crate) mod migration_mail;
pub(crate) mod migration_mail_provision;
pub(crate) mod migration_rdp_pins;
mod migration_rdp_server;
mod migration_rdp_server_identity;
mod migration_server_config;
mod migration_vnc_server;
pub(crate) mod network;
pub mod protocol;
mod quiescence;
pub(crate) mod release_state;
mod runtime;
pub(crate) mod services;
pub use quiescence::QuiescenceGuard;
mod core_access;
pub(crate) mod data_contract;
pub(crate) mod retained_data;
mod signed_catalog;
mod snapshot_barrier;
mod snapshots;
pub(crate) use snapshots::HostSnapshot;
mod stopping;
#[cfg(test)]
pub(crate) mod test_services;
mod uninstallation;
mod vault_lifecycle;
pub mod verify;

pub(crate) use installation::InstallIntent;
pub(crate) use installation::current_platform;
pub(crate) use signed_catalog::{fetch_trusted_catalog, package_from_cached_catalog};

use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize};
use std::sync::{Arc, Mutex, RwLock};

use serde::{Deserialize, Serialize};
#[cfg(test)]
use serde_json::Value;
use thiserror::Error;

pub const CORE_API_VERSION: &str = "1";

pub use taomni_plugin_api::PluginKind;

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
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
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
    #[serde(default = "default_data_schema_version", rename = "dataSchemaVersion")]
    pub data_schema_version: u32,
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

fn default_data_schema_version() -> u32 {
    1
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
    #[serde(default, rename = "dataRetained")]
    pub data_retained: bool,
    #[serde(
        default,
        rename = "previousVersion",
        skip_serializing_if = "Option::is_none"
    )]
    pub previous_version: Option<String>,
    #[serde(skip)]
    rollback_until: Option<u64>,
}

impl PluginRecord {
    fn with_current_rollback(mut self) -> Self {
        if !install::ActivePointer::rollback_time_is_open(self.rollback_until) {
            self.previous_version = None;
        }
        self
    }
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
    #[error("plugin host request failed: {0}")]
    HostRequest(String),
    #[error("plugin RPC failed ({code}): {message}")]
    Rpc { code: i32, message: String },
    #[error("plugin registry I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("plugin registry JSON failed: {0}")]
    Json(#[from] serde_json::Error),
    #[error("plugin trust verification failed: {0}")]
    Trust(#[from] verify::TrustError),
    #[error("plugin installation failed: {0}")]
    Install(#[from] install::InstallError),
}

#[derive(Debug, Clone)]
pub struct PluginRegistry {
    root: PathBuf,
    core_api_version: String,
    records: Arc<RwLock<HashMap<String, PluginRecord>>>,
    hosts: Arc<Mutex<HashMap<String, Arc<runtime::RuntimeHost>>>>,
    lifecycle: Arc<Mutex<()>>,
    monitor_started: Arc<AtomicBool>,
    shutting_down: Arc<AtomicBool>,
    quiescence: Arc<AtomicUsize>,
    pending_requests: Arc<Mutex<HashMap<(String, String), dispatch::PendingRequest>>>,
    frontend_trust: Arc<RwLock<HashMap<PathBuf, Arc<verify::InstalledTrust>>>>,
    services: Option<Arc<services::PluginCoreServices>>,
}

impl PluginRegistry {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            core_api_version: CORE_API_VERSION.to_owned(),
            records: Arc::new(RwLock::new(HashMap::new())),
            hosts: Arc::new(Mutex::new(HashMap::new())),
            lifecycle: Arc::new(Mutex::new(())),
            monitor_started: Arc::new(AtomicBool::new(false)),
            shutting_down: Arc::new(AtomicBool::new(false)),
            quiescence: Arc::new(AtomicUsize::new(0)),
            pending_requests: Arc::new(Mutex::new(HashMap::new())),
            frontend_trust: Arc::new(RwLock::new(HashMap::new())),
            services: None,
        }
    }

    pub(crate) fn with_services(
        root: impl Into<PathBuf>,
        services: Arc<services::PluginCoreServices>,
    ) -> Self {
        Self {
            shutting_down: services.shutting_down.clone(),
            quiescence: services.quiescence.clone(),
            services: Some(services),
            ..Self::new(root)
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn scan(&self) -> Result<(), PluginError> {
        let _lifecycle = self
            .lifecycle
            .lock()
            .expect("plugin lifecycle lock poisoned");
        let _mutation = install::ModuleInstaller::new(&self.root).lock_mutations()?;
        self.scan_locked()
    }

    fn scan_locked(&self) -> Result<(), PluginError> {
        if !self.root.exists() {
            fs::create_dir_all(&self.root)?;
        }
        let mut records = HashMap::new();
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            let path = entry.path();
            if !entry.file_type()?.is_dir() || !valid_slug(&entry.file_name().to_string_lossy()) {
                continue;
            }
            let slug = entry.file_name().to_string_lossy().into_owned();
            let data_retained = fs::symlink_metadata(path.join("data"))
                .is_ok_and(|metadata| metadata.is_dir() && !data_contract::is_link(&metadata));
            let record = match self.read_manifest(&path, &slug) {
                Ok((manifest, state, pointer)) => PluginRecord {
                    manifest,
                    state,
                    reason: None,
                    data_retained,
                    previous_version: pointer
                        .previous_version
                        .filter(|_| pointer.active_version.is_some()),
                    rollback_until: pointer.rollback_until,
                },
                Err(error) => PluginRecord {
                    manifest: placeholder_manifest(&slug),
                    state: LifecycleState::Disabled,
                    reason: Some(error.to_string()),
                    data_retained,
                    previous_version: None,
                    rollback_until: None,
                },
            };
            records.insert(slug, record);
        }
        self.load_enabled_state(&mut records)?;
        let stale = self
            .hosts
            .lock()
            .expect("plugin host lock poisoned")
            .keys()
            .filter(|slug| {
                records.get(*slug).is_none_or(|record| {
                    record.state != LifecycleState::Enabled
                        || self
                            .get(slug)
                            .is_none_or(|previous| previous.manifest != record.manifest)
                })
            })
            .cloned()
            .collect::<Vec<_>>();
        for slug in stale {
            self.stop_host(&slug)?;
        }
        *self.records.write().expect("plugin registry lock poisoned") = records;
        self.frontend_trust
            .write()
            .expect("plugin asset lock poisoned")
            .clear();
        Ok(())
    }

    pub fn list(&self) -> Vec<PluginRecord> {
        let mut values = self
            .records
            .read()
            .expect("plugin registry lock poisoned")
            .values()
            .cloned()
            .map(PluginRecord::with_current_rollback)
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
            .map(PluginRecord::with_current_rollback)
    }

    fn enabled_record(&self, slug: &str) -> Result<PluginRecord, PluginError> {
        let record = self
            .get(slug)
            .filter(|record| record.state != LifecycleState::Uninstalled)
            .ok_or_else(|| PluginError::NotFound(slug.into()))?;
        if record.state != LifecycleState::Enabled {
            return Err(PluginError::Disabled(slug.into()));
        }
        Ok(record)
    }

    pub fn set_enabled(&self, slug: &str, enabled: bool) -> Result<PluginRecord, PluginError> {
        let _lifecycle = self
            .lifecycle
            .lock()
            .expect("plugin lifecycle lock poisoned");
        let _mutation = install::ModuleInstaller::new(&self.root).lock_mutations()?;
        let verified = if enabled {
            Some(verify::verify_installed(
                &self.active_directory(slug)?,
                current_platform(),
            )?)
        } else {
            None
        };
        let mut records = self.records.write().expect("plugin registry lock poisoned");
        let before = records.clone();
        let record = records
            .get_mut(slug)
            .ok_or_else(|| PluginError::NotFound(slug.to_owned()))?;
        if record.reason.is_some() {
            return Err(PluginError::InvalidManifest(
                record.reason.clone().unwrap_or_default(),
            ));
        }
        if record.state == LifecycleState::Uninstalled {
            return Err(PluginError::NotFound(slug.to_owned()));
        }
        if verified
            .as_ref()
            .is_some_and(|manifest| manifest != &record.manifest)
        {
            return Err(PluginError::InvalidManifest(
                "active manifest changed; refresh modules before enabling".into(),
            ));
        }
        if !enabled {
            self.stop_host(slug)?;
        }
        record.state = if enabled {
            LifecycleState::Enabled
        } else {
            LifecycleState::Disabled
        };
        drop(records);
        if let Err(error) = self.persist_enabled_preference(slug, Some(enabled)) {
            *self.records.write().expect("plugin registry lock poisoned") = before;
            return Err(error);
        }
        self.get(slug)
            .ok_or_else(|| PluginError::NotFound(slug.to_owned()))
    }

    fn read_manifest(
        &self,
        plugin_dir: &Path,
        slug: &str,
    ) -> Result<(ModuleManifest, LifecycleState, install::ActivePointer), PluginError> {
        let installer = install::ModuleInstaller::new(&self.root);
        let pointer = installer.active_pointer(slug)?;
        if pointer.was_uninstalled() {
            let manifest = self.uninstalled_manifest(&installer, slug, &pointer);
            return Ok((manifest, LifecycleState::Uninstalled, pointer));
        }
        let (manifest_path, state) = if let Some(active) = &pointer.active_version {
            (
                plugin_dir.join("versions").join(active).join("module.json"),
                LifecycleState::Installed,
            )
        } else if plugin_dir.join("module.json").is_file() {
            (plugin_dir.join("module.json"), LifecycleState::Installed)
        } else {
            let versions = plugin_dir.join("versions");
            let mut candidates = fs::read_dir(&versions)
                .ok()
                .into_iter()
                .flatten()
                .filter_map(Result::ok)
                .filter(|entry| entry.file_type().ok().is_some_and(|kind| kind.is_dir()))
                .map(|entry| entry.path().join("module.json"))
                .filter(|path| path.is_file())
                .collect::<Vec<_>>();
            candidates.sort();
            let Some(path) = candidates.pop() else {
                // Restore can publish data before a signed version is installed.
                let locator = retained_data::load(&self.root, slug)?
                    .ok_or_else(|| PluginError::NotFound(slug.to_owned()))?;
                let mut manifest = placeholder_manifest(slug);
                manifest.data_schema_version = locator.data_schema_version;
                return Ok((manifest, LifecycleState::Uninstalled, pointer));
            };
            (path, LifecycleState::Uninstalled)
        };
        let manifest = verify::verify_installed(
            manifest_path
                .parent()
                .ok_or_else(|| PluginError::InvalidManifest("manifest has no parent".into()))?,
            current_platform(),
        )?;
        if manifest_path.parent().and_then(Path::file_name)
            != Some(std::ffi::OsStr::new(&manifest.version))
        {
            return Err(PluginError::InvalidManifest(
                "version directory does not match signed manifest".into(),
            ));
        }
        self.validate_manifest(&manifest, plugin_dir)?;
        Ok((manifest, state, pointer))
    }

    fn validate_manifest(&self, manifest: &ModuleManifest, dir: &Path) -> Result<(), PluginError> {
        self.validate_manifest_fields(manifest)?;
        if dir
            .file_name()
            .is_none_or(|name| name != std::ffi::OsStr::new(&manifest.slug))
        {
            return Err(PluginError::InvalidManifest(
                "directory does not match slug".into(),
            ));
        }
        Ok(())
    }

    fn validate_manifest_fields(&self, manifest: &ModuleManifest) -> Result<(), PluginError> {
        services::manifest_grants(manifest)?;
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
        validate_relative_path(&manifest.data_dir)?;
        if manifest.data_dir != format!("plugins/{}", manifest.slug) {
            return Err(PluginError::InvalidManifest(
                "dataDir must be plugins/<slug>".into(),
            ));
        }
        data_contract::validate_manifest(manifest)?;
        if let Some(host) = manifest.entry.host.as_deref() {
            validate_relative_path(host)?;
        }
        if manifest.entry.protocol != taomni_plugin_api::RPC_PROTOCOL_VERSION as u16 {
            return Err(PluginError::InvalidManifest(
                "entry protocol is incompatible".into(),
            ));
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
        let enabled = self.read_enabled_state()?;
        for (slug, is_enabled) in enabled {
            if let Some(record) = records.get_mut(&slug) {
                if record.reason.is_none() && record.state != LifecycleState::Uninstalled {
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

    fn read_enabled_state(&self) -> Result<HashMap<String, bool>, PluginError> {
        match fs::read(self.state_path()) {
            Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(HashMap::new()),
            Err(error) => Err(error.into()),
        }
    }

    fn persist_enabled_preference(
        &self,
        slug: &str,
        enabled: Option<bool>,
    ) -> Result<(), PluginError> {
        let mut state = self.read_enabled_state()?;
        match enabled {
            Some(enabled) => {
                state.insert(slug.to_owned(), enabled);
            }
            None => {
                state.remove(slug);
            }
        }
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

fn read_manifest_file(path: &Path) -> Result<ModuleManifest, PluginError> {
    let raw = fs::read_to_string(path).map_err(PluginError::from)?;
    serde_json::from_str::<ModuleManifest>(&raw).map_err(PluginError::from)
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
        description: String::new(),
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
        data_schema_version: 1,
        backup_paths: Vec::new(),
        legacy_tables: Vec::new(),
        vault_fixed_keys: Vec::new(),
        snapshot: SnapshotMode::File,
    }
}

#[cfg(test)]
#[path = "registry_tests.rs"]
mod tests;

#[cfg(all(test, feature = "qa-release-trust-gates"))]
mod signed_mfa_host_tests;
