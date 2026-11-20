//! mitmproxy's signed macOS Redirector integration.
//!
//! Taomni treats Redirector as a pinned third-party capture engine. The
//! protobuf contract and scope compiler live here so the production backend and
//! tests share one implementation; no macOS system-proxy fallback exists.

pub use taomni_redirector::{bridge_protocol, ipc};
pub mod scope;

#[cfg(target_os = "macos")]
pub mod app_identity;
#[cfg(target_os = "macos")]
pub mod installer;
#[cfg(target_os = "macos")]
pub mod runtime;

use std::path::{Path, PathBuf};

#[cfg(target_os = "macos")]
use std::os::unix::fs::{FileTypeExt, MetadataExt};
#[cfg(target_os = "macos")]
use std::process::Command;

pub use taomni_redirector::{
    REDIRECTOR_EXTENSION_BUNDLE_ID, REDIRECTOR_EXTENSION_EXECUTABLE_SHA256, REDIRECTOR_TEAM_ID,
    REDIRECTOR_VERSION,
};

#[cfg(target_os = "macos")]
pub use taomni_redirector::identity::redirector_peer_pid;
#[cfg(target_os = "macos")]
use taomni_redirector::identity::{process_path, verify_sha256, verify_signature};

pub const REDIRECTOR_WHEEL_SHA256: &str =
    "63349d9b46514ca679547651f7c0548f9222892edfbcba087b82b3244fbae859";
pub const REDIRECTOR_BUNDLE_ID: &str = "org.mitmproxy.macos-redirector";
pub const REDIRECTOR_APP_PATH: &str = "/Applications/Mitmproxy Redirector.app";
pub const REDIRECTOR_EXECUTABLE_SHA256: &str =
    "fb154632717ac7780c2706757573f2352a769e07fef7db1e4ae22027d2e4bc7a";
pub const REDIRECTOR_APP_TAR_SHA256: &str =
    "b8ea49940489560bb76b231a064aa823cf3d3e8a0787eac4a456611f26c96a7f";
pub const REDIRECTOR_BUNDLE_VERSION: &str = "2.0";

pub fn installed_app_path() -> PathBuf {
    PathBuf::from(REDIRECTOR_APP_PATH)
}

pub fn installed_executable_path() -> PathBuf {
    installed_app_path()
        .join("Contents")
        .join("MacOS")
        .join("Mitmproxy Redirector")
}

pub fn installed_extension_path() -> PathBuf {
    installed_app_path()
        .join("Contents")
        .join("Library")
        .join("SystemExtensions")
        .join(format!("{REDIRECTOR_EXTENSION_BUNDLE_ID}.systemextension"))
}

pub fn installed_extension_executable_path() -> PathBuf {
    installed_extension_path()
        .join("Contents")
        .join("MacOS")
        .join(REDIRECTOR_EXTENSION_BUNDLE_ID)
}

pub fn is_installed() -> bool {
    verify_installed().is_ok()
}

pub fn is_redirector_executable(path: &Path) -> bool {
    path == installed_executable_path()
}

/// Remove only stale Taomni Redirector Unix sockets after the caller has
/// acquired the cross-process SocksCap lock. Regular files, foreign owners,
/// unexpected names, and sockets that still accept connections are preserved.
#[cfg(target_os = "macos")]
pub fn cleanup_stale_sockets() -> Result<usize, String> {
    let current_uid = unsafe { libc::geteuid() };
    let mut removed = 0usize;
    let entries = std::fs::read_dir("/tmp")
        .map_err(|error| format!("scan /tmp for stale Redirector sockets: {error}"))?;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if !name.starts_with("taomni-redirector-") || !name.ends_with(".sock") {
            continue;
        }
        let path = entry.path();
        let Ok(metadata) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if !metadata.file_type().is_socket() || metadata.uid() != current_uid {
            continue;
        }
        if std::os::unix::net::UnixStream::connect(&path).is_ok() {
            continue;
        }
        std::fs::remove_file(&path).map_err(|error| {
            format!("remove stale Redirector socket {}: {error}", path.display())
        })?;
        removed += 1;
    }
    Ok(removed)
}

/// Reap only orphaned Redirector coordinator apps launched by Taomni whose
/// private provider socket is already gone. The caller must hold the global
/// SocksCap module lock. Exact uid, executable path, argument shape, and socket
/// namespace checks keep the cleanup away from the System Extension Provider
/// and from independently launched processes.
#[cfg(target_os = "macos")]
pub async fn cleanup_stale_launchers() -> Result<usize, String> {
    let output = Command::new("/bin/ps")
        .args(["-ww", "-axo", "pid=,uid=,args="])
        .output()
        .map_err(|error| format!("enumerate stale Redirector launchers: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "enumerate stale Redirector launchers: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    let executable = installed_executable_path();
    let current_uid = unsafe { libc::geteuid() };
    let mut candidates = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| parse_launcher_process(line, current_uid, &executable))
        .filter(|(_, socket)| !socket.exists())
        .collect::<Vec<_>>();
    candidates.sort_by_key(|(pid, _)| *pid);
    candidates.dedup_by_key(|(pid, _)| *pid);

    let mut signalled = Vec::new();
    for (pid, socket) in candidates {
        // Revalidate the executable immediately before signalling to avoid a
        // stale process-list row ever targeting a reused pid.
        if process_path(pid).ok().as_deref() != Some(executable.as_path()) || socket.exists() {
            continue;
        }
        let result = unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) };
        if result == 0 {
            signalled.push(pid);
        } else {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                return Err(format!(
                    "terminate stale Redirector launcher pid {pid}: {error}"
                ));
            }
        }
    }

    let reaped = signalled.len();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        signalled.retain(|pid| process_path(*pid).ok().as_deref() == Some(executable.as_path()));
        if signalled.is_empty() || tokio::time::Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    for pid in &signalled {
        // A pending Swift continuation should normally exit on SIGTERM. Use a
        // final SIGKILL only for the same still-verified executable.
        if process_path(*pid).ok().as_deref() == Some(executable.as_path()) {
            let result = unsafe { libc::kill(*pid as libc::pid_t, libc::SIGKILL) };
            if result != 0 {
                let error = std::io::Error::last_os_error();
                if error.raw_os_error() != Some(libc::ESRCH) {
                    return Err(format!("kill stale Redirector launcher pid {pid}: {error}"));
                }
            }
        }
    }
    let kill_deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(1);
    loop {
        signalled.retain(|pid| process_path(*pid).ok().as_deref() == Some(executable.as_path()));
        if signalled.is_empty() {
            break;
        }
        if tokio::time::Instant::now() >= kill_deadline {
            return Err(format!(
                "stale Redirector launcher pid(s) did not exit: {:?}",
                signalled
            ));
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    Ok(reaped)
}

#[cfg(target_os = "macos")]
fn parse_launcher_process(
    line: &str,
    current_uid: libc::uid_t,
    executable: &Path,
) -> Option<(u32, PathBuf)> {
    let (pid, rest) = take_process_field(line.trim_start())?;
    let (uid, command) = take_process_field(rest.trim_start())?;
    if uid.parse::<libc::uid_t>().ok()? != current_uid {
        return None;
    }
    let pid = pid.parse::<u32>().ok()?;
    let executable = executable.to_str()?;
    let remainder = command.trim_start().strip_prefix(executable)?;
    if !remainder.chars().next().is_some_and(char::is_whitespace) {
        return None;
    }
    let socket = remainder.trim_start();
    if socket.is_empty() || socket.chars().any(char::is_whitespace) {
        return None;
    }
    let socket = PathBuf::from(socket);
    is_taomni_provider_socket(&socket).then_some((pid, socket))
}

#[cfg(target_os = "macos")]
fn take_process_field(value: &str) -> Option<(&str, &str)> {
    let split = value.find(char::is_whitespace)?;
    Some((&value[..split], &value[split..]))
}

#[cfg(target_os = "macos")]
fn is_taomni_provider_socket(path: &Path) -> bool {
    if path.parent() != Some(Path::new("/tmp")) {
        return false;
    }
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    (name.starts_with("taomni-redirector-provider-")
        || name.starts_with("taomni-redirector-recovery-provider-"))
        && name.ends_with(".sock")
}

/// Refuse lookalike/replaced apps at the well-known path. The exact executable
/// hashes pin v0.12.11, while codesign verifies the intact nested signature and
/// the Team/bundle identities establish the upstream publisher boundary.
#[cfg(target_os = "macos")]
pub fn verify_installed() -> Result<(), String> {
    verify_bundle(&installed_app_path())
}

#[cfg(target_os = "macos")]
pub(crate) fn verify_bundle(app: &Path) -> Result<(), String> {
    let executable = app.join("Contents/MacOS/Mitmproxy Redirector");
    let extension = app
        .join("Contents/Library/SystemExtensions")
        .join(format!("{REDIRECTOR_EXTENSION_BUNDLE_ID}.systemextension"));
    let extension_executable = extension
        .join("Contents/MacOS")
        .join(REDIRECTOR_EXTENSION_BUNDLE_ID);
    for path in [app, &executable, &extension, &extension_executable] {
        if !path.exists() {
            return Err(format!(
                "Mitmproxy Redirector {REDIRECTOR_VERSION} is not installed completely: {} is missing",
                path.display()
            ));
        }
    }

    verify_signature(app, REDIRECTOR_BUNDLE_ID)?;
    verify_signature(&extension, REDIRECTOR_EXTENSION_BUNDLE_ID)?;
    verify_sha256(&executable, REDIRECTOR_EXECUTABLE_SHA256)?;
    verify_sha256(
        &extension_executable,
        REDIRECTOR_EXTENSION_EXECUTABLE_SHA256,
    )?;
    verify_bundle_version(app)?;
    Ok(())
}

#[cfg(target_os = "macos")]
pub(crate) fn verify_publisher_identity(app: &Path) -> Result<(), String> {
    let extension = app
        .join("Contents/Library/SystemExtensions")
        .join(format!("{REDIRECTOR_EXTENSION_BUNDLE_ID}.systemextension"));
    verify_signature(app, REDIRECTOR_BUNDLE_ID)?;
    verify_signature(&extension, REDIRECTOR_EXTENSION_BUNDLE_ID)
}

#[cfg(not(target_os = "macos"))]
pub fn verify_installed() -> Result<(), String> {
    Err("Mitmproxy Redirector is only available on macOS".into())
}

#[cfg(target_os = "macos")]
fn verify_bundle_version(app: &Path) -> Result<(), String> {
    let info = plist::Value::from_file(app.join("Contents/Info.plist"))
        .map_err(|error| format!("read Redirector Info.plist: {error}"))?;
    let version = info
        .as_dictionary()
        .and_then(|dictionary| dictionary.get("CFBundleShortVersionString"))
        .and_then(plist::Value::as_string)
        .unwrap_or("");
    if version != REDIRECTOR_BUNDLE_VERSION {
        return Err(format!(
            "Mitmproxy Redirector bundle version mismatch: expected {REDIRECTOR_BUNDLE_VERSION}, found {version:?}"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installed_layout_keeps_upstream_app_intact() {
        assert_eq!(
            installed_executable_path(),
            PathBuf::from(
                "/Applications/Mitmproxy Redirector.app/Contents/MacOS/Mitmproxy Redirector"
            )
        );
        assert!(is_redirector_executable(&installed_executable_path()));
    }

    #[test]
    fn pinned_supply_chain_values_are_not_placeholders() {
        assert_eq!(REDIRECTOR_WHEEL_SHA256.len(), 64);
        assert_eq!(REDIRECTOR_EXECUTABLE_SHA256.len(), 64);
        assert_eq!(REDIRECTOR_EXTENSION_EXECUTABLE_SHA256.len(), 64);
        assert_eq!(REDIRECTOR_TEAM_ID.len(), 10);
        assert!(!REDIRECTOR_VERSION.is_empty());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn stale_launcher_parser_requires_exact_identity_and_socket_namespace() {
        let executable = installed_executable_path();
        let valid = format!(
            " 2059 501 {} /tmp/taomni-redirector-provider-384689e4563143f7a19bc9635e033314.sock",
            executable.display()
        );
        assert_eq!(
            parse_launcher_process(&valid, 501, &executable),
            Some((
                2059,
                PathBuf::from(
                    "/tmp/taomni-redirector-provider-384689e4563143f7a19bc9635e033314.sock"
                )
            ))
        );

        let foreign_uid = valid.replacen("501", "502", 1);
        assert!(parse_launcher_process(&foreign_uid, 501, &executable).is_none());
        let unrelated_socket = valid.replace("taomni-redirector-provider-", "unrelated-");
        assert!(parse_launcher_process(&unrelated_socket, 501, &executable).is_none());
        let extra_argument = format!("{valid} --unexpected");
        assert!(parse_launcher_process(&extra_argument, 501, &executable).is_none());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn installed_redirector_matches_the_pinned_signed_build_when_present() {
        if installed_app_path().exists() {
            verify_installed().unwrap();
        }
    }
}
