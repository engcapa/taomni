//! Offline MFA migration entry point. The master password arrives via stdin.
use std::{
    ffi::OsString,
    io::{self, IsTerminal, Read},
    path::PathBuf,
    time::Duration,
};

use taomni_sqlite_snapshot::SnapshotControl;
use zeroize::Zeroizing;

use crate::plugin::migration_execute_mfa::{self, MfaUpgradeOutcome};

pub const MFA_MAINTENANCE_ARG: &str = "--migrate-mfa";
pub(super) const MAX_PASSWORD_BYTES: usize = 1024 * 1024;

pub fn run_mfa_maintenance(args: impl IntoIterator<Item = OsString>) -> Result<(), String> {
    let mut args = args.into_iter();
    let (Some(profile), Some(archive), Some(signature), None) =
        (args.next(), args.next(), args.next(), args.next())
    else {
        return Err(format!(
            "Usage: Taomni {MFA_MAINTENANCE_ARG} <profile> <plugin-archive> <minisig-file>"
        ));
    };
    let input = io::stdin();
    if input.is_terminal() {
        return Err("Provide the original Vault password over a private stdin pipe".into());
    }
    let password = read_limited(input.lock(), MAX_PASSWORD_BYTES, "Vault password")?;
    let package = migration_execute_mfa::verify_archive_with_sidecar(
        &PathBuf::from(archive),
        &PathBuf::from(signature),
    )?;
    let outcome = migration_execute_mfa::execute(
        &PathBuf::from(profile),
        &package,
        utf8(&password)?,
        &SnapshotControl::with_timeout(Duration::from_secs(300)),
    )?;
    match outcome {
        MfaUpgradeOutcome::Migrated => println!("MFA data migrated"),
        MfaUpgradeOutcome::AlreadyMigrated => println!("MFA data already migrated"),
    }
    Ok(())
}

pub(super) fn read_limited(
    reader: impl Read,
    limit: usize,
    name: &str,
) -> Result<Zeroizing<Vec<u8>>, String> {
    // Reserve the complete bound so growing the buffer cannot leave behind
    // old allocations containing the password.
    let mut bytes = Zeroizing::new(Vec::with_capacity(limit + 1));
    reader
        .take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Could not read {name}: {error}"))?;
    if bytes.len() > limit {
        return Err(format!("{name} is too large"));
    }
    Ok(bytes)
}

pub(super) fn utf8(bytes: &[u8]) -> Result<&str, String> {
    std::str::from_utf8(bytes).map_err(|_| "Maintenance input is not UTF-8".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maintenance_input_preserves_password_bytes_and_bounds_reads() {
        let input = b" exact password\n ";
        let secret = read_limited(input.as_slice(), input.len(), "test input").unwrap();
        assert_eq!(utf8(&secret).unwrap().as_bytes(), input);
        assert!(read_limited(input.as_slice(), input.len() - 1, "test input").is_err());
        assert!(utf8(&[0xff]).is_err());
    }
}
