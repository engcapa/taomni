//! Idempotent migration primitives for upgrading a 0.5.x monolith.
//!
//! Detection is read-only. A caller can show the result before downloading
//! anything, then execute each item through the journal. The journal is written
//! atomically, so an interrupted upgrade resumes at the last completed item.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// The fixed Vault entries that the migration preflight can observe without
/// unlocking or decrypting the Vault.  The value is deliberately a boolean:
/// the migration layer must never copy plaintext credentials or key material.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LegacyVaultEvidence {
    pub path: PathBuf,
    pub fixed_key_present: bool,
}

/// Read-only snapshot of a legacy 0.5.x installation.  This is the input for
/// the upgrade wizard; collecting it never creates plugin directories, writes
/// a journal, or removes the old installation.  `source_fingerprints` is
/// keyed by relative path and is retained in the journal/audit record so a
/// changed source cannot be silently copied on a retry.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LegacyInstallSnapshot {
    pub from_version: String,
    pub database_path: Option<PathBuf>,
    pub database_tables: Vec<String>,
    pub candidates: Vec<MigrationCandidate>,
    pub source_fingerprints: BTreeMap<String, String>,
    pub retained_paths: Vec<PathBuf>,
    pub vault: Option<LegacyVaultEvidence>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum MigrationItem {
    RdpVncSessions,
    RdpCertificatePins,
    ServerConfigs,
    Mfa,
    SocksCap,
    Mobile,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MigrationCandidate {
    pub item: MigrationItem,
    pub evidence: Vec<String>,
    pub plugin_slug: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum MigrationStepState {
    #[default]
    Pending,
    Staged,
    Committed,
    RolledBack,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum MigrationRunState {
    #[default]
    Pending,
    Staged,
    Complete,
    Failed,
    RolledBack,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MigrationJournalEntry {
    pub item: MigrationItem,
    pub state: MigrationStepState,
    pub source_fingerprint: String,
    /// Relative path in the legacy profile that produced this entry. Older
    /// journals did not record it, so deserialisation remains backwards
    /// compatible with an empty path.
    #[serde(default)]
    pub source_path: PathBuf,
    pub target: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MigrationJournal {
    pub from_version: String,
    pub to_core_api_version: String,
    #[serde(default)]
    pub status: MigrationRunState,
    pub entries: Vec<MigrationJournalEntry>,
}

impl MigrationJournal {
    pub fn load(path: &Path) -> Result<Self, String> {
        if !path.exists() {
            return Ok(Self::default());
        }
        let raw = fs::read_to_string(path).map_err(|error| error.to_string())?;
        serde_json::from_str(&raw).map_err(|error| error.to_string())
    }

    pub fn save_atomic(&self, path: &Path) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let tmp = path.with_extension("tmp");
        fs::write(
            &tmp,
            serde_json::to_vec_pretty(self).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        fs::rename(tmp, path).map_err(|error| error.to_string())
    }

    pub fn mark(
        &mut self,
        item: MigrationItem,
        state: MigrationStepState,
        source_fingerprint: String,
        target: PathBuf,
    ) {
        self.mark_with_source(item, state, source_fingerprint, PathBuf::new(), target);
    }

    pub fn mark_with_source(
        &mut self,
        item: MigrationItem,
        state: MigrationStepState,
        source_fingerprint: String,
        source_path: PathBuf,
        target: PathBuf,
    ) {
        if let Some(entry) = self.entries.iter_mut().find(|entry| entry.item == item) {
            entry.state = state;
            entry.source_fingerprint = source_fingerprint;
            entry.source_path = source_path;
            entry.target = target;
        } else {
            self.entries.push(MigrationJournalEntry {
                item,
                state,
                source_fingerprint,
                source_path,
                target,
            });
        }
    }

    pub fn committed(&self, item: MigrationItem) -> bool {
        self.entries
            .iter()
            .any(|entry| entry.item == item && entry.state == MigrationStepState::Committed)
    }
}

/// One filesystem migration operation. Database legacy tables are represented
/// by a read-only export written to `source`; the plugin host never opens the
/// monolith database directly. `target` is relative to the plugin version
/// directory and is validated before any write occurs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationSpec {
    pub item: MigrationItem,
    pub plugin_slug: String,
    pub source: PathBuf,
    pub target: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MigrationExecutionResult {
    pub status: MigrationRunState,
    pub committed: Vec<MigrationItem>,
    pub skipped: Vec<MigrationItem>,
    /// Items that were detected but intentionally left untouched until a
    /// verified package and its database/Vault exporter are available.
    #[serde(default)]
    pub pending: Vec<MigrationItem>,
    /// Human-readable explanation for pending entries. This is optional so
    /// older result consumers remain wire-compatible.
    #[serde(default)]
    pub pending_reason: Option<String>,
}

/// Filesystem executor for the 0.5.x → modular upgrade journal.
///
/// The executor copies into an immutable version staging directory and only
/// switches the plugin active pointer after every file for that plugin has
/// been staged. Re-running with the same source fingerprints is idempotent;
/// no source is removed, including legacy LanChat files.
#[derive(Debug, Clone)]
pub struct MigrationExecutor {
    source_root: PathBuf,
    plugin_root: PathBuf,
    journal_path: PathBuf,
    version: String,
    from_version: String,
    core_api_version: String,
}

impl MigrationExecutor {
    pub fn new(
        source_root: impl Into<PathBuf>,
        plugin_root: impl Into<PathBuf>,
        journal_path: impl Into<PathBuf>,
        from_version: impl Into<String>,
        core_api_version: impl Into<String>,
    ) -> Result<Self, String> {
        let core_api_version = core_api_version.into();
        if core_api_version.trim().is_empty() {
            return Err("core API version is required".into());
        }
        if core_api_version.chars().any(|character| {
            !(character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '+'))
        }) {
            return Err("core API version contains unsafe path characters".into());
        }
        let version = format!("0.0.0-migration-{}", core_api_version);
        Ok(Self {
            source_root: source_root.into(),
            plugin_root: plugin_root.into(),
            journal_path: journal_path.into(),
            version,
            from_version: from_version.into(),
            core_api_version,
        })
    }

    pub fn journal_path(&self) -> &Path {
        &self.journal_path
    }

    /// Record a legacy upgrade preflight without pretending that migration is
    /// complete. The production upgrade command uses this until a trusted
    /// package and a core-owned legacy-table exporter are available. It only
    /// writes the atomic journal; it does not create plugin directories,
    /// copy source files, or change any active pointer.
    pub fn record_pending(
        &self,
        snapshot: &LegacyInstallSnapshot,
    ) -> Result<MigrationExecutionResult, String> {
        let mut journal = MigrationJournal::load(&self.journal_path)?;
        if journal.from_version.is_empty() {
            journal.from_version = self.from_version.clone();
            journal.to_core_api_version = self.core_api_version.clone();
        }
        if journal.from_version != self.from_version
            || journal.to_core_api_version != self.core_api_version
        {
            return Err("migration journal version does not match this executor".into());
        }

        for candidate in &snapshot.candidates {
            let source_path = pending_source_path(snapshot, candidate)?;
            let source_key = source_path.to_string_lossy().into_owned();
            let fingerprint = snapshot
                .source_fingerprints
                .get(&source_key)
                .cloned()
                .ok_or_else(|| {
                    format!("missing source fingerprint for {}", source_path.display())
                })?;
            journal.mark_with_source(
                candidate.item,
                MigrationStepState::Pending,
                fingerprint,
                source_path,
                PathBuf::new(),
            );
        }
        journal.status = if snapshot.candidates.is_empty() {
            MigrationRunState::Complete
        } else {
            MigrationRunState::Pending
        };
        journal.save_atomic(&self.journal_path)?;
        Ok(MigrationExecutionResult {
            status: journal.status,
            committed: Vec::new(),
            skipped: Vec::new(),
            pending: snapshot
                .candidates
                .iter()
                .map(|candidate| candidate.item)
                .collect(),
            pending_reason: (!snapshot.candidates.is_empty()).then(|| {
                "A verified plugin package and the core-owned legacy data exporter are required before migration can copy data.".to_string()
            }),
        })
    }

    /// Read source metadata and hashes without changing the filesystem.
    pub fn preflight(&self, specs: &[MigrationSpec]) -> Result<Vec<String>, String> {
        let mut fingerprints = Vec::with_capacity(specs.len());
        for spec in specs {
            validate_slug(&spec.plugin_slug)?;
            validate_relative_path(&spec.source)?;
            validate_relative_path(&spec.target)?;
            let source = self.source_root.join(&spec.source);
            ensure_within(&self.source_root, &source)?;
            fingerprints.push(source_fingerprint(&source)?);
        }
        Ok(fingerprints)
    }

    pub fn execute(&self, specs: &[MigrationSpec]) -> Result<MigrationExecutionResult, String> {
        let fingerprints = self.preflight(specs)?;
        let mut journal = MigrationJournal::load(&self.journal_path)?;
        if journal.from_version.is_empty() {
            journal.from_version = self.from_version.clone();
            journal.to_core_api_version = self.core_api_version.clone();
        }
        if journal.from_version != self.from_version
            || journal.to_core_api_version != self.core_api_version
        {
            return Err("migration journal version does not match this executor".into());
        }
        journal.status = MigrationRunState::Staged;
        journal.save_atomic(&self.journal_path)?;

        let mut committed = Vec::new();
        let mut skipped = Vec::new();
        let mut staged_slugs = BTreeSet::new();
        for (spec, fingerprint) in specs.iter().zip(fingerprints.iter()) {
            let target = match self.target_path(spec) {
                Ok(target) => target,
                Err(error) => {
                    journal.status = MigrationRunState::RolledBack;
                    let _ = journal.save_atomic(&self.journal_path);
                    return Err(error);
                }
            };
            if let Some(entry) = journal.entries.iter().find(|entry| entry.item == spec.item) {
                if entry.source_fingerprint == *fingerprint
                    && entry.state == MigrationStepState::Committed
                    && target.exists()
                {
                    skipped.push(spec.item);
                    continue;
                }
            }
            let staging = match self.staging_path(spec) {
                Ok(staging) => staging,
                Err(error) => {
                    journal.status = MigrationRunState::RolledBack;
                    let _ = journal.save_atomic(&self.journal_path);
                    return Err(error);
                }
            };
            if let Err(error) = remove_path_if_exists(&staging) {
                journal.status = MigrationRunState::RolledBack;
                let _ = journal.save_atomic(&self.journal_path);
                return Err(error);
            }
            if let Err(error) = copy_source(&self.source_root.join(&spec.source), &staging) {
                let _ = remove_path_if_exists(&staging);
                journal.status = MigrationRunState::RolledBack;
                let _ = journal.save_atomic(&self.journal_path);
                return Err(error);
            }
            journal.mark(
                spec.item,
                MigrationStepState::Staged,
                fingerprint.clone(),
                target.clone(),
            );
            journal.save_atomic(&self.journal_path)?;
            staged_slugs.insert(spec.plugin_slug.clone());
        }

        let mut previous_pointers = BTreeMap::new();
        for slug in &staged_slugs {
            match self.read_pointer_bytes(slug) {
                Ok(bytes) => {
                    previous_pointers.insert(slug.clone(), bytes);
                }
                Err(error) => {
                    journal.status = MigrationRunState::RolledBack;
                    let _ = journal.save_atomic(&self.journal_path);
                    return Err(error);
                }
            }
        }
        for slug in staged_slugs {
            if let Err(error) = self.activate_slug(&slug) {
                for (previous_slug, bytes) in &previous_pointers {
                    let _ = self.restore_pointer_bytes(previous_slug, bytes.as_deref());
                }
                journal.status = MigrationRunState::RolledBack;
                let _ = journal.save_atomic(&self.journal_path);
                return Err(error);
            }
        }
        for spec in specs {
            if let Some(entry) = journal
                .entries
                .iter_mut()
                .find(|entry| entry.item == spec.item)
            {
                if entry.state == MigrationStepState::Staged {
                    entry.state = MigrationStepState::Committed;
                    committed.push(spec.item);
                }
            }
        }
        journal.status = MigrationRunState::Complete;
        journal.save_atomic(&self.journal_path)?;
        Ok(MigrationExecutionResult {
            status: journal.status,
            committed,
            skipped,
            pending: Vec::new(),
            pending_reason: None,
        })
    }

    fn staging_path(&self, spec: &MigrationSpec) -> Result<PathBuf, String> {
        let plugin_dir = self.plugin_root.join(&spec.plugin_slug);
        reject_symlink(&plugin_dir)?;
        let versions = plugin_dir.join("versions");
        reject_symlink(&versions)?;
        fs::create_dir_all(&versions).map_err(|error| error.to_string())?;
        let path = self
            .plugin_root
            .join(&spec.plugin_slug)
            .join("versions")
            .join(format!(".{}.staging", self.version))
            .join(&spec.target);
        ensure_within(&versions, &path)?;
        Ok(path)
    }

    fn target_path(&self, spec: &MigrationSpec) -> Result<PathBuf, String> {
        let plugin_dir = self.plugin_root.join(&spec.plugin_slug);
        reject_symlink(&plugin_dir)?;
        let versions = plugin_dir.join("versions");
        reject_symlink(&versions)?;
        fs::create_dir_all(&versions).map_err(|error| error.to_string())?;
        let path = self
            .plugin_root
            .join(&spec.plugin_slug)
            .join("versions")
            .join(&self.version)
            .join(&spec.target);
        ensure_within(&versions, &path)?;
        Ok(path)
    }

    fn activate_slug(&self, slug: &str) -> Result<(), String> {
        let versions = self.plugin_root.join(slug).join("versions");
        let staging = versions.join(format!(".{}.staging", self.version));
        let destination = versions.join(&self.version);
        if !destination.exists() {
            fs::create_dir_all(&versions).map_err(|error| error.to_string())?;
            fs::rename(&staging, &destination).map_err(|error| error.to_string())?;
        }
        let pointer_dir = self.plugin_root.join(slug);
        fs::create_dir_all(&pointer_dir).map_err(|error| error.to_string())?;
        let pointer = pointer_dir.join("active.json");
        let temporary = pointer_dir.join(".active.migration.tmp");
        let previous_version = if pointer.exists() {
            serde_json::from_slice::<serde_json::Value>(
                &fs::read(&pointer).map_err(|error| error.to_string())?,
            )
            .ok()
            .and_then(|value| {
                value
                    .get("activeVersion")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
            })
        } else {
            None
        };
        let payload = serde_json::json!({
            "activeVersion": self.version,
            "previousVersion": previous_version,
        });
        fs::write(
            &temporary,
            serde_json::to_vec_pretty(&payload).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        if cfg!(windows) && pointer.exists() {
            fs::remove_file(&pointer).map_err(|error| error.to_string())?;
        }
        fs::rename(temporary, pointer).map_err(|error| error.to_string())
    }

    fn read_pointer_bytes(&self, slug: &str) -> Result<Option<Vec<u8>>, String> {
        let pointer = self.plugin_root.join(slug).join("active.json");
        if pointer.exists() {
            fs::read(pointer)
                .map(Some)
                .map_err(|error| error.to_string())
        } else {
            Ok(None)
        }
    }

    fn restore_pointer_bytes(&self, slug: &str, bytes: Option<&[u8]>) -> Result<(), String> {
        let pointer_dir = self.plugin_root.join(slug);
        let pointer = pointer_dir.join("active.json");
        match bytes {
            Some(bytes) => {
                fs::create_dir_all(&pointer_dir).map_err(|error| error.to_string())?;
                let temporary = pointer_dir.join(".active.migration.rollback.tmp");
                fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
                if cfg!(windows) && pointer.exists() {
                    fs::remove_file(&pointer).map_err(|error| error.to_string())?;
                }
                fs::rename(temporary, pointer).map_err(|error| error.to_string())
            }
            None => {
                if pointer.exists() {
                    fs::remove_file(pointer).map_err(|error| error.to_string())?;
                }
                Ok(())
            }
        }
    }
}

fn pending_source_path(
    snapshot: &LegacyInstallSnapshot,
    candidate: &MigrationCandidate,
) -> Result<PathBuf, String> {
    if let Some(path) = candidate
        .evidence
        .iter()
        .find(|path| snapshot.source_fingerprints.contains_key(path.as_str()))
    {
        return Ok(PathBuf::from(path));
    }
    if matches!(
        candidate.item,
        MigrationItem::RdpVncSessions
            | MigrationItem::RdpCertificatePins
            | MigrationItem::ServerConfigs
    ) && snapshot.source_fingerprints.contains_key("taomni.db")
    {
        return Ok(PathBuf::from("taomni.db"));
    }
    Err(format!(
        "migration candidate has no fingerprinted source: {:?}",
        candidate.item
    ))
}

fn validate_slug(slug: &str) -> Result<(), String> {
    if slug.is_empty()
        || slug.starts_with('-')
        || slug.ends_with('-')
        || slug.split('-').any(|part| {
            part.is_empty()
                || !part
                    .chars()
                    .all(|character| character.is_ascii_lowercase() || character.is_ascii_digit())
        })
    {
        return Err(format!("invalid plugin slug: {slug}"));
    }
    Ok(())
}

fn validate_relative_path(path: &Path) -> Result<(), String> {
    if path.as_os_str().is_empty() || path.is_absolute() {
        return Err(format!(
            "migration path must be relative: {}",
            path.display()
        ));
    }
    for component in path.components() {
        if !matches!(component, Component::Normal(_)) {
            return Err(format!(
                "migration path contains unsafe component: {}",
                path.display()
            ));
        }
    }
    Ok(())
}

fn ensure_within(root: &Path, candidate: &Path) -> Result<(), String> {
    let root = root.canonicalize().map_err(|error| error.to_string())?;
    let mut existing = candidate;
    while !existing.exists() {
        existing = existing.parent().ok_or_else(|| {
            format!(
                "migration path has no existing ancestor: {}",
                candidate.display()
            )
        })?;
    }
    let existing = existing.canonicalize().map_err(|error| error.to_string())?;
    if !existing.starts_with(&root) {
        return Err(format!(
            "migration path escapes root: {}",
            candidate.display()
        ));
    }
    Ok(())
}

fn remove_path_if_exists(path: &Path) -> Result<(), String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    if metadata.is_dir() {
        fs::remove_dir_all(path).map_err(|error| error.to_string())
    } else {
        fs::remove_file(path).map_err(|error| error.to_string())
    }
}

fn reject_symlink(path: &Path) -> Result<(), String> {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "migration path cannot be a symlink: {}",
                path.display()
            ));
        }
    }
    Ok(())
}

fn source_fingerprint(path: &Path) -> Result<String, String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "migration source cannot be a symlink: {}",
            path.display()
        ));
    }
    let mut digest = Sha256::new();
    let mut size = 0_u64;
    hash_tree(path, &mut digest, &mut size)?;
    Ok(format!(
        "sha256:{}:bytes:{}",
        hex::encode(digest.finalize()),
        size
    ))
}

fn hash_tree(path: &Path, digest: &mut Sha256, size: &mut u64) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "migration source cannot be a symlink: {}",
            path.display()
        ));
    }
    if metadata.is_file() {
        let mut file = fs::File::open(path).map_err(|error| error.to_string())?;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let count = file.read(&mut buffer).map_err(|error| error.to_string())?;
            if count == 0 {
                break;
            }
            digest.update(&buffer[..count]);
            *size += count as u64;
        }
        return Ok(());
    }
    if metadata.is_dir() {
        let mut entries = fs::read_dir(path)
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            digest.update(entry.file_name().to_string_lossy().as_bytes());
            hash_tree(&entry.path(), digest, size)?;
        }
        return Ok(());
    }
    Err(format!("unsupported migration source: {}", path.display()))
}

fn copy_source(source: &Path, destination: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(source).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "migration source cannot be a symlink: {}",
            source.display()
        ));
    }
    if metadata.is_file() {
        let parent = destination
            .parent()
            .ok_or_else(|| "migration destination has no parent".to_string())?;
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        fs::copy(source, destination).map_err(|error| error.to_string())?;
        return Ok(());
    }
    if metadata.is_dir() {
        fs::create_dir_all(destination).map_err(|error| error.to_string())?;
        for entry in fs::read_dir(source).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            copy_source(&entry.path(), &destination.join(entry.file_name()))?;
        }
        return Ok(());
    }
    Err(format!(
        "unsupported migration source: {}",
        source.display()
    ))
}

#[path = "migration_preflight.rs"]
mod preflight;
pub use preflight::{build_file_migration_specs, detect_legacy_install, inspect_legacy_install};

#[cfg(test)]
#[path = "migration_tests.rs"]
mod tests;
