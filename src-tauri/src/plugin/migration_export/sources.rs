//! Bind an MFA export to both encrypted data and its original Vault evidence.
use std::{collections::BTreeMap, path::Path};

use taomni_sqlite_snapshot::SnapshotControl;

use super::super::{LegacyInstallSnapshot, MigrationItem, paths, preflight, source};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct MfaSources {
    pub(super) fingerprints: BTreeMap<String, String>,
    pub(super) fixed_key_present: bool,
}

impl MfaSources {
    pub(super) fn from_snapshot(snapshot: &LegacyInstallSnapshot) -> Result<Self, String> {
        let candidates: Vec<_> = snapshot
            .candidates
            .iter()
            .filter(|candidate| candidate.item == MigrationItem::Mfa)
            .collect();
        if candidates.len() != 1 || candidates[0].plugin_slug != "mfa" {
            return Err("MFA export requires one detected MFA owner".into());
        }
        let fingerprints: BTreeMap<_, _> = ["mfa.db", "vault.db"]
            .into_iter()
            .filter_map(|path| {
                snapshot
                    .source_fingerprints
                    .get(path)
                    .map(|fingerprint| (path.to_owned(), fingerprint.clone()))
            })
            .collect();
        let fixed_key_present = snapshot
            .vault
            .as_ref()
            .is_some_and(|vault| vault.fixed_key_present);
        if snapshot.from_version.trim().is_empty()
            || fingerprints.contains_key("vault.db") != snapshot.vault.is_some()
            || (!fingerprints.contains_key("mfa.db") && !fixed_key_present)
            || candidates[0].evidence.is_empty()
            || candidates[0]
                .evidence
                .iter()
                .any(|path| !fingerprints.contains_key(path))
        {
            return Err("MFA export preflight evidence is incomplete".into());
        }
        Ok(Self {
            fingerprints,
            fixed_key_present,
        })
    }

    pub(super) fn has_database(&self) -> bool {
        self.fingerprints.contains_key("mfa.db")
    }

    pub(super) fn verify(&self, root: &Path, control: &SnapshotControl) -> Result<(), String> {
        let check = || control.check().map_err(|error| error.to_string());
        check()?;
        paths::directory(root)?;
        for relative in ["mfa.db", "vault.db"] {
            let path = root.join(relative);
            let exists = paths::database_exists(&path)?;
            let expected = self.fingerprints.get(relative);
            if exists != expected.is_some() {
                return Err("MFA export source changed; refresh the upgrade preflight".into());
            }
            if let Some(expected) = expected {
                let actual = if relative == "vault.db" {
                    let (present, fingerprint) = source::read_snapshot_checked(
                        &path,
                        preflight::read_vault_fixed_key_presence,
                        &check,
                    )?;
                    if present != self.fixed_key_present {
                        return Err(
                            "MFA export Vault evidence changed; refresh the preflight".into()
                        );
                    }
                    fingerprint
                } else {
                    source::database_fingerprint_checked(&path, &check)?
                };
                if &actual != expected {
                    return Err("MFA export source changed; refresh the upgrade preflight".into());
                }
            }
        }
        check()
    }
}

#[cfg(test)]
#[path = "sources_tests.rs"]
mod tests;
