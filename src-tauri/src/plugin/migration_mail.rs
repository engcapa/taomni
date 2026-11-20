//! First Mail activation from a verified package and an offline legacy profile.

use std::{
    fs, io,
    path::{Path, PathBuf},
};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use taomni_mail_engine::{
    database::{configured_directory, mail_db_file_stem},
    migration::{LegacyMailbox, StagedMailData},
};
use taomni_profile_locks::{
    LegacyUpgradeLease, PluginDataLease, PluginSlug, ProfileRestoreLease, ProfileRoot,
};
use taomni_sqlite_snapshot::SnapshotControl;

use super::{
    CORE_API_VERSION, ModuleManifest, PluginKind, current_platform,
    install::ModuleInstaller,
    migration::{
        LEGACY_SOURCE_VERSION, MAIL_MIGRATION_TARGET, MigrationItem, MigrationJournal,
        MigrationRunState, MigrationStepState, paths, source, valid_mail_commit,
    },
    verify::VerifiedPackage,
};

const OWNER: &str = "mail";
const LEGACY_DATABASE: &str = "taomni.db";
const RECEIPT: &str = ".legacy-mail-upgrade.json";
const TRANSACTION: &str = "mail-transaction.json";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum MailUpgradeOutcome {
    Migrated,
    AlreadyMigrated,
}

/// Published with the data directory. If the process exits before writing the
/// active pointer or central journal, a retry resumes from this receipt.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DataReceipt {
    format_version: u32,
    transaction_id: String,
    source_fingerprint: String,
    data_schema_version: u32,
}

pub(super) struct MailMaintenance {
    root: ProfileRoot,
    _mail: PluginDataLease,
    _profile: ProfileRestoreLease,
    _legacy: LegacyUpgradeLease,
}

impl MailMaintenance {
    pub(super) fn acquire(profile: &Path) -> Result<Self, String> {
        paths::directory(profile)?;
        super::migration_commit::recover_at_startup(profile).map_err(|error| error.to_string())?;
        let root = ProfileRoot::prepare(profile).map_err(|error| error.to_string())?;
        let legacy = LegacyUpgradeLease::try_acquire(&root).map_err(|error| {
            format!("Close the legacy application before Mail upgrade: {error}")
        })?;
        let profile = ProfileRestoreLease::try_acquire(&root)
            .map_err(|error| format!("Close other instances before Mail upgrade: {error}"))?;
        let mail = PluginDataLease::try_acquire(
            &root,
            &PluginSlug::parse(OWNER).expect("built-in Mail slug"),
        )
        .map_err(|error| format!("Mail data is in use: {error}"))?;
        Ok(Self {
            root,
            _mail: mail,
            _profile: profile,
            _legacy: legacy,
        })
    }

    pub(super) fn path(&self) -> &Path {
        self.root.path()
    }
}

pub(crate) fn verify_archive(archive: &Path, signature: &Path) -> Result<VerifiedPackage, String> {
    let package = VerifiedPackage::from_offline(
        archive,
        &paths::read_detached_signature(signature)?,
        current_platform(),
    )
    .map_err(|error| error.to_string())?;
    validate_manifest(package.manifest())?;
    Ok(package)
}

pub(crate) fn execute(
    profile: &Path,
    package: &VerifiedPackage,
    control: &SnapshotControl,
) -> Result<MailUpgradeOutcome, String> {
    control.check().map_err(|error| error.to_string())?;
    execute_under_maintenance(&MailMaintenance::acquire(profile)?, package, control)
}

pub(super) fn execute_under_maintenance(
    maintenance: &MailMaintenance,
    package: &VerifiedPackage,
    control: &SnapshotControl,
) -> Result<MailUpgradeOutcome, String> {
    let manifest = package.manifest();
    validate_manifest(manifest)?;
    let check = || control.check().map_err(|error| error.to_string());
    check()?;
    let root = maintenance.path();

    let migration = paths::create_directory(root, "migration")?;
    let journal_path = migration.join("journal.json");
    let transaction_path = migration.join(TRANSACTION);
    let mut journal = MigrationJournal::load(&journal_path)?;
    if mail_already_committed(&journal)? {
        return Ok(MailUpgradeOutcome::AlreadyMigrated);
    }
    if journal.from_version.is_empty() {
        journal.from_version = LEGACY_SOURCE_VERSION.into();
        journal.to_core_api_version = CORE_API_VERSION.into();
    }
    if journal.to_core_api_version != CORE_API_VERSION {
        return Err("Mail migration journal belongs to a different core API".into());
    }

    let plugins = paths::create_directory(root, "plugins")?;
    let installer = ModuleInstaller::new(&plugins);
    let _mutations = installer
        .lock_mutations()
        .map_err(|error| error.to_string())?;
    let pointer = installer
        .active_pointer(OWNER)
        .map_err(|error| error.to_string())?;
    if pointer.was_uninstalled() {
        return Err(
            "Mail was uninstalled. Reinstall it explicitly to reuse its retained data".into(),
        );
    }
    let module = paths::create_directory(&plugins, OWNER)?;
    let data = module.join("data");
    let previous: Option<String> = if paths::file_exists(&transaction_path)? {
        Some(paths::read_json_bounded(&transaction_path)?)
    } else {
        None
    };
    let receipt = load_receipt(&data, manifest.data_schema_version, previous.as_deref())?;
    if let Some(active) = &pointer.active_version {
        if receipt.is_none() || active != &manifest.version {
            return Err("An existing Mail installation requires its normal update flow".into());
        }
    }
    let staged_version = installer
        .stage_verified(package)
        .map_err(|error| error.to_string())?;
    package
        .check_installed_contents(&staged_version)
        .map_err(|error| error.to_string())?;
    check()?;
    let receipt = if pointer.active_version.is_some() {
        receipt.ok_or("Missing Mail upgrade data receipt")?
    } else {
        let transaction = match previous {
            Some(transaction) => transaction,
            None => {
                let transaction = uuid::Uuid::new_v4().to_string();
                paths::write_json_durable(&transaction_path, &transaction)?;
                transaction
            }
        };
        // The old application could have reopened after an interrupted
        // attempt. Take a fresh snapshot before the first activation.
        publish_data(
            root,
            &module,
            &data,
            &transaction,
            receipt.is_some(),
            control,
        )?
    };
    // Data is durable at the final location before selecting the verified
    // version. A failure here leaves a resumable data receipt.
    installer
        .activate(OWNER, &manifest.version)
        .map_err(|error| error.to_string())?;
    journal.mark_with_source(
        MigrationItem::MailAccounts,
        MigrationStepState::Committed,
        receipt.source_fingerprint,
        LEGACY_DATABASE.into(),
        MAIL_MIGRATION_TARGET.into(),
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
    journal.save_atomic(&journal_path)?;
    // The committed journal is authoritative even if housekeeping fails.
    let _ = fs::remove_file(transaction_path);
    Ok(MailUpgradeOutcome::Migrated)
}

pub(super) fn validate_manifest(manifest: &ModuleManifest) -> Result<(), String> {
    if manifest.slug != OWNER
        || manifest.id != "taomni-plugin-mail"
        || manifest.kind != PluginKind::Collaboration
        || manifest.entry.host.is_none()
        || manifest.core_api_version != CORE_API_VERSION
        || manifest.data_schema_version != 1
        || manifest.data_dir != "plugins/mail"
        || manifest.backup_paths != [MAIL_MIGRATION_TARGET]
        || !manifest.permissions.contains("fs.dataDir")
    {
        return Err("The verified package does not support this legacy Mail data".into());
    }
    Ok(())
}

fn mail_already_committed(journal: &MigrationJournal) -> Result<bool, String> {
    let mut entries = journal
        .entries
        .iter()
        .filter(|entry| entry.item == MigrationItem::MailAccounts);
    match (entries.next(), entries.next()) {
        (None, None) => Ok(false),
        (Some(entry), None)
            if entry.state == MigrationStepState::Pending
                && entry.target.as_os_str().is_empty() =>
        {
            Ok(false)
        }
        (Some(entry), None)
            if entry.state == MigrationStepState::Committed && valid_mail_commit(entry) =>
        {
            Ok(true)
        }
        _ => Err("Mail migration journal requires recovery".into()),
    }
}

fn load_receipt(
    data: &Path,
    data_schema_version: u32,
    transaction: Option<&str>,
) -> Result<Option<DataReceipt>, String> {
    match fs::symlink_metadata(data) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
        Ok(_) => paths::directory(data)?,
    }
    let path = data.join(RECEIPT);
    if !paths::file_exists(&path)? {
        if fs::read_dir(data)
            .map_err(|error| error.to_string())?
            .next()
            .is_none()
        {
            return Ok(None);
        }
        return Err(
            "Mail already has module data. Preserve it before attempting a migration".into(),
        );
    }
    let receipt: DataReceipt = paths::read_json_bounded(&path)?;
    if transaction != Some(receipt.transaction_id.as_str()) {
        return Err("Mail already has retained data from another installation".into());
    }
    if receipt.format_version != 1
        || receipt.data_schema_version != data_schema_version
        || !source::valid_fingerprint(&receipt.source_fingerprint)
    {
        return Err("Mail upgrade data receipt requires recovery".into());
    }
    Ok(Some(receipt))
}

fn publish_data(
    profile: &Path,
    module: &Path,
    target: &Path,
    transaction_id: &str,
    replace_unactivated: bool,
    control: &SnapshotControl,
) -> Result<DataReceipt, String> {
    let database = profile.join(LEGACY_DATABASE);
    if !paths::database_exists(&database)? {
        return Err("The profile has no legacy Mail database".into());
    }
    let check = || control.check().map_err(|error| error.to_string());
    let (mailboxes, source_fingerprint) = source::read_snapshot_checked(
        &database,
        |connection| read_mailboxes(profile, connection),
        &check,
    )?;
    if mailboxes.is_empty() {
        return Err("The profile has no legacy Mail accounts".into());
    }
    let stage = StagedMailData::prepare(module, &mailboxes, control)?;
    let receipt = DataReceipt {
        format_version: 1,
        transaction_id: transaction_id.to_owned(),
        source_fingerprint,
        data_schema_version: 1,
    };
    let directory = stage.data();
    paths::write_json_durable(&directory.join(RECEIPT), &receipt)?;
    check()?;
    let previous_copy = directory.with_file_name("previous-data");
    if replace_unactivated {
        fs::rename(target, &previous_copy).map_err(|error| error.to_string())?;
    } else {
        match fs::remove_dir(target) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    if let Err(error) = fs::rename(directory, target) {
        if replace_unactivated && let Err(restore_error) = fs::rename(previous_copy, target) {
            return Err(format!(
                "Could not publish or restore the Mail snapshot: {error}; {restore_error}"
            ));
        }
        return Err(error.to_string());
    }
    paths::sync_directory(module)?;
    Ok(receipt)
}

fn read_mailboxes(profile: &Path, connection: &Connection) -> Result<Vec<LegacyMailbox>, String> {
    let mut query = connection
        .prepare("SELECT id, options_json FROM sessions WHERE session_type='Mail' ORDER BY id")
        .map_err(|error| format!("Read legacy Mail account settings: {error}"))?;
    let mut rows = query.query([]).map_err(|error| error.to_string())?;
    let default = profile.join("mail-cache");
    let mut mailboxes = Vec::new();
    while let Some(row) = rows.next().map_err(|error| error.to_string())? {
        let account_id: String = row.get(0).map_err(|error| error.to_string())?;
        let options: String = row.get(1).map_err(|error| error.to_string())?;
        let directory = configured_directory(&options, &default)?;
        if directory != default {
            paths::directory(&directory).map_err(|error| {
                format!("The configured legacy Mail directory is unavailable: {error}")
            })?;
        }
        let database = directory.join(format!("{}.db", mail_db_file_stem(&account_id)));
        mailboxes.push(LegacyMailbox {
            account_id,
            database,
        });
    }
    Ok(mailboxes)
}

#[cfg(test)]
#[path = "migration_mail_tests.rs"]
mod tests;
