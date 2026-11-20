//! Offline entry point shared by the maintenance process and signed QA gates.
use std::path::Path;

use taomni_profile_locks::{ProfileRoot, WaitControl};
use taomni_sqlite_snapshot::SnapshotControl;

use super::{
    current_platform,
    migration::{
        LEGACY_SOURCE_VERSION, MigrationItem, MigrationJournal,
        export::{MfaMaintenance, PreparedMfaExport},
        inspect_legacy_install, paths,
    },
    migration_commit,
    verify::VerifiedPackage,
};

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum MfaUpgradeOutcome {
    Migrated,
    AlreadyMigrated,
}

pub(crate) fn verify_archive(path: &Path, signature: &str) -> Result<VerifiedPackage, String> {
    let package = VerifiedPackage::from_offline(path, signature, current_platform())
        .map_err(|error| error.to_string())?;
    migration_commit::validate_manifest(package.manifest())?;
    Ok(package)
}

pub(crate) fn verify_archive_with_sidecar(
    archive: &Path,
    signature: &Path,
) -> Result<VerifiedPackage, String> {
    verify_archive(archive, &paths::read_detached_signature(signature)?)
}

pub(crate) fn execute(
    profile: &Path,
    package: &VerifiedPackage,
    password: &str,
    control: &SnapshotControl,
) -> Result<MfaUpgradeOutcome, String> {
    execute_inner(profile, package, password, control, None)
}

pub(crate) fn execute_after_exit(
    profile: &Path,
    package: &VerifiedPackage,
    password: &str,
    control: &SnapshotControl,
    wait: &WaitControl<'_>,
) -> Result<MfaUpgradeOutcome, String> {
    execute_inner(profile, package, password, control, Some(wait))
}

fn execute_inner(
    profile: &Path,
    package: &VerifiedPackage,
    password: &str,
    control: &SnapshotControl,
    wait: Option<&WaitControl<'_>>,
) -> Result<MfaUpgradeOutcome, String> {
    control.check().map_err(|error| error.to_string())?;
    migration_commit::validate_manifest(package.manifest())?;
    paths::directory(profile)?;
    migration_commit::recover_at_startup(profile).map_err(|error| error.to_string())?;
    let profile = ProfileRoot::prepare(profile).map_err(|error| error.to_string())?;
    let maintenance = match wait {
        Some(wait) => MfaMaintenance::acquire_after_exit(&profile, wait),
        None => MfaMaintenance::acquire(&profile),
    }
    .map_err(|error| error.to_string())?;
    let root = profile.path();
    if MigrationJournal::profile_mfa_committed(root)? {
        return Ok(MfaUpgradeOutcome::AlreadyMigrated);
    }

    // Discover the source after the previous owner closed its SQLite handles.
    // A normal shutdown can checkpoint WAL and change preflight fingerprints.
    let journal = MigrationJournal::load(&root.join("migration/journal.json"))?;
    let from_version = if journal.from_version.is_empty() {
        LEGACY_SOURCE_VERSION
    } else {
        journal.from_version.as_str()
    };
    let snapshot = inspect_legacy_install(root, from_version)?;
    if !snapshot
        .candidates
        .iter()
        .any(|item| item.item == MigrationItem::Mfa)
        || !snapshot.source_fingerprints.contains_key("mfa.db")
    {
        return Err("The profile has no legacy MFA database to migrate".into());
    }
    let export = PreparedMfaExport::prepare_under_maintenance(maintenance, &snapshot, control)?;
    migration_commit::commit_offline(export, &snapshot, package, password)?;
    Ok(MfaUpgradeOutcome::Migrated)
}
