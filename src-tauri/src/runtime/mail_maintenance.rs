//! Offline activation and migration for a verified Mail module package.

use std::{ffi::OsString, path::Path, time::Duration};

use taomni_sqlite_snapshot::SnapshotControl;

use crate::plugin::migration_mail::{self, MailUpgradeOutcome};

pub const MAIL_MAINTENANCE_ARG: &str = "--migrate-mail";

pub fn run_mail_maintenance(args: impl IntoIterator<Item = OsString>) -> Result<(), String> {
    let mut args = args.into_iter();
    let (Some(profile), Some(archive), Some(signature), None) =
        (args.next(), args.next(), args.next(), args.next())
    else {
        return Err(format!(
            "Usage: Taomni {MAIL_MAINTENANCE_ARG} <profile> <plugin-archive> <minisig-file>"
        ));
    };
    let package = migration_mail::verify_archive(Path::new(&archive), Path::new(&signature))?;
    let outcome = migration_mail::execute(
        Path::new(&profile),
        &package,
        &SnapshotControl::with_timeout(Duration::from_secs(900)),
    )?;
    match outcome {
        MailUpgradeOutcome::Migrated => println!("Mail data migrated"),
        MailUpgradeOutcome::AlreadyMigrated => println!("Mail data already migrated"),
    }
    Ok(())
}
