//! Idempotent migration primitives for upgrading a 0.5.x monolith.
//!
//! Detection is read-only. A caller can show the result before downloading
//! anything, then execute each item through the journal. The journal is written
//! atomically, so an interrupted upgrade resumes at the last completed item.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MigrationJournalEntry {
    pub item: MigrationItem,
    pub state: MigrationStepState,
    pub source_fingerprint: String,
    pub target: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MigrationJournal {
    pub from_version: String,
    pub to_core_api_version: String,
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
        if let Some(entry) = self.entries.iter_mut().find(|entry| entry.item == item) {
            entry.state = state;
            entry.source_fingerprint = source_fingerprint;
            entry.target = target;
        } else {
            self.entries.push(MigrationJournalEntry {
                item,
                state,
                source_fingerprint,
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

pub fn detect_legacy_install(data_dir: &Path, db_tables: &[&str]) -> Vec<MigrationCandidate> {
    let mut candidates = Vec::new();
    let table = |name: &str| db_tables.iter().any(|value| *value == name);
    if table("sessions") || table("rdp_certificate_pins") {
        candidates.push(MigrationCandidate {
            item: MigrationItem::RdpVncSessions,
            evidence: vec!["session records".into()],
            plugin_slug: "rdp-client".into(),
        });
    }
    if table("rdp_certificate_pins") {
        candidates.push(MigrationCandidate {
            item: MigrationItem::RdpCertificatePins,
            evidence: vec!["rdp_certificate_pins".into()],
            plugin_slug: "rdp-client".into(),
        });
    }
    if table("server_configs") {
        candidates.push(MigrationCandidate {
            item: MigrationItem::ServerConfigs,
            evidence: vec!["server_configs".into()],
            plugin_slug: "servers".into(),
        });
    }
    let files = [
        ("mfa.db", MigrationItem::Mfa, "mfa"),
        ("sockscap/config.json", MigrationItem::SocksCap, "sockscap"),
        (
            "mobile-desktop-remote.json",
            MigrationItem::Mobile,
            "mobile",
        ),
    ];
    for (relative, item, slug) in files {
        if data_dir.join(relative).exists() {
            candidates.push(MigrationCandidate {
                item,
                evidence: vec![relative.into()],
                plugin_slug: slug.into(),
            });
        }
    }
    candidates
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn detects_legacy_files_and_tables_without_mutating_data() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("mfa.db"), b"legacy").unwrap();
        fs::write(dir.path().join("lanchat.sqlite"), b"legacy-chat").unwrap();
        let found = detect_legacy_install(dir.path(), &["server_configs", "rdp_certificate_pins"]);
        assert_eq!(
            found
                .iter()
                .map(|candidate| candidate.plugin_slug.as_str())
                .collect::<Vec<_>>(),
            vec!["rdp-client", "rdp-client", "servers", "mfa"]
        );
        assert_eq!(fs::read(dir.path().join("mfa.db")).unwrap(), b"legacy");
        assert_eq!(
            fs::read(dir.path().join("lanchat.sqlite")).unwrap(),
            b"legacy-chat"
        );
        assert!(
            !found
                .iter()
                .any(|candidate| candidate.plugin_slug == "lanchat")
        );
    }

    #[test]
    fn journal_resume_is_idempotent_and_atomic() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("migration/journal.json");
        let mut journal = MigrationJournal {
            from_version: "0.5.9".into(),
            to_core_api_version: "1".into(),
            entries: vec![],
        };
        journal.mark(
            MigrationItem::Mfa,
            MigrationStepState::Committed,
            "hash".into(),
            PathBuf::from("plugins/mfa"),
        );
        journal.save_atomic(&path).unwrap();
        let loaded = MigrationJournal::load(&path).unwrap();
        assert!(loaded.committed(MigrationItem::Mfa));
        assert_eq!(loaded.entries.len(), 1);
    }
}
