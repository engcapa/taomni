//! Handoff to a separate process after desktop shutdown releases the profile.
use std::{
    ffi::OsString,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    time::{Duration, Instant},
};

use taomni_profile_locks::WaitControl;
use taomni_sqlite_snapshot::SnapshotControl;
use tauri::Manager;
use zeroize::Zeroizing;

use super::mfa_maintenance::{MAX_PASSWORD_BYTES, read_limited, utf8};
use crate::{plugin::migration_execute_mfa, state::AppState};

pub const MFA_RESTART_HELPER_ARG: &str = "--complete-mfa-upgrade";
const RESULT_PREFIX: &str = "--mfa-upgrade-result=";

pub(crate) struct MfaRestart {
    child: Option<Child>,
    password: Zeroizing<String>,
}

/// The parent keeps stdin open until it exits. The child verifies the complete
/// frame after EOF and then acquires its own exclusive profile lease.
pub(super) struct ApprovedMfaRestart {
    _input: ChildStdin,
}

impl MfaRestart {
    pub(crate) fn prepare(
        app: &tauri::AppHandle,
        archive: PathBuf,
        signature: PathBuf,
        password: Zeroizing<String>,
    ) -> Result<Self, String> {
        if !archive.is_absolute() || !signature.is_absolute() {
            return Err("Choose a local module archive and detached signature file".into());
        }
        if password.is_empty() || password.len() > MAX_PASSWORD_BYTES {
            return Err(crate::vault::ERR_VAULT_PASSWORD_REQUIRED.into());
        }
        let state = app.state::<AppState>();
        let profile = &state.core.paths.data;
        let store = state
            .legacy
            .mfa
            .legacy_store()?
            .ok_or("MFA data is already migrated")?;
        if !store.path().is_file() {
            return Err("The profile has no legacy MFA database to migrate".into());
        }
        let package = migration_execute_mfa::verify_archive_with_sidecar(&archive, &signature)?;
        state.core.vault.check_migration_password(&password)?;
        let executable = tauri::process::current_binary(&app.env()).map_err(message)?;
        let child = Command::new(&executable)
            .arg(MFA_RESTART_HELPER_ARG)
            .arg(profile)
            .arg(archive)
            .arg(signature)
            .arg(package.archive_sha256())
            .arg(&executable)
            .args(
                std::env::args_os()
                    .skip(1)
                    .filter(|arg| !is_result_arg(arg)),
            )
            .stdin(Stdio::piped())
            .spawn()
            .map_err(message)?;
        Ok(Self {
            child: Some(child),
            password,
        })
    }

    pub(super) fn approve(mut self) -> Result<ApprovedMfaRestart, String> {
        let child = self
            .child
            .as_mut()
            .expect("upgrade helper starts with its input");
        let mut input = child
            .stdin
            .take()
            .ok_or("MFA upgrade input is unavailable")?;
        write_approval(&mut input, &self.password)?;
        // Leave the approved helper running while the parent exits normally.
        self.child.take();
        Ok(ApprovedMfaRestart { _input: input })
    }
}

impl Drop for MfaRestart {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

pub fn run_mfa_restart_helper(args: impl IntoIterator<Item = OsString>) -> Result<(), String> {
    let mut args = args.into_iter();
    let [
        Some(profile),
        Some(archive),
        Some(signature),
        Some(digest),
        Some(executable),
    ] = std::array::from_fn(|_| args.next())
    else {
        return Err("Missing MFA upgrade handoff arguments".into());
    };
    let executable = relaunch_executable(
        &std::env::current_exe().map_err(message)?,
        Path::new(&executable),
    )?;
    let Some(password) = read_approval(io::stdin().lock())? else {
        return Ok(());
    };
    let result = apply(
        &PathBuf::from(profile),
        &PathBuf::from(archive),
        &PathBuf::from(signature),
        &digest,
        &password,
    );
    drop(password);
    let status = if let Err(error) = result {
        eprintln!("MFA upgrade failed: {error}");
        "failed"
    } else {
        "complete"
    };
    Command::new(executable)
        .args(args)
        .arg(format!("{RESULT_PREFIX}{status}"))
        .stdin(Stdio::null())
        .spawn()
        .map_err(message)?;
    Ok(())
}

fn relaunch_executable(owned: &Path, requested: &Path) -> Result<PathBuf, String> {
    let owned = owned.canonicalize().map_err(message)?;
    let requested = requested.canonicalize().map_err(message)?;
    if requested != owned {
        return Err("MFA upgrade must relaunch its own Taomni executable".into());
    }
    Ok(owned)
}

fn apply(
    profile: &Path,
    archive: &Path,
    signature: &Path,
    digest: &OsString,
    password: &[u8],
) -> Result<(), String> {
    let package = migration_execute_mfa::verify_archive_with_sidecar(archive, signature)?;
    if digest.to_str() != Some(package.archive_sha256()) {
        return Err("The selected signed MFA archive changed before restart".into());
    }
    let wait = WaitControl::new(Instant::now() + Duration::from_secs(5), &|| false);
    migration_execute_mfa::execute_after_exit(
        profile,
        &package,
        utf8(password)?,
        &SnapshotControl::with_timeout(Duration::from_secs(300)),
        &wait,
    )?;
    Ok(())
}

fn write_approval(mut input: impl Write, password: &str) -> Result<(), String> {
    let length = u32::try_from(password.len())
        .map_err(message)?
        .to_le_bytes();
    input.write_all(&length).map_err(message)?;
    input.write_all(password.as_bytes()).map_err(message)
}

fn read_approval(input: impl Read) -> Result<Option<Zeroizing<Vec<u8>>>, String> {
    let mut bytes = read_limited(input, MAX_PASSWORD_BYTES + 4, "MFA upgrade approval")?;
    if bytes.is_empty() {
        return Ok(None);
    }
    let length = bytes.first_chunk::<4>().copied().map(u32::from_le_bytes);
    if length != u32::try_from(bytes.len().saturating_sub(4)).ok() || length == Some(0) {
        return Err("Incomplete MFA upgrade approval".into());
    }
    bytes.drain(..4);
    Ok(Some(bytes))
}

fn is_result_arg(arg: &std::ffi::OsStr) -> bool {
    arg.to_str()
        .is_some_and(|arg| arg.starts_with(RESULT_PREFIX))
}

pub(crate) fn last_result() -> Option<&'static str> {
    std::env::args_os()
        .filter_map(|arg| match arg.to_str()?.strip_prefix(RESULT_PREFIX)? {
            "complete" => Some("complete"),
            "failed" => Some("failed"),
            _ => None,
        })
        .last()
}

fn message(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upgrade_relaunch_requires_the_helpers_own_executable() {
        let directory = tempfile::tempdir().unwrap();
        let core = directory.path().join("taomni");
        let other = directory.path().join("other");
        std::fs::write(&core, b"Taomni candidate").unwrap();
        std::fs::write(&other, b"Taomni candidate").unwrap();
        assert_eq!(
            relaunch_executable(&core, &directory.path().join(".").join("taomni")).unwrap(),
            core.canonicalize().unwrap()
        );
        assert_eq!(
            relaunch_executable(&core, &other).unwrap_err(),
            "MFA upgrade must relaunch its own Taomni executable"
        );
    }

    #[test]
    fn cancelled_or_truncated_approval_cannot_start_mfa_upgrade() {
        assert!(read_approval([].as_slice()).unwrap().is_none());
        let mut frame = Vec::new();
        let password = " exact password\n ";
        write_approval(&mut frame, password).unwrap();
        for cut in 1..frame.len() {
            assert!(read_approval(&frame[..cut]).is_err());
        }
        assert_eq!(
            read_approval(frame.as_slice()).unwrap().unwrap().as_slice(),
            password.as_bytes()
        );
    }
}
