#[cfg(windows)]
use super::privileged_files::wait_for_privileged_files_unlocked;
use super::teardown::full_teardown;
use crate::module_lock::ModuleLock;
use crate::sockscap::capture;
use crate::sockscap::data_dir;
use crate::sockscap::helper;
use crate::sockscap::orchestrator;
use crate::sockscap::recovery;
use crate::state::AppState;
use tauri::AppHandle;
use tauri::State;
use zeroize::Zeroizing;

/// Release SocksCap's OS capture state and every privileged file the updater is
/// about to overwrite. Linux/macOS need the network teardown; Windows also
/// needs the helper and WinDivert image files to become writable.
///
/// The lock the installer trips over is a kernel one: while SocksCap captures,
/// WinDivert is loaded and Windows keeps `WinDivert64.sys` locked until the last
/// handle to it closes and the driver unloads. `sockscap-helper.exe` and
/// `WinDivert.dll` are locked too, as the running helper's own image.
///
/// The NSIS installer *cannot* release these on a per-user (`currentUser`)
/// install: it runs unelevated, so its `taskkill /F` against the UAC-elevated
/// helper and its `sc stop WinDivert` both get Access Denied. The app can,
/// though — not by elevating itself, but by asking the helper (over the control
/// channel it already owns) to close its WinDivert handles and exit. Closing the
/// handles unloads the driver (freeing the `.sys`); exiting frees the exe/DLL.
#[tauri::command]
pub async fn sockscap_prepare_for_update(
    app: AppHandle,
    state: State<'_, AppState>,
    sudo_password: Option<String>,
) -> Result<(), String> {
    let owned_capture = state.sockscap.has_activation_lock();
    let recovery_required = matches!(
        state.sockscap.orch.read().await.status().phase,
        orchestrator::EnginePhase::RecoveryRequired
    );
    #[cfg(not(target_os = "linux"))]
    if recovery_required {
        return Err(
            "SocksCap network recovery is required before updating; use Recover network first"
                .into(),
        );
    }
    if !state.sockscap.has_activation_lock() {
        let lock = ModuleLock::try_acquire_for_app(
            &app,
            "sockscap",
            "global",
            "SocksCap update preparation",
        )?;
        state.sockscap.install_activation_lock(lock);
    }

    let journal_path = data_dir(&app).ok().map(|dir| recovery::journal_path(&dir));
    let dirty_journal = journal_path.as_deref().is_some_and(recovery::needs_repair);

    // A previous Linux process may have exited after installing nftables and
    // cgroups but before clearing its journal. The updater already has the old
    // binary and runtime available, so repair that narrowly-owned state here
    // instead of sending the user back to the SocksCap panel. Credentials are
    // accepted only for this call and are zeroized when it returns.
    #[cfg(target_os = "linux")]
    if should_recover_stale_capture_for_update(owned_capture, recovery_required, dirty_journal) {
        let sudo_password = sudo_password.map(Zeroizing::new);
        let sudo_pw = sudo_password.as_deref().map(|password| password.as_str());
        if let Err(error) = capture::recover_system(sudo_pw).await {
            let message = format!("automatic SocksCap recovery before updating failed: {error}");
            state
                .sockscap
                .orch
                .write()
                .await
                .set_recovery_required(&capture::capabilities().capture_backend, message.clone());
            state.sockscap.release_activation_lock();
            if sudo_pw.is_none() && linux_recovery_requires_elevation(&error) {
                return Err(format!("SOCKSCAP_UPDATE_SUDO_REQUIRED: {message}"));
            }
            return Err(message);
        }
        if let Some(journal) = journal_path.as_deref() {
            if let Err(error) = recovery::mark_clean_and_clear(journal) {
                let message = format!(
                    "SocksCap network recovery succeeded, but its journal could not be cleared before updating: {error}"
                );
                state.sockscap.orch.write().await.set_recovery_required(
                    &capture::capabilities().capture_backend,
                    message.clone(),
                );
                state.sockscap.release_activation_lock();
                return Err(message);
            }
        }
        state.sockscap.orch.write().await.force_idle();
        tracing::info!("sockscap: automatically recovered stale Linux state before update");
    }

    // Other platforms retain their existing explicit-recovery policy. Their
    // stale state cannot be safely repaired with a Linux sudo credential.
    #[cfg(not(target_os = "linux"))]
    if !owned_capture && dirty_journal {
        state.sockscap.release_activation_lock();
        return Err(
            "SocksCap recovery is required before updating; use Recover network first".into(),
        );
    }

    // 1) Stop capture before the installer or relaunch can terminate the
    //    process. The running handle retains the credential needed to remove
    //    Linux nftables/cgroups; macOS disables Redirector interception over IPC.
    let teardown_error = if owned_capture {
        full_teardown(&app, &state, true).await.err()
    } else {
        if let Some(manager) = state.sockscap.xray() {
            manager.shutdown_all().await;
        }
        None
    };

    // 2) Ask the elevated helper to exit, freeing `sockscap-helper.exe` and
    //    `WinDivert.dll`. Reuses the same shutdown path as the Stop button.
    let helper_error = helper::sockscap_helper_stop(state.clone())
        .await
        .err()
        .map(|error| format!("SocksCap helper shutdown failed: {error}"));

    // 3) The driver unload is asynchronous, so poll until the files the installer
    //    overwrites are actually releasable (or a short deadline passes).
    #[cfg(windows)]
    wait_for_privileged_files_unlocked(&app).await;

    let mut errors = Vec::new();
    if let Some(error) = teardown_error {
        tracing::warn!("sockscap: prepare-for-update teardown incomplete: {error}");
        errors.push(error);
    }
    if let Some(error) = helper_error {
        tracing::warn!("sockscap: prepare-for-update helper stop failed: {error}");
        errors.push(error);
    }
    if errors.is_empty() {
        state.sockscap.release_activation_lock();
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

#[cfg(target_os = "linux")]
pub(in crate::sockscap) fn should_recover_stale_capture_for_update(
    owned_capture: bool,
    recovery_required: bool,
    dirty_journal: bool,
) -> bool {
    !owned_capture && (recovery_required || dirty_journal)
}

#[cfg(target_os = "linux")]
pub(in crate::sockscap) fn linux_recovery_requires_elevation(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    error.contains("cap_net_admin")
        || error.contains("linux capture requires")
        || error.contains("linux cgroup cleanup requires root")
        || error.contains("permission to manage cgroup v2")
}
