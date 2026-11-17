//! Core-owned, temporary MFA data export for the legacy upgrade coordinator.
//!
//! This is not an installer or an activation permit. The encrypted SQLite
//! snapshot is kept separate from code versions, active data and the pending
//! journal. The future trusted transaction must retain this owner, revalidate
//! it and perform the scoped key check before committing anything.
mod sources;

use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    path::PathBuf,
};

use serde::{Deserialize, Serialize};
use taomni_profile_locks::{
    LegacyUpgradeLease, PluginDataLease, PluginSlug, ProfileRestoreLease, ProfileRoot,
    ProfileStateLease, VaultOperationLease,
};
use taomni_sqlite_snapshot::{
    SnapshotControl, SnapshotOptions, SnapshotOutcome, snapshot_existing,
};

use super::{LegacyInstallSnapshot, paths, source};
use sources::MfaSources;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum MfaExportKind {
    Database,
    VaultKeyOnly,
}

/// No Vault values, data keys, account names or sealed column values appear
/// here. Fingerprints bind input bytes; this receipt does not grant execution.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct MfaExportReceipt {
    pub format_version: u32,
    pub from_version: String,
    pub plugin_slug: String,
    pub kind: MfaExportKind,
    pub source_fingerprints: BTreeMap<String, String>,
    pub fixed_key_present: bool,
    pub database_fingerprint: Option<String>,
    pub database_bytes: Option<u64>,
    /// Final data location relative to plugins/mfa; never a versions/ path.
    pub target: Option<String>,
}

/// Keeps the exact profile's maintenance and data/key leases until temporary
/// data has been consumed or dropped. It acquires its own leases; callers
/// cannot pair another profile's permit with arbitrary source/target paths.
pub struct PreparedMfaExport {
    // Delete temporary data before releasing any of its ownership guards.
    staging: tempfile::TempDir,
    root: ProfileRoot,
    sources: MfaSources,
    receipt: MfaExportReceipt,
    control: SnapshotControl,
    _data: PluginDataLease,
    _vault: VaultOperationLease,
    _state: ProfileStateLease,
    _profile: ProfileRestoreLease,
    _legacy_mode: LegacyUpgradeLease,
}

impl PreparedMfaExport {
    /// Must run before stores open, or after a full application shutdown.
    /// Live desktop/headless/host users yield an actionable busy error. An
    /// existing mfa.db is never initialized, migrated or replaced by this API.
    pub fn prepare(
        profile: &ProfileRoot,
        snapshot: &LegacyInstallSnapshot,
        control: &SnapshotControl,
    ) -> Result<Self, String> {
        control.check().map_err(|error| error.to_string())?;
        paths::directory(profile.path())?;
        let _legacy_mode = LegacyUpgradeLease::try_acquire(profile)
            .map_err(|error| format!("Close the legacy application before MFA export: {error}"))?;
        let _profile = ProfileRestoreLease::try_acquire(profile)
            .map_err(|error| format!("Close other instances before MFA export: {error}"))?;
        let _state = ProfileStateLease::try_acquire(profile).map_err(|error| error.to_string())?;
        let _vault = VaultOperationLease::try_write(profile)
            .map_err(|error| format!("Vault is in use during MFA export: {error}"))?;
        let _data = PluginDataLease::try_acquire(
            profile,
            &PluginSlug::parse("mfa").map_err(|error| error.to_string())?,
        )
        .map_err(|error| format!("MFA data is in use during export: {error}"))?;
        let sources = MfaSources::from_snapshot(snapshot)?;
        if snapshot
            .vault
            .as_ref()
            .is_some_and(|vault| vault.path != profile.path().join("vault.db"))
        {
            return Err("MFA export Vault belongs to a different profile".into());
        }
        sources.verify(profile.path(), control)?;
        let migration = paths::create_directory(profile.path(), "migration")?;
        let exports = paths::create_directory(&migration, "exports")?;
        let staging = tempfile::Builder::new()
            .prefix("mfa-")
            .tempdir_in(exports)
            .map_err(|error| error.to_string())?;
        let database = if sources.has_database() {
            let target = staging.path().join("mfa.db");
            match snapshot_existing(
                &profile.path().join("mfa.db"),
                &target,
                &SnapshotOptions::default(),
                control,
            )
            .map_err(|error| error.to_string())?
            {
                SnapshotOutcome::Missing => return Err("Legacy MFA database disappeared".into()),
                SnapshotOutcome::Created(summary) => Some((
                    source::database_fingerprint_checked(&target, &|| {
                        control.check().map_err(|error| error.to_string())
                    })?,
                    summary.size_bytes,
                )),
            }
        } else {
            // A retained key without a DB is legitimate. Do not manufacture
            // an empty store/key or mark the candidate migrated.
            None
        };
        sources.verify(profile.path(), control)?;
        let receipt = MfaExportReceipt {
            format_version: 1,
            from_version: snapshot.from_version.clone(),
            plugin_slug: "mfa".into(),
            kind: if database.is_some() {
                MfaExportKind::Database
            } else {
                MfaExportKind::VaultKeyOnly
            },
            source_fingerprints: sources.fingerprints.clone(),
            fixed_key_present: sources.fixed_key_present,
            database_fingerprint: database
                .as_ref()
                .map(|(fingerprint, _)| fingerprint.clone()),
            database_bytes: database.map(|(_, bytes)| bytes),
            target: sources.has_database().then(|| "data/mfa.db".into()),
        };
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(staging.path().join("receipt.json"))
            .map_err(|error| error.to_string())?;
        file.write_all(&serde_json::to_vec_pretty(&receipt).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        let prepared = Self {
            staging,
            root: profile.clone(),
            sources,
            receipt,
            control: control.clone(),
            _data,
            _vault,
            _state,
            _profile,
            _legacy_mode,
        };
        prepared.verify()?;
        Ok(prepared)
    }

    pub fn receipt(&self) -> &MfaExportReceipt {
        &self.receipt
    }

    pub fn database_path(&self) -> Option<PathBuf> {
        self.sources
            .has_database()
            .then(|| self.staging.path().join("mfa.db"))
    }

    /// Recheck both sources and the complete temporary artifact immediately
    /// before handing it to the future trusted activation/key-check owner.
    pub fn verify(&self) -> Result<(), String> {
        let check = || self.control.check().map_err(|error| error.to_string());
        self.sources.verify(self.root.path(), &self.control)?;
        paths::directory(&self.root.path().join("migration"))?;
        paths::directory(&self.root.path().join("migration/exports"))?;
        paths::directory(self.staging.path())?;
        let mut files = fs::read_dir(self.staging.path())
            .map_err(|error| error.to_string())?
            .map(|entry| entry.map(|entry| entry.file_name()))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        files.sort();
        let expected_files: Vec<std::ffi::OsString> = if self.sources.has_database() {
            vec!["mfa.db".into(), "receipt.json".into()]
        } else {
            vec!["receipt.json".into()]
        };
        if files != expected_files {
            return Err("MFA export contains unexpected files or SQLite sidecars".into());
        }
        let expected =
            serde_json::to_vec_pretty(&self.receipt).map_err(|error| error.to_string())?;
        let mut actual = Vec::new();
        paths::open_file(&self.staging.path().join("receipt.json"))?
            .take(expected.len() as u64 + 1)
            .read_to_end(&mut actual)
            .map_err(|error| error.to_string())?;
        if actual != expected {
            return Err("MFA export receipt changed".into());
        }
        if let Some(path) = self.database_path() {
            paths::database_exists(&path)?;
            let actual = source::database_fingerprint_checked(&path, &check)?;
            if Some(actual) != self.receipt.database_fingerprint
                || Some(
                    fs::metadata(&path)
                        .map_err(|error| error.to_string())?
                        .len(),
                ) != self.receipt.database_bytes
            {
                return Err("MFA export snapshot changed".into());
            }
        } else if paths::database_exists(&self.staging.path().join("mfa.db"))? {
            return Err("MFA key-only export unexpectedly contains a database".into());
        }
        check()
    }
}
