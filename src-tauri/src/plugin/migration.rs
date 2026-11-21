//! Idempotent migration primitives for upgrading a 0.5.x monolith.
//!
//! Production detection is read-only and records pending work atomically.
//! Unsigned copy/activation operations exist only in the test fixture; actual
//! migration waits for verified packages and a core-owned legacy data exporter.

#[path = "migration_export/mod.rs"]
pub mod export;

use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub(crate) const MFA_MIGRATION_TARGET: &str = "plugins/mfa/data/mfa.db";
pub(crate) const MAIL_MIGRATION_TARGET: &str = "plugins/mail/data";
const VNC_RETAINED_DATABASE: &str = "taomni.db";
pub(crate) const LEGACY_SOURCE_VERSION: &str = "0.5.x";

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
/// SQLite entries also bind the corresponding nonempty WAL; transient SHM
/// bookkeeping is excluded. No checkpoint is performed by the preflight.
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
    MailAccounts,
    RdpCertificatePins,
    ServerConfigs,
    RdpServerConfigs,
    VncServerConfigs,
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
        if !paths::file_exists(path)? {
            return Ok(Self::default());
        }
        paths::read_json_bounded(path)
    }

    pub fn save_atomic(&self, path: &Path) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        paths::write_json_durable(path, self)
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

    pub(crate) fn retained_vnc_sessions(&self) -> bool {
        let mut entries = self
            .entries
            .iter()
            .filter(|entry| entry.item == MigrationItem::VncSessions);
        entries.next().is_some_and(|entry| {
            entry.state == MigrationStepState::Committed && valid_vnc_retention(entry)
        }) && entries.next().is_none()
    }

    pub(crate) fn committed_mfa(&self) -> Result<bool, String> {
        let mut entries = self
            .entries
            .iter()
            .filter(|entry| entry.item == MigrationItem::Mfa);
        let Some(entry) = entries.next() else {
            return Ok(false);
        };
        if entries.next().is_some() {
            return Err("MFA migration journal contains duplicate rows".into());
        }
        match entry.state {
            MigrationStepState::Pending if entry.target.as_os_str().is_empty() => Ok(false),
            MigrationStepState::Committed if valid_mfa_commit(entry) => Ok(true),
            _ => Err("MFA migration journal requires recovery".into()),
        }
    }

    pub(crate) fn profile_mfa_committed(profile: &Path) -> Result<bool, String> {
        let directory = profile.join("migration");
        match fs::symlink_metadata(&directory) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error.to_string()),
            Ok(_) => paths::directory(&directory)?,
        }
        Self::load(&directory.join("journal.json"))?.committed_mfa()
    }

    pub(crate) fn committed_rdp_pins(&self) -> Result<bool, String> {
        let mut matches = self
            .entries
            .iter()
            .filter(|entry| entry.item == MigrationItem::RdpCertificatePins);
        match (matches.next(), matches.next()) {
            (None, None) => Ok(false),
            (Some(entry), None)
                if entry.state == MigrationStepState::Pending
                    && entry.target.as_os_str().is_empty() =>
            {
                Ok(false)
            }
            (Some(entry), None)
                if entry.state == MigrationStepState::Committed && valid_rdp_pin_commit(entry) =>
            {
                Ok(true)
            }
            _ => Err("RDP certificate migration journal requires recovery".into()),
        }
    }
}

fn valid_mfa_commit(entry: &MigrationJournalEntry) -> bool {
    entry.item == MigrationItem::Mfa
        && entry.source_path == Path::new("mfa.db")
        && source::valid_fingerprint(&entry.source_fingerprint)
        && entry.target == Path::new(MFA_MIGRATION_TARGET)
}

pub(super) fn valid_mail_commit(entry: &MigrationJournalEntry) -> bool {
    entry.item == MigrationItem::MailAccounts
        && entry.source_path == Path::new("taomni.db")
        && source::valid_fingerprint(&entry.source_fingerprint)
        && entry.target == Path::new(MAIL_MIGRATION_TARGET)
}

fn valid_vnc_retention(entry: &MigrationJournalEntry) -> bool {
    entry.item == MigrationItem::VncSessions
        && entry.source_path == Path::new(VNC_RETAINED_DATABASE)
        && entry.target == entry.source_path
        && source::valid_fingerprint(&entry.source_fingerprint)
}

fn valid_rdp_pin_commit(entry: &MigrationJournalEntry) -> bool {
    entry.item == MigrationItem::RdpCertificatePins
        && entry.source_path == Path::new("taomni.db")
        && entry.target == Path::new(taomni_rdp_client_api::PINS_DATABASE)
        && source::valid_fingerprint(&entry.source_fingerprint)
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
        self.record_session_retention(snapshot, false)
    }

    pub(crate) fn record_session_retention(
        &self,
        snapshot: &LegacyInstallSnapshot,
        retain_vnc: bool,
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

        let result = reconcile_pending(&mut journal, snapshot, retain_vnc)?;
        journal.save_atomic(&self.journal_path)?;
        Ok(result)
    }
}

fn reconcile_pending(
    journal: &mut MigrationJournal,
    snapshot: &LegacyInstallSnapshot,
    retain_vnc: bool,
) -> Result<MigrationExecutionResult, String> {
    let mut committed = Vec::new();
    for entry in &journal.entries {
        match entry.state {
            MigrationStepState::Pending if entry.target.as_os_str().is_empty() => (),
            MigrationStepState::Committed
                if (valid_mfa_commit(entry)
                    || valid_mail_commit(entry)
                    || valid_vnc_retention(entry)
                    || valid_rdp_pin_commit(entry))
                    && !committed.contains(&entry.item) =>
            {
                committed.push(entry.item);
            }
            _ => {
                return Err(
                    "migration journal contains performed work; explicit recovery is required"
                        .into(),
                );
            }
        }
    }
    // Preserve the source identity of finished work even if a later scan
    // sees a different legacy source. Only pending placeholders are rebuilt.
    let mut entries = journal
        .entries
        .iter()
        .filter(|entry| entry.state == MigrationStepState::Committed)
        .cloned()
        .collect::<Vec<_>>();
    let mut pending = Vec::new();
    for candidate in &snapshot.candidates {
        if committed.contains(&candidate.item) {
            continue;
        }
        let source_path = pending_source_path(snapshot, candidate)?;
        let fingerprint = snapshot
            .source_fingerprints
            .get(source_path.to_string_lossy().as_ref())
            .cloned()
            .ok_or_else(|| format!("missing source fingerprint for {}", source_path.display()))?;
        let mut entry = MigrationJournalEntry {
            item: candidate.item,
            state: MigrationStepState::Pending,
            source_fingerprint: fingerprint,
            source_path,
            target: PathBuf::new(),
        };
        if retain_vnc && candidate.item == MigrationItem::VncSessions {
            entry.target = entry.source_path.clone();
            if !valid_vnc_retention(&entry) {
                return Err(
                    "legacy VNC session source does not match the core-owned database".into(),
                );
            }
            entry.state = MigrationStepState::Committed;
            committed.push(candidate.item);
        } else {
            pending.push(candidate.item);
        }
        entries.push(entry);
    }
    journal.entries = entries;
    journal.status = if pending.is_empty() {
        MigrationRunState::Complete
    } else {
        MigrationRunState::Pending
    };
    Ok(MigrationExecutionResult {
        status: journal.status,
        committed,
        skipped: Vec::new(),
        pending_reason: (!pending.is_empty()).then(|| {
            "A verified plugin package and the core-owned legacy data exporter are required before migration can copy data.".to_string()
        }),
        pending,
    })
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
            | MigrationItem::MailAccounts
            | MigrationItem::RdpCertificatePins
            | MigrationItem::ServerConfigs
            | MigrationItem::RdpServerConfigs
            | MigrationItem::VncServerConfigs
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

#[path = "migration_source.rs"]
pub(super) mod source;

#[path = "migration_paths.rs"]
pub(super) mod paths;

#[cfg(test)]
#[path = "migration_wal_tests.rs"]
mod wal_tests;

#[cfg(test)]
#[path = "migration_server_tests.rs"]
mod server_tests;

#[cfg(test)]
#[path = "migration_fixture.rs"]
mod fixture;

#[cfg(test)]
#[path = "migration_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "migration_reconcile_tests.rs"]
mod reconcile_tests;
