//! Check the filesystem used for the verified host on every launch/restart.
//! Never copy code elsewhere or weaken an administrator's mount policy.
use super::HostProcessError;
use std::path::Path;

#[cfg(target_os = "linux")]
pub(super) fn check(host: &Path) -> Result<(), HostProcessError> {
    use std::{ffi::CString, mem::MaybeUninit, os::unix::ffi::OsStrExt};
    let path = CString::new(host.as_os_str().as_bytes()).map_err(|_| {
        HostProcessError::Spawn(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "plugin host path contains a NUL byte",
        ))
    })?;
    let mut stat = MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: path is NUL terminated and stat points to writable storage.
    if unsafe { libc::statvfs(path.as_ptr(), stat.as_mut_ptr()) } != 0 {
        return Err(HostProcessError::Spawn(std::io::Error::last_os_error()));
    }
    // SAFETY: a successful statvfs initialized every field.
    check_flags(host, unsafe { stat.assume_init() }.f_flag)
}

#[cfg(not(target_os = "linux"))]
pub(super) fn check(_host: &Path) -> Result<(), HostProcessError> {
    Ok(())
}

#[cfg(target_os = "linux")]
fn check_flags(host: &Path, flags: libc::c_ulong) -> Result<(), HostProcessError> {
    if flags & libc::ST_NOEXEC != 0 {
        Err(HostProcessError::NoExec(host.to_owned()))
    } else {
        Ok(())
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use taomni_plugin_api::ErrorCode;

    #[test]
    fn noexec_returns_a_stable_error_and_an_explicit_alternative() {
        let path = Path::new("/data/profile/plugins/mfa/versions/0.1.0/taomni-plugin-mfa");
        let error = check_flags(path, libc::ST_NOEXEC | libc::ST_NOSUID).unwrap_err();
        assert!(matches!(&error, HostProcessError::NoExec(actual) if actual == path));
        assert_eq!(error.rpc_code(), ErrorCode::PermissionDenied.as_i32());
        let message = error.to_string();
        for expected in [
            "MODULE_HOST_NOEXEC",
            "noexec",
            "XDG_DATA_HOME",
            "Close Taomni",
            "/data/profile/plugins/mfa",
        ] {
            assert!(message.contains(expected), "{message}");
        }
    }

    #[test]
    fn other_mount_policies_do_not_invent_an_execution_failure() {
        for flags in [0, libc::ST_RDONLY, libc::ST_NOSUID, libc::ST_NODEV] {
            assert!(check_flags(Path::new("/verified/host"), flags).is_ok());
        }
    }

    #[test]
    fn missing_host_preserves_the_underlying_filesystem_error() {
        let root = tempfile::tempdir().unwrap();
        assert!(
            matches!(check(&root.path().join("missing-host")), Err(HostProcessError::Spawn(error)) if error.kind() == std::io::ErrorKind::NotFound)
        );
    }
}
