//! Queue a verified Mail package while the profile is live, then adopt the
//! legacy cache before the next process opens the profile.

use std::{
    fs, io,
    path::{Path, PathBuf},
    time::Duration,
};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use taomni_sqlite_snapshot::SnapshotControl;

use super::{
    install::ModuleInstaller,
    migration::paths,
    migration_mail::{self, MailMaintenance},
    release_state,
    verify::{VerifiedPackage, installed_proof_paths},
};

pub(crate) const MAIL_ID: &str = "taomni-plugin-mail";
const OWNER: &str = "mail";
const PLAN: &str = "mail-provision.json";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProvisionPlan {
    version: String,
    archive_sha256: String,
    #[serde(default)]
    failed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct QueuedPlanStatus {
    pub(crate) failed: bool,
    pub(crate) error: Option<String>,
}

pub(crate) fn has_legacy_accounts(db: &Connection) -> Result<bool, String> {
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sessions WHERE session_type='Mail')",
        [],
        |row| row.get(0),
    )
    .map_err(|error| error.to_string())
}

/// The caller retains a live profile lease. Save the verified code and its
/// proof without writing the active pointer or reading live mailbox files.
pub(crate) fn queue(profile: &Path, package: &VerifiedPackage) -> Result<bool, String> {
    migration_mail::validate_manifest(package.manifest())?;
    let plugins = paths::create_directory(profile, "plugins")?;
    let installer = ModuleInstaller::new(&plugins);
    let _mutation = installer
        .lock_mutations()
        .map_err(|error| error.to_string())?;
    let pointer = installer
        .active_pointer(OWNER)
        .map_err(|error| error.to_string())?;
    if pointer.active_version.is_some() || pointer.was_uninstalled() {
        return Ok(false);
    }
    let module = paths::create_directory(&plugins, OWNER)?;
    paths::create_directory(&module, "versions")?;
    installer
        .stage_verified(package)
        .map_err(|error| error.to_string())?;
    let directory = paths::create_directory(profile, "migration")?;
    paths::write_json_durable(
        &directory.join(PLAN),
        &ProvisionPlan {
            version: package.manifest().version.clone(),
            archive_sha256: package.archive_sha256().to_owned(),
            failed: false,
            error: None,
        },
    )?;
    Ok(true)
}

pub(crate) fn queued(profile: &Path) -> Result<bool, String> {
    Ok(plan_path(profile)?.is_some())
}

pub(crate) fn queued_pending(profile: &Path) -> Result<bool, String> {
    Ok(queued_status(profile)?.is_some_and(|status| !status.failed))
}

pub(crate) fn queued_status(profile: &Path) -> Result<Option<QueuedPlanStatus>, String> {
    plan_path(profile)?
        .map(|path| {
            paths::read_json_bounded::<ProvisionPlan>(&path).map(|plan| QueuedPlanStatus {
                failed: plan.failed,
                error: plan.error,
            })
        })
        .transpose()
}

pub(crate) fn queued_failure(profile: &Path) -> Result<Option<bool>, String> {
    Ok(queued_status(profile)?.map(|status| status.failed))
}

fn plan_path(profile: &Path) -> Result<Option<PathBuf>, String> {
    let directory = profile.join("migration");
    match fs::symlink_metadata(&directory) {
        Ok(_) => paths::directory(&directory)?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    }
    let path = directory.join(PLAN);
    paths::file_exists(&path).map(|exists| exists.then_some(path))
}

pub(crate) fn apply_before_startup(profile: &Path) -> Result<(), String> {
    let maintenance = MailMaintenance::acquire(profile)?;
    let profile = maintenance.path();
    let Some(path) = plan_path(profile)? else {
        return Ok(());
    };
    let mut plan: ProvisionPlan = paths::read_json_bounded(&path)?;
    let installer = ModuleInstaller::new(profile.join("plugins"));
    if let Err(error) = apply(&maintenance, &installer, &plan) {
        plan.failed = true;
        plan.error = Some(error.clone());
        eprintln!("Taomni: staged Mail upgrade failed: {error}");
        if let Err(record_error) = paths::write_json_durable(&path, &plan) {
            tracing::warn!(%record_error, "Could not record the Mail upgrade failure");
        }
        return Err(error);
    }
    release_state::complete(profile, MAIL_ID)?;
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn apply(
    maintenance: &MailMaintenance,
    installer: &ModuleInstaller,
    plan: &ProvisionPlan,
) -> Result<(), String> {
    paths::directory(installer.root())?;
    let pointer = installer
        .active_pointer(OWNER)
        .map_err(|error| error.to_string())?;
    if !pointer.was_uninstalled() {
        let version = installer
            .version_dir(OWNER, &plan.version)
            .map_err(|error| error.to_string())?;
        for directory in [
            installer.root(),
            &installer.root().join(OWNER),
            &installer.root().join(OWNER).join("versions"),
            &version,
        ] {
            paths::directory(directory)?;
        }
        let (archive, signature) = installed_proof_paths(&version);
        paths::directory(archive.parent().ok_or("Mail package proof is missing")?)?;
        let package = migration_mail::verify_archive(&archive, &signature)?;
        if package.archive_sha256() != plan.archive_sha256
            || package.manifest().version != plan.version
        {
            return Err("The verified Mail package differs from the staged upgrade".into());
        }
        migration_mail::execute_under_maintenance(
            maintenance,
            &package,
            &SnapshotControl::with_timeout(Duration::from_secs(900)),
        )?;
    }
    Ok(())
}
