//! Offline activation of a real, signed MFA package. The migration journal
//! is the commit point. Recovery rolls back the writes preceding that point.
use std::{
    collections::BTreeMap,
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use taomni_plugin_api::services::{MFA_DATA_KEY_ID, ProfileGeneration};
use taomni_profile_locks::ProfileRoot;

use super::{
    CORE_API_VERSION, ModuleManifest, PluginKind, SnapshotMode, current_platform,
    install::{ActivePointer, ModuleInstaller},
    migration::{
        LegacyInstallSnapshot, MFA_MIGRATION_TARGET as TARGET, MigrationExecutor, MigrationItem,
        MigrationJournal, MigrationRunState, MigrationStepState,
        export::{
            MfaExportKind, MfaExportReceipt, MfaMaintenance, MfaMaintenanceError, PreparedMfaExport,
        },
        paths, source,
    },
    verify::{self, VerifiedPackage},
};
use crate::runtime::generation;

const PLAN: &str = "migration/mfa-transaction.json";
const JOURNAL: &str = "migration/journal.json";
const DATA_DIR: &str = "plugins/mfa/data";
const OWNER: &str = "mfa";
const POINTER: &str = "plugins/mfa/active.json";
const REGISTRY_STATE: &str = "plugins/state.json";
const OWNERSHIP: &str = ".legacy-mfa-upgrade.json";

/// Deserialization never grants trust in a package or selects a write path.
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Transaction {
    format: u8,
    from_version: String,
    package_version: String,
    generation: ProfileGeneration,
    target_fingerprint: String,
    source_fingerprint: String,
    pointer_existed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    installed_pointer: Option<ActivePointer>,
    export_staging: String,
    #[serde(default)]
    enable_after_commit: bool,
}

impl Transaction {
    fn staging(&self, root: &Path) -> PathBuf {
        root.join("plugins/mfa")
            .join(format!(".legacy-data-{}", self.generation.as_str()))
    }

    fn active_pointer(&self) -> ActivePointer {
        self.installed_pointer
            .clone()
            .unwrap_or_else(|| ActivePointer {
                active_version: Some(self.package_version.clone()),
                ..ActivePointer::default()
            })
    }

    fn journal_committed(&self, journal: &MigrationJournal) -> Result<bool, String> {
        if journal.from_version != self.from_version
            || journal.to_core_api_version != CORE_API_VERSION
        {
            return Err("MFA recovery journal version changed".into());
        }
        let mut matches = journal
            .entries
            .iter()
            .filter(|entry| entry.item == MigrationItem::Mfa);
        let entry = matches
            .next()
            .ok_or("MFA recovery journal entry is missing")?;
        if matches.next().is_some()
            || entry.source_path != Path::new("mfa.db")
            || entry.source_fingerprint != self.source_fingerprint
        {
            return Err("MFA recovery journal entry changed".into());
        }
        match entry.state {
            MigrationStepState::Pending if entry.target.as_os_str().is_empty() => Ok(false),
            MigrationStepState::Committed if entry.target == Path::new(TARGET) => Ok(true),
            _ => Err("MFA recovery journal state changed".into()),
        }
    }
}

/// Invoke before the live profile has opened its stores. The export owner
/// holds all required leases through verification, commit, and rollback.
#[cfg(all(test, feature = "qa-release-trust-gates"))]
fn commit(
    export: PreparedMfaExport,
    package: &VerifiedPackage,
    password: &str,
) -> Result<(), String> {
    commit_inner(export, package, password, None, || {})
}

pub(super) fn commit_offline(
    export: PreparedMfaExport,
    snapshot: &LegacyInstallSnapshot,
    package: &VerifiedPackage,
    password: &str,
) -> Result<(), String> {
    commit_inner(export, package, password, Some(snapshot), || {})
}

fn commit_inner(
    export: PreparedMfaExport,
    package: &VerifiedPackage,
    password: &str,
    preflight: Option<&LegacyInstallSnapshot>,
    after_activate: impl FnOnce(),
) -> Result<(), String> {
    let maintenance = export.maintenance();
    let root = maintenance.profile().path();
    validate_manifest(package.manifest())?;
    if paths::file_exists(&root.join(PLAN))? {
        return Err("Recover the interrupted MFA upgrade before retrying".into());
    }
    for restore in [
        crate::backup::restore::RESTORE_INTENT_FILE,
        crate::backup::restore::JOURNAL_FILE,
    ] {
        if paths::file_exists(&root.join(restore))? {
            return Err("Apply the pending backup restore before upgrading MFA".into());
        }
    }
    if export.receipt().kind != MfaExportKind::Database {
        return Err("The original Vault key is retained; no MFA database needs migration".into());
    }
    let fingerprint = export
        .receipt()
        .database_fingerprint
        .clone()
        .ok_or("Missing MFA export fingerprint")?;
    let source_fingerprint = export
        .receipt()
        .source_fingerprints
        .get("mfa.db")
        .cloned()
        .ok_or("Missing legacy MFA source fingerprint")?;
    check_optional_dir(&root.join("plugins"))?;
    check_optional_dir(&root.join("plugins/mfa"))?;
    check_optional_dir(&root.join("plugins/mfa/versions"))?;
    if check_optional_dir(&root.join(DATA_DIR))?
        || paths::file_exists(&root.join("plugins/mfa/module.json"))?
    {
        return Err(
            "MFA already has module data or a direct installation; original data retained".into(),
        );
    }
    let installer = ModuleInstaller::new(root.join("plugins"));
    let pointer_existed = paths::file_exists(&root.join(POINTER))?;
    let current = installer.active_pointer(OWNER).map_err(message)?;
    let installed_pointer = if current == ActivePointer::default() {
        None
    } else if current.active_version.as_deref() == Some(package.manifest().version.as_str()) {
        Some(current)
    } else {
        return Err(
            "The installed MFA version changed. Choose its signed package in Settings".into(),
        );
    };
    let enabled = read_registry_state(root)?
        .get(OWNER)
        .copied()
        .unwrap_or(true);
    export.verify_key(password)?;
    let journal_path = root.join(JOURNAL);
    if let Some(snapshot) = preflight {
        MigrationExecutor::new(
            root,
            root.join("plugins"),
            journal_path.clone(),
            &snapshot.from_version,
            CORE_API_VERSION,
        )?
        .record_pending(snapshot)?;
    }
    let mut journal: MigrationJournal = paths::read_json_bounded(&journal_path)?;
    let transaction = Transaction {
        format: 1,
        from_version: export.receipt().from_version.clone(),
        package_version: package.manifest().version.clone(),
        generation: ProfileGeneration::parse(uuid::Uuid::new_v4().to_string())
            .expect("canonical UUID"),
        target_fingerprint: fingerprint,
        source_fingerprint,
        pointer_existed,
        installed_pointer,
        export_staging: export.staging_name().into(),
        enable_after_commit: enabled,
    };
    if transaction.journal_committed(&journal)? {
        return Err("MFA data has already been migrated".into());
    }
    let version_dir = installer.stage_verified(package).map_err(message)?;
    let installed = verify::verify_installed(&version_dir, current_platform()).map_err(message)?;
    if installed != *package.manifest() {
        return Err("The staged MFA package differs from the verified manifest".into());
    }
    let src = export.database_path().ok_or("Missing exported MFA data")?;
    let stage = transaction.staging(root);
    if check_optional_dir(&stage)? {
        return Err("MFA upgrade staging directory already exists".into());
    }
    paths::write_json_durable(&root.join(PLAN), &transaction)?;
    let result = (|| {
        fs::create_dir(&stage).map_err(message)?;
        let owner = serde_json::to_vec(&transaction.generation).map_err(message)?;
        let mut marker = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(stage.join(OWNERSHIP))
            .map_err(message)?;
        marker.write_all(&owner).map_err(message)?;
        marker.sync_all().map_err(message)?;
        drop(marker);
        let staged_db = stage.join("mfa.db");
        copy_verified_export(&export, &src, &transaction.target_fingerprint, &staged_db)?;
        paths::sync_directory(&stage)?;
        export.verify()?;
        if check_optional_dir(&root.join(DATA_DIR))? {
            return Err("MFA module data appeared during the upgrade".into());
        }
        export.check()?;
        generation::access_for_mfa_upgrade(maintenance, Some(transaction.generation.clone()))?;
        fs::rename(&stage, root.join(DATA_DIR)).map_err(message)?;
        paths::sync_directory(&root.join("plugins/mfa"))?;
        export.check()?;
        let pointer = installer
            .activate(OWNER, &transaction.package_version)
            .map_err(message)?;
        if pointer != transaction.active_pointer() {
            return Err("Publishing the MFA upgrade changed an unexpected active pointer".into());
        }
        after_activate();
        export.check()?;
        journal.mark_with_source(
            MigrationItem::Mfa,
            MigrationStepState::Committed,
            transaction.source_fingerprint.clone(),
            "mfa.db".into(),
            TARGET.into(),
        );
        journal.status = if journal
            .entries
            .iter()
            .all(|entry| entry.state == MigrationStepState::Committed)
        {
            MigrationRunState::Complete
        } else {
            MigrationRunState::Pending
        };
        paths::write_json_durable(&journal_path, &journal)
    })();
    // Once commit starts, recovery must finish or retain its journal even
    // when the original operation has been cancelled or timed out.
    match result {
        Ok(()) => finish_commit(root, &transaction),
        Err(error) => match recover_locked(maintenance) {
            Ok(true) => Ok(()),
            Ok(false) => Err(error),
            Err(recovery) => Err(format!("{error}; MFA recovery required: {recovery}")),
        },
    }
}

pub(crate) fn recovery_pending(data: &Path) -> Result<bool, String> {
    Ok(check_optional_dir(&data.join("migration"))? && paths::file_exists(&data.join(PLAN))?)
}

pub(crate) fn recover_at_startup(data: &Path) -> Result<(), MfaMaintenanceError> {
    if !recovery_pending(data)? {
        return Ok(());
    }
    let profile = ProfileRoot::prepare(data).map_err(message)?;
    let maintenance = MfaMaintenance::acquire(&profile)?;
    // A racing recovery may have finished while acquiring ownership.
    if recovery_pending(profile.path())? {
        recover_locked(&maintenance)?;
    }
    Ok(())
}

fn recover_locked(maintenance: &MfaMaintenance) -> Result<bool, String> {
    let root = maintenance.profile().path();
    paths::directory(&root.join("migration"))?;
    for relative in ["plugins", "plugins/mfa", "plugins/mfa/versions"] {
        paths::directory(&root.join(relative))?;
    }
    let transaction: Transaction = paths::read_json_bounded(&root.join(PLAN))?;
    let installer = ModuleInstaller::new(root.join("plugins"));
    let dir = installer
        .version_dir(OWNER, &transaction.package_version)
        .map_err(message)?;
    if transaction.format != 1
        || !source::valid_fingerprint(&transaction.target_fingerprint)
        || !source::valid_fingerprint(&transaction.source_fingerprint)
        || !valid_export_name(&transaction.export_staging)
        || transaction
            .installed_pointer
            .as_ref()
            .is_some_and(|pointer| {
                !transaction.pointer_existed
                    || pointer.active_version.as_deref()
                        != Some(transaction.package_version.as_str())
            })
    {
        return Err("Invalid MFA recovery record".into());
    }
    let journal = paths::read_json_bounded(&root.join(JOURNAL))?;
    let committed = transaction.journal_committed(&journal)?;
    let pointer_file = paths::file_exists(&root.join(POINTER))?;
    let current = installer.active_pointer(OWNER).map_err(message)?;
    let activated = current == transaction.active_pointer();
    if !activated
        && (transaction.installed_pointer.is_some() || current != ActivePointer::default())
    {
        return Err("MFA active pointer was changed outside the upgrade".into());
    }
    let data = root.join(DATA_DIR);
    let published = check_optional_dir(&data)?;
    let stage = transaction.staging(root);
    if committed {
        let installed = verify::verify_installed(&dir, current_platform()).map_err(message)?;
        validate_manifest(&installed)?;
        if installed.version != transaction.package_version
            || !published
            || !activated
            || !pointer_file
            || generation::access_for_mfa_upgrade(maintenance, None)? != transaction.generation
        {
            return Err("The committed MFA upgrade needs recovery; data retained".into());
        }
        check_database(root, &transaction)?;
        finish_commit(root, &transaction)?;
    } else {
        if published {
            let owner: ProfileGeneration = paths::read_json_bounded(&data.join(OWNERSHIP))
                .map_err(|_| "MFA recovery will not remove an existing data directory without upgrade ownership")?;
            if owner != transaction.generation || check_optional_dir(&stage)? {
                return Err("MFA recovery found an unrelated data directory".into());
            }
            check_database(root, &transaction)?;
            check_staging_contents(&data)?;
        }
        if activated && transaction.installed_pointer.is_none() && transaction.pointer_existed {
            installer
                .restore_pointer(OWNER, &ActivePointer::default())
                .map_err(message)?;
        } else if activated && transaction.installed_pointer.is_none() {
            fs::remove_file(root.join(POINTER)).map_err(message)?;
            paths::sync_directory(&root.join("plugins/mfa"))?;
        }
        if published {
            fs::rename(&data, &stage).map_err(message)?;
            paths::sync_directory(&root.join("plugins/mfa"))?;
        }
        cleanup_stage(root, &stage)?;
        cleanup_export(root, &transaction)?;
        cleanup_plan(root)?;
    }
    Ok(committed)
}

fn copy_verified_export(
    export: &PreparedMfaExport,
    source: &Path,
    fingerprint: &str,
    target: &Path,
) -> Result<(), String> {
    use std::io::Read;
    let mut input = paths::open_file(source)?;
    let mut output = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(target)
        .map_err(message)?;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        export.check()?;
        let count = input.read(&mut buffer).map_err(message)?;
        if count == 0 {
            break;
        }
        output.write_all(&buffer[..count]).map_err(message)?;
    }
    output.sync_all().map_err(message)?;
    drop(output);
    if source::database_fingerprint_checked(target, &|| export.check())? != fingerprint {
        return Err("Prepared MFA upgrade data differs from the verified export".into());
    }
    Ok(())
}

fn check_optional_dir(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => paths::directory(path).map(|()| true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(message(error)),
    }
}

pub(super) fn validate_manifest(manifest: &ModuleManifest) -> Result<(), String> {
    if manifest.slug != OWNER
        || manifest.id != "taomni-plugin-mfa"
        || manifest.kind != PluginKind::Auth
        || manifest.entry.host.is_none()
        || manifest.core_api_version != CORE_API_VERSION
        || manifest.data_schema_version != 1
        || manifest.data_dir != "plugins/mfa"
        || manifest.backup_paths != [TARGET]
        || !manifest.legacy_tables.is_empty()
        || manifest.vault_fixed_keys != [MFA_DATA_KEY_ID]
        || !manifest.permissions.contains("vault.fixed-key")
        || manifest.snapshot != SnapshotMode::Rpc
    {
        return Err("The verified package does not support this legacy MFA data".into());
    }
    Ok(())
}

fn valid_export_name(name: &str) -> bool {
    name.strip_prefix("mfa-").is_some_and(|suffix| {
        (6..=32).contains(&suffix.len()) && suffix.bytes().all(|byte| byte.is_ascii_alphanumeric())
    })
}

fn check_database(root: &Path, transaction: &Transaction) -> Result<(), String> {
    let target = root.join(TARGET);
    if !paths::database_exists(&target)?
        || source::database_fingerprint(&target)? != transaction.target_fingerprint
    {
        return Err("MFA recovery found changed upgrade data; files retained".into());
    }
    Ok(())
}

fn check_staging_contents(stage: &Path) -> Result<(), String> {
    for entry in fs::read_dir(stage).map_err(message)? {
        let entry = entry.map_err(message)?;
        if !matches!(entry.file_name().to_str(), Some("mfa.db" | OWNERSHIP)) {
            return Err("Unexpected files in MFA migration staging; retained for recovery".into());
        }
        paths::file_exists(&entry.path())?;
    }
    Ok(())
}

fn cleanup_stage(root: &Path, stage: &Path) -> Result<(), String> {
    if check_optional_dir(stage)? {
        check_staging_contents(stage)?;
        // The name is derived from the journal's validated UUID. Each file
        // is a fixed staging member and safe to remove on interrupted copy.
        for name in ["mfa.db", OWNERSHIP] {
            let path = stage.join(name);
            if paths::file_exists(&path)? {
                fs::remove_file(path).map_err(message)?;
            }
        }
        fs::remove_dir(stage).map_err(message)?;
        paths::sync_directory(&root.join("plugins/mfa"))?;
    }
    Ok(())
}

fn finish_commit(root: &Path, transaction: &Transaction) -> Result<(), String> {
    if transaction.enable_after_commit {
        let mut enabled = read_registry_state(root)?;
        if enabled.insert(OWNER.into(), true) != Some(true) {
            paths::write_json_durable(&root.join(REGISTRY_STATE), &enabled)?;
        }
    }
    let data = root.join(DATA_DIR);
    let marker = data.join(OWNERSHIP);
    if paths::file_exists(&marker)? {
        let owner: ProfileGeneration = paths::read_json_bounded(&marker)?;
        if owner != transaction.generation {
            return Err("MFA upgrade ownership marker changed".into());
        }
        fs::remove_file(marker).map_err(message)?;
        paths::sync_directory(&data)?;
    }
    cleanup_export(root, transaction)?;
    cleanup_plan(root)
}

fn read_registry_state(root: &Path) -> Result<BTreeMap<String, bool>, String> {
    let path = root.join(REGISTRY_STATE);
    if paths::file_exists(&path)? {
        paths::read_json_bounded(&path)
    } else {
        Ok(BTreeMap::new())
    }
}

fn cleanup_export(root: &Path, transaction: &Transaction) -> Result<(), String> {
    let exports = root.join("migration/exports");
    if !check_optional_dir(&exports)? {
        return Ok(());
    }
    let stage = exports.join(&transaction.export_staging);
    if !check_optional_dir(&stage)? {
        return Ok(());
    }
    let database = stage.join("mfa.db");
    let receipt = stage.join("receipt.json");
    if paths::file_exists(&receipt)? {
        let saved: MfaExportReceipt = paths::read_json_bounded(&receipt)?;
        if saved.plugin_slug != OWNER
            || saved.from_version != transaction.from_version
            || saved.database_fingerprint.as_deref() != Some(&transaction.target_fingerprint)
            || saved.source_fingerprints.get("mfa.db") != Some(&transaction.source_fingerprint)
        {
            return Err("MFA export staging ownership changed; files retained".into());
        }
        if paths::file_exists(&database)? {
            if source::database_fingerprint(&database)? != transaction.target_fingerprint {
                return Err("MFA export staging data changed; files retained".into());
            }
            fs::remove_file(&database).map_err(message)?;
        }
        fs::remove_file(&receipt).map_err(message)?;
    }
    fs::remove_dir(&stage).map_err(message)?;
    paths::sync_directory(&exports)
}

fn cleanup_plan(root: &Path) -> Result<(), String> {
    fs::remove_file(root.join(PLAN)).map_err(message)?;
    paths::sync_directory(&root.join("migration"))
}

fn message(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(all(test, feature = "qa-release-trust-gates"))]
#[path = "migration_commit_tests.rs"]
mod tests;
