use crate::sockscap::paths;
use std::path::PathBuf;
use tauri::AppHandle;

/// Poll the bundled privileged files until each is openable for writing (i.e.
/// no longer locked by a live driver/helper), or a short deadline elapses.
///
/// Only the install-directory copies matter: those are what the updater
/// overwrites. When runtime staging is active the loaded driver's `.sys` lives
/// under app-data instead, so the install-directory copy is never locked and
/// this returns on the first probe.
#[cfg(windows)]
pub(in crate::sockscap) async fn wait_for_privileged_files_unlocked(app: &AppHandle) {
    use std::time::{Duration, Instant};

    let mut files: Vec<PathBuf> = Vec::new();
    if let Some(dir) = paths::resolve_windivert_dir(app) {
        files.push(dir.join("WinDivert64.sys"));
        files.push(dir.join("WinDivert.dll"));
    }
    if let Ok(helper_exe) = paths::resolve_helper_exe(app) {
        files.push(helper_exe);
    }
    if let Some(xray_exe) = paths::resolve_xray_exe(app) {
        files.push(xray_exe);
    }
    files.retain(|p| p.is_file());
    if files.is_empty() {
        return;
    }

    let deadline = Instant::now() + Duration::from_secs(6);
    loop {
        let still_locked: Vec<&PathBuf> = files.iter().filter(|p| is_file_locked(p)).collect();
        if still_locked.is_empty() {
            tracing::info!("sockscap: privileged files released; safe to upgrade");
            return;
        }
        if Instant::now() >= deadline {
            tracing::warn!(
                "sockscap: {} privileged file(s) still locked after wait; \
                 the installer may prompt to retry/ignore: {:?}",
                still_locked.len(),
                still_locked
            );
            return;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

/// True when `path` cannot be opened for writing because something holds it with
/// a sharing violation (a loaded driver or running image). An unrelated failure
/// (access denied, not found) is treated as "not our lock" so we never wait on
/// something stopping the helper would not fix.
#[cfg(windows)]
pub(in crate::sockscap) fn is_file_locked(path: &std::path::Path) -> bool {
    const ERROR_SHARING_VIOLATION: i32 = 32;
    const ERROR_LOCK_VIOLATION: i32 = 33;
    // Open for write without truncation: probes the lock without altering bytes.
    match std::fs::OpenOptions::new().write(true).open(path) {
        Ok(_) => false,
        Err(e) => matches!(
            e.raw_os_error(),
            Some(ERROR_SHARING_VIOLATION) | Some(ERROR_LOCK_VIOLATION)
        ),
    }
}
