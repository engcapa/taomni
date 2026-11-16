//! Real kernel noexec refusal and an explicit executable alternative. Hosted only.
#![cfg(target_os = "linux")]
mod mfa_support;
mod support;

use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, Instant},
};
use taomni_host_gates::host::{HostProcess, HostProcessError};
use taomni_plugin_api::ErrorCode;
use taomni_plugin_services::OperationKind;

fn root(variable: &str, noexec: bool) -> tempfile::TempDir {
    let path = PathBuf::from(std::env::var_os(variable).expect("hosted mount fixture is required"));
    assert!(path.is_absolute() && path.canonicalize().unwrap() == path);
    assert_eq!(path_is_noexec(&path), noexec, "actual kernel mount policy");
    tempfile::tempdir_in(path).unwrap()
}

fn path_is_noexec(path: &Path) -> bool {
    use std::{ffi::CString, mem::MaybeUninit, os::unix::ffi::OsStrExt};
    let path = CString::new(path.as_os_str().as_bytes()).unwrap();
    let mut stat = MaybeUninit::<libc::statvfs>::uninit();
    assert_eq!(
        unsafe { libc::statvfs(path.as_ptr(), stat.as_mut_ptr()) },
        0
    );
    unsafe { stat.assume_init() }.f_flag & libc::ST_NOEXEC != 0
}

fn copy_host(source: &Path, destination: &Path) -> PathBuf {
    let path = destination.join(source.file_name().unwrap());
    fs::copy(source, &path).unwrap();
    assert_eq!(
        Sha256::digest(fs::read(source).unwrap()),
        Sha256::digest(fs::read(&path).unwrap())
    );
    path
}

fn start_hello(host: &Path) -> Result<HostProcess, HostProcessError> {
    HostProcess::start(
        "taomni-plugin-hello-plugin",
        "0.1.0",
        host,
        host.parent().unwrap(),
        &["hello/ping".into(), "plugin/enable".into()],
        &[],
        support::config(),
    )
}

#[test]
#[ignore = "kernel mount/process gate: execute only on GitHub hosted Linux"]
fn noexec_rejects_hello_and_real_mfa_before_handshake_without_mutating_code() {
    let directory = root("TAOMNI_NOEXEC_TEST_ROOT", true);
    let mfa = PathBuf::from(std::env::var_os("TAOMNI_MFA_PLUGIN_BIN").unwrap());
    for source in [support::hello(), mfa] {
        let host = copy_host(&source, directory.path());
        // Independent kernel oracle: execute permission bits alone are insufficient.
        let denied = Command::new(&host).spawn().unwrap_err();
        assert_eq!(denied.raw_os_error(), Some(libc::EACCES));
        for _ in 0..2 {
            let error = start_hello(&host).unwrap_err();
            assert!(matches!(error, HostProcessError::NoExec(_)));
            assert_eq!(error.rpc_code(), ErrorCode::PermissionDenied.as_i32());
            assert!(error.to_string().contains("MODULE_HOST_NOEXEC"));
            assert!(error.to_string().contains("XDG_DATA_HOME"));
        }
        assert_eq!(fs::read(&source).unwrap(), fs::read(&host).unwrap());
    }
    assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 2);
}

#[test]
#[ignore = "kernel mount/process gate: execute only on GitHub hosted Linux"]
fn the_same_hello_and_mfa_bytes_work_in_the_explicit_executable_directory() {
    let directory = root("TAOMNI_EXEC_TEST_ROOT", false);
    let hello = copy_host(&support::hello(), directory.path());
    let mut process = start_hello(&hello).unwrap();
    let ping = process.invoke("hello/ping", None).unwrap();
    assert_eq!(ping["pluginId"], "taomni-plugin-hello-plugin");
    assert_eq!(ping["enabled"], true);
    process
        .stop_confirmed(Instant::now() + Duration::from_secs(5))
        .unwrap();
    let source = PathBuf::from(std::env::var_os("TAOMNI_MFA_PLUGIN_BIN").unwrap());
    let mfa = copy_host(&source, directory.path());
    let mut harness = mfa_support::Harness::with_executable(&mfa);
    harness.initialize();
    harness.add();
    let codes = harness
        .call(
            OperationKind::ReadData,
            "mfa_codes",
            Some(serde_json::json!({})),
        )
        .unwrap();
    assert_eq!(codes[0]["code"], "755224");
    harness
        .process
        .stop_confirmed(Instant::now() + Duration::from_secs(5))
        .unwrap();
}
