//! Idempotent migration primitives for upgrading a 0.5.x monolith.
//!
//! Production detection is read-only and records pending work atomically.
//! Unsigned copy/activation operations exist only in the test fixture; actual
//! migration waits for verified packages and a core-owned legacy data exporter.

use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

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
    // Keep the existing journal spelling for RDP; VNC now has its own owner.
    RdpVncSessions,
    VncSessions,
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

/// Pending journal recorder for the 0.5.x → modular upgrade.
///
/// Production only records preflight evidence. Copy/activation contracts are
/// exercised by a test-only fixture until signed packages and the core-owned
/// legacy data exporter can perform the complete migration transaction.
#[derive(Debug, Clone)]
pub struct MigrationExecutor {
    #[cfg(test)]
    source_root: PathBuf,
    #[cfg(test)]
    plugin_root: PathBuf,
    journal_path: PathBuf,
    #[cfg(test)]
    version: String,
    from_version: String,
    core_api_version: String,
}

impl MigrationExecutor {
    pub fn new(
        _source_root: impl Into<PathBuf>,
        _plugin_root: impl Into<PathBuf>,
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
        Ok(Self {
            #[cfg(test)]
            source_root: _source_root.into(),
            #[cfg(test)]
            plugin_root: _plugin_root.into(),
            journal_path: journal_path.into(),
            #[cfg(test)]
            version: format!("0.0.0-migration-{}", core_api_version),
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

        // Older schema-only preflights could record empty feature tables or
        // attribute VNC to RDP. Reconcile only unperformed placeholders. A
        // staged/committed transaction needs its actual recovery executor;
        // rescanning must never erase or reset that history.
        if journal.entries.iter().any(|entry| {
            entry.state != MigrationStepState::Pending || !entry.target.as_os_str().is_empty()
        }) {
            return Err(
                "migration journal contains performed work; explicit recovery is required".into(),
            );
        }
        journal.entries.retain(|entry| {
            snapshot
                .candidates
                .iter()
                .any(|candidate| candidate.item == entry.item)
        });

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
            | MigrationItem::VncSessions
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

#[path = "migration_preflight.rs"]
mod preflight;
pub use preflight::{build_file_migration_specs, inspect_legacy_install};

#[cfg(test)]
#[path = "migration_fixture.rs"]
mod fixture;

#[cfg(test)]
#[path = "migration_tests.rs"]
mod tests;
