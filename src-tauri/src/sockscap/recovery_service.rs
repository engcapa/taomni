use super::*;

#[tauri::command]
pub async fn sockscap_stop(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<SocksCapStatus, String> {
    if !state.sockscap.has_activation_lock() {
        let orch = state.sockscap.orch.read().await;
        return Ok(orch.status());
    }
    full_teardown(&app, &state, true).await?;
    state.sockscap.release_activation_lock();
    let orch = state.sockscap.orch.read().await;
    Ok(orch.status())
}

/// Gracefully release capture state owned by this process before the app exits.
///
/// The final [`tauri::RunEvent::Exit`] callback is synchronous, so Linux and
/// macOS teardown must happen while the async runtime and the stored sudo
/// credential are still available. If teardown fails, the exit command returns
/// an error and the UI keeps the process alive so the user can retry or Recover.
pub async fn prepare_for_exit(app: &AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let owns_capture = state.sockscap.has_activation_lock();
    let recovery_required = matches!(
        state.sockscap.orch.read().await.status().phase,
        orchestrator::EnginePhase::RecoveryRequired
    );
    // A dirty journal discovered by boot recovery is durable evidence for the
    // next launch, but it is not an active capture owned by this process. In
    // that state keeping Taomni open cannot make the network safer and can trap
    // an offline user in an unquittable app. Still block when this process owns
    // the capture lock: that path has live state and must finish teardown first.
    if should_block_exit_for_recovery(recovery_required, owns_capture) {
        return Err(
            "SocksCap network recovery is required before Taomni can exit safely; use Recover network first"
                .into(),
        );
    }
    let mut errors = Vec::new();

    if owns_capture {
        if let Err(error) = full_teardown(app, &state, true).await {
            errors.push(error);
        }
    } else if let Some(manager) = state.sockscap.xray() {
        // Core probes can exist without an active OS-capture lock.
        manager.shutdown_all().await;
    }

    if let Err(error) = helper::sockscap_helper_stop(state.clone()).await {
        errors.push(format!("SocksCap helper shutdown failed: {error}"));
    }

    if errors.is_empty() {
        if owns_capture {
            state.sockscap.release_activation_lock();
        }
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

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
pub(super) fn should_recover_stale_capture_for_update(
    owned_capture: bool,
    recovery_required: bool,
    dirty_journal: bool,
) -> bool {
    !owned_capture && (recovery_required || dirty_journal)
}

#[cfg(target_os = "linux")]
pub(super) fn linux_recovery_requires_elevation(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    error.contains("cap_net_admin")
        || error.contains("linux capture requires")
        || error.contains("linux cgroup cleanup requires root")
        || error.contains("permission to manage cgroup v2")
}

/// Poll the bundled privileged files until each is openable for writing (i.e.
/// no longer locked by a live driver/helper), or a short deadline elapses.
///
/// Only the install-directory copies matter: those are what the updater
/// overwrites. When runtime staging is active the loaded driver's `.sys` lives
/// under app-data instead, so the install-directory copy is never locked and
/// this returns on the first probe.
#[cfg(windows)]
pub(super) async fn wait_for_privileged_files_unlocked(app: &AppHandle) {
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
pub(super) fn is_file_locked(path: &std::path::Path) -> bool {
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

#[tauri::command]
pub async fn sockscap_recover(
    app: AppHandle,
    state: State<'_, AppState>,
    sudo_password: Option<String>,
) -> Result<(), String> {
    let mut acquired_recovery_lock = false;
    if !state.sockscap.has_activation_lock() {
        let lock =
            ModuleLock::try_acquire_for_app(&app, "sockscap", "global", "SocksCap recovery")?;
        state.sockscap.install_activation_lock(lock);
        acquired_recovery_lock = true;
    }

    // Even if stopping the active session was incomplete, recovery gets one
    // more independent chance to remove the platform-owned state.
    let teardown_error = full_teardown(&app, &state, false).await.err();
    #[cfg(target_os = "macos")]
    let stale_runtime_clean = {
        let sockets_clean = match redirector::cleanup_stale_sockets() {
            Ok(_) => true,
            Err(error) => {
                tracing::warn!("sockscap: Recover stale Redirector socket cleanup failed: {error}");
                false
            }
        };
        let launchers_clean = match redirector::cleanup_stale_launchers().await {
            Ok(_) => true,
            Err(error) => {
                tracing::warn!(
                    "sockscap: Recover stale Redirector launcher cleanup failed: {error}"
                );
                false
            }
        };
        sockets_clean && launchers_clean
    };

    #[cfg(target_os = "macos")]
    let pending_approval_journal = data_dir(&app)
        .ok()
        .map(|dir| recovery::journal_path(&dir))
        .filter(|journal| {
            recovery::read_journal(journal)
                .as_ref()
                .is_some_and(pending_approval_never_recorded_scope)
        });

    #[cfg(target_os = "macos")]
    if teardown_error.is_none()
        && stale_runtime_clean
        && matches!(
            redirector::installer::system_extension_state(),
            redirector::installer::RedirectorSystemExtensionState::WaitingForUser
        )
        && pending_approval_journal.is_some()
    {
        let journal = pending_approval_journal.expect("checked above");
        if let Err(error) = recovery::mark_clean_and_clear(&journal) {
            let message = format!(
                "Redirector never applied capture while System Extension approval was pending, but its journal could not be cleared: {error}"
            );
            state
                .sockscap
                .orch
                .write()
                .await
                .set_recovery_required("mitmproxy-redirector", message.clone());
            state.sockscap.release_activation_lock();
            return Err(message);
        }
        state.sockscap.orch.write().await.force_idle();
        state.sockscap.release_activation_lock();
        tracing::info!(
            "sockscap: Recover cleared an aborted first-use approval attempt without starting another launcher"
        );
        return Ok(());
    }
    let sudo_password = sudo_password.map(Zeroizing::new);
    let sudo_pw = sudo_password.as_deref().map(|password| password.as_str());
    match capture::recover_system(sudo_pw).await {
        Ok(needs_elevation) => {
            // Queue anything only an elevated process can kill; the next Start
            // hands the list to the helper it launches under UAC.
            queue_reap(&state, &needs_elevation);
            #[cfg(target_os = "macos")]
            if let Ok(dir) = data_dir(&app) {
                if let Err(error) = recovery::mark_clean_and_clear(&recovery::journal_path(&dir)) {
                    let message = format!(
                        "network recovery succeeded, but the durable recovery journal could not be cleared: {error}"
                    );
                    state.sockscap.orch.write().await.set_recovery_required(
                        &capture::capabilities().capture_backend,
                        message.clone(),
                    );
                    if acquired_recovery_lock {
                        state.sockscap.release_activation_lock();
                    }
                    return Err(message);
                }
            }
            #[cfg(not(target_os = "macos"))]
            if let Ok(dir) = data_dir(&app) {
                let _ = recovery::mark_clean_and_clear(&recovery::journal_path(&dir));
            }
            state.sockscap.orch.write().await.force_idle();
            if let Some(error) = teardown_error {
                tracing::info!("sockscap: Recover repaired incomplete teardown: {error}");
            }
            if !needs_elevation.is_empty() {
                tracing::warn!(
                    "sockscap: {} helper process(es) need Administrator; they will be reaped on the next Start",
                    needs_elevation.len()
                );
            }
            state.sockscap.release_activation_lock();
            Ok(())
        }
        Err(recovery_error) => {
            let message = match teardown_error {
                Some(teardown_error) => {
                    format!("teardown failed: {teardown_error}; recovery failed: {recovery_error}")
                }
                None => format!("recovery failed: {recovery_error}"),
            };
            let backend = capture::capabilities().capture_backend;
            state
                .sockscap
                .orch
                .write()
                .await
                .set_recovery_required(&backend, message.clone());
            // A lock acquired only to serialize this Recover attempt must not
            // turn a failed recovery into apparent ownership of live capture.
            // The durable journal remains dirty and another attempt (or the
            // next launch) can safely reacquire the module lock.
            if acquired_recovery_lock {
                state.sockscap.release_activation_lock();
            }
            Err(message)
        }
    }
}

pub(super) fn should_block_exit_for_recovery(recovery_required: bool, owns_capture: bool) -> bool {
    recovery_required && owns_capture
}

#[cfg(target_os = "macos")]
pub(super) fn pending_approval_never_recorded_scope(journal: &recovery::RecoveryJournal) -> bool {
    matches!(journal.phase, recovery::RecoveryPhase::Preparing)
        && journal.scope_hash.is_none()
        && journal.bridge_pid.is_none()
        && journal.provider_pid.is_none()
}

/// Thorough capture teardown:
/// 1) Stop WinDivert NETWORK capture in the elevated helper (with timeout)
/// 2) Stop local relay accept loops (IPv4+IPv6 wake + abort fallback)
/// 3) Stop DNS refresher and clear relay context. The caller decides whether
///    it is safe to clear the recovery journal.
///
/// Does **not** kill the elevated helper process (avoids another UAC on next Start).
pub(super) async fn full_teardown(
    app: &AppHandle,
    state: &State<'_, AppState>,
    clear_journal: bool,
) -> Result<(), String> {
    use std::time::Duration;

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    let mut errors = Vec::new();
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    let errors: Vec<String> = Vec::new();

    // --- 1) Helper capture_stop (blocking RPC) off the async runtime ----------
    let sess = state
        .sockscap
        .helper
        .inner
        .lock()
        .ok()
        .and_then(|g| g.as_ref().cloned());
    if let Some(sess) = sess {
        let stop_rpc = tokio::task::spawn_blocking(move || helper::capture_stop(&sess));
        match tokio::time::timeout(Duration::from_secs(4), stop_rpc).await {
            Ok(Ok(Ok(()))) => {
                tracing::info!("sockscap: helper capture_stop ok");
            }
            Ok(Ok(Err(e))) => {
                tracing::warn!("sockscap: helper capture_stop error: {e}");
            }
            Ok(Err(e)) => {
                tracing::warn!("sockscap: helper capture_stop join error: {e}");
            }
            Err(_) => {
                tracing::warn!(
                    "sockscap: helper capture_stop timed out after 4s (WinDivert threads may still be exiting)"
                );
            }
        }
    }

    // Stop Linux xray health monitoring before cgroup cleanup. A respawn is a
    // child of Taomni and therefore inherits the global/mixed bypass cgroup;
    // allowing that during cleanup can repopulate the cgroup after its member
    // snapshot and make rmdir fail with EBUSY.
    #[cfg(target_os = "linux")]
    if let Some(mgr) = state.sockscap.xray() {
        mgr.shutdown_all().await;
    }

    // --- 2) Linux removes nft rules + restores cgroups before its relay stops -
    #[cfg(target_os = "linux")]
    let retryable_linux_capture = {
        let mut linux_capture = {
            let mut orch = state.sockscap.orch.write().await;
            orch.take_linux_capture_for_stop()
        };
        if let Some(capture) = linux_capture.as_mut() {
            if let Err(error) = capture.stop().await {
                tracing::warn!("sockscap: Linux capture teardown error: {error}");
                errors.push(format!("Linux capture teardown failed: {error}"));
            } else {
                linux_capture = None;
            }
        }

        // A partially-cleaned handle retains the original cgroup mappings so
        // Recover in this same process can retry safely.
        linux_capture
    };

    // --- 2b) macOS first sends Redirector's inert scope, then closes IPC ------
    #[cfg(target_os = "macos")]
    {
        if let Ok(dir) = data_dir(app) {
            let journal = recovery::journal_path(&dir);
            if recovery::needs_repair(&journal) {
                if let Err(error) =
                    recovery::update_phase_durable(&journal, recovery::RecoveryPhase::Stopping)
                {
                    tracing::warn!(
                        "sockscap: could not persist macOS Stopping journal phase: {error}"
                    );
                }
            }
        }
        let macos_capture = {
            let mut orch = state.sockscap.orch.write().await;
            orch.take_macos_capture_for_stop()
        };
        if let Some(capture) = macos_capture {
            if let Err(error) = capture.stop().await {
                tracing::warn!("sockscap: macOS capture teardown error: {error}");
                errors.push(format!("macOS capture teardown failed: {error}"));
            }
        }
    }

    // --- 3) Take any platform relay without holding write lock during await --
    let relay = {
        let mut orch = state.sockscap.orch.write().await;
        orch.take_relay_for_stop()
    };
    if let Some(relay) = relay {
        // Internal: dual-stack wake + 800ms abort fallback.
        relay.stop().await;
    }

    // --- 3b) Stop all xray cores (all platforms). Their node connections are
    //         now unnecessary; leaving them would leak processes on Stop.
    #[cfg(not(target_os = "linux"))]
    if let Some(mgr) = state.sockscap.xray() {
        mgr.shutdown_all().await;
    }

    // --- 4) Finish engine state + DNS + journal ------------------------------
    {
        let mut orch = state.sockscap.orch.write().await;
        orch.finish_stop();
        if !errors.is_empty() {
            orch.set_recovery_required(&capture::capabilities().capture_backend, errors.join("; "));
        }
        #[cfg(target_os = "linux")]
        if let Some(capture) = retryable_linux_capture {
            orch.set_linux_capture(capture);
        }
    }
    if errors.is_empty() {
        if clear_journal {
            #[cfg(target_os = "macos")]
            if let Ok(dir) = data_dir(app) {
                if let Err(error) = recovery::mark_clean_and_clear(&recovery::journal_path(&dir)) {
                    let message = format!(
                        "capture stopped, but the recovery journal could not be cleared: {error}"
                    );
                    state.sockscap.orch.write().await.set_recovery_required(
                        &capture::capabilities().capture_backend,
                        message.clone(),
                    );
                    return Err(message);
                }
            }
            #[cfg(not(target_os = "macos"))]
            if let Ok(dir) = data_dir(app) {
                let _ = recovery::mark_clean_and_clear(&recovery::journal_path(&dir));
            }
        }
        tracing::info!("sockscap: teardown complete");
        Ok(())
    } else {
        let error = errors.join("; ");
        tracing::warn!("sockscap: teardown incomplete; Recover is required: {error}");
        Err(error)
    }
}

/// App-exit hook (blocking): cleanly stop the elevated helper's WinDivert
/// capture and shut the helper down, then clear the recovery journal. Called
/// from the Tauri `RunEvent::Exit` handler so a normal quit does not leave an
/// elevated helper + loaded WinDivert driver behind. The helper's own
/// parent-death watchdog is the backstop for crash/kill paths.
///
/// Runs synchronously (no async runtime is guaranteed at exit) and is
/// best-effort: any RPC error is logged, and the journal is only cleared when
/// the helper confirmed capture stopped (so a failure still triggers
/// `boot_repair` on the next launch).
pub fn shutdown_on_exit(app: &AppHandle, state: &AppState) {
    // Kill any xray-core sidecars first (all platforms). Best-effort, sync:
    // start_kill without reaping, since no async runtime is guaranteed at exit.
    // kill_on_drop is the further backstop for a hard crash.
    if let Some(mgr) = state.sockscap.xray() {
        mgr.shutdown_all_blocking();
    }

    let sess = state
        .sockscap
        .helper
        .inner
        .lock()
        .ok()
        .and_then(|g| g.as_ref().cloned());
    let Some(sess) = sess else {
        // No helper (e.g. Linux, or capture never started). Nothing elevated
        // to reap here; leave any dirty journal for boot_repair.
        return;
    };

    let stopped = match helper::capture_stop(&sess) {
        Ok(()) => {
            tracing::info!("sockscap: exit — helper capture_stop ok");
            true
        }
        Err(e) => {
            tracing::warn!("sockscap: exit — helper capture_stop failed: {e}");
            false
        }
    };
    // Ask the helper process to exit so it and the WinDivert driver go away.
    if let Err(e) = helper::send_json(&sess, serde_json::json!({ "cmd": "shutdown" })) {
        tracing::warn!("sockscap: exit — helper shutdown RPC failed: {e}");
    }
    // The helper removes its own ready file as it exits, but do it here too:
    // if the shutdown RPC never landed, the stale file would otherwise advertise
    // a helper that is gone (or wedged) to the next launch's boot repair.
    sess.remove_ready_file();

    if stopped {
        if let Ok(dir) = data_dir(app) {
            let _ = recovery::mark_clean_and_clear(&recovery::journal_path(&dir));
        }
    }
}

pub(super) fn read_ready_files(dir: &std::path::Path) -> Vec<StaleReadyFile> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let is_ready = path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with("helper-ready-") && n.ends_with(".json"));
        if !is_ready {
            continue;
        }
        let (mut pid, mut parent_pid) = (None, None);
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                pid = v.get("pid").and_then(|x| x.as_u64()).map(|n| n as u32);
                parent_pid = v
                    .get("parentPid")
                    .and_then(|x| x.as_u64())
                    .map(|n| n as u32);
            }
        }
        out.push(StaleReadyFile {
            path,
            pid,
            parent_pid,
        });
    }
    out
}

/// Boot-time hook: reap helpers stranded by a previous run and repair any
/// half-installed OS capture state.
///
/// Two things happen here that did not before.
///
/// First, ready files are actually inspected. They were written and never read
/// back, so a helper stranded by a crash (or by a build with no exit hook at
/// all) was invisible: it kept diverting every outbound packet on the machine
/// toward a relay port that no longer existed, and contested the driver handle
/// with the next session. A ready file is now classified as: the pid is gone or
/// belongs to something else (delete the file); its owning app is still running
/// (leave it alone — it belongs to a live instance, which matters when two
/// copies of Taomni are open); or the owner is gone and the helper is not
/// (an orphan: record its pid and take ownership of reaping it).
///
/// Second, orphans that cannot be terminated from here — the normal case, since
/// they are elevated and this process is not — are queued for the next helper
/// launch, which runs under UAC. Nothing else in the system can do it.
pub async fn boot_repair(app: &AppHandle, state: &AppState) {
    #[cfg(target_os = "macos")]
    let _ready = RecoveryReadyGuard(&state.sockscap);

    // Another live instance may own the dirty journal. Never repair global
    // network state underneath its active capture session.
    let _repair_lock =
        match ModuleLock::try_acquire_for_app(app, "sockscap", "global", "SocksCap recovery") {
            Ok(lock) => lock,
            Err(error) => {
                tracing::info!("sockscap: boot repair skipped: {error}");
                return;
            }
        };

    let Ok(dir) = data_dir(app) else {
        return;
    };

    #[cfg(target_os = "macos")]
    let stale_sockets_clean = match redirector::cleanup_stale_sockets() {
        Ok(count) if count > 0 => {
            tracing::info!(count, "sockscap: removed stale Redirector Unix sockets");
            true
        }
        Ok(_) => true,
        Err(error) => {
            tracing::warn!("sockscap: stale Redirector socket cleanup failed: {error}");
            false
        }
    };

    #[cfg(target_os = "macos")]
    let stale_launchers_clean = match redirector::cleanup_stale_launchers().await {
        Ok(count) if count > 0 => {
            tracing::warn!(
                count,
                "sockscap: reaped stale Redirector approval launchers"
            );
            true
        }
        Ok(_) => true,
        Err(error) => {
            tracing::warn!("sockscap: stale Redirector launcher cleanup failed: {error}");
            false
        }
    };

    let mut orphans: Vec<u32> = Vec::new();
    for ready in read_ready_files(&dir) {
        let alive_helper = ready.pid.is_some_and(|pid| {
            process::process_image_name(pid).as_deref() == Some(capture::HELPER_IMAGE_NAME)
        });
        if !alive_helper {
            tracing::info!(
                "sockscap: removing stale ready file {} (helper pid {:?} is gone)",
                ready.path.display(),
                ready.pid
            );
            let _ = std::fs::remove_file(&ready.path);
            continue;
        }
        // A live owner means this helper belongs to a running instance.
        if ready
            .parent_pid
            .is_some_and(|ppid| process::process_image_name(ppid).is_some())
        {
            tracing::info!(
                "sockscap: helper pid {:?} still owned by a running instance; leaving it",
                ready.pid
            );
            continue;
        }
        if let Some(pid) = ready.pid {
            tracing::warn!("sockscap: orphaned elevated helper pid {pid} — scheduling reap");
            orphans.push(pid);
            let _ = std::fs::remove_file(&ready.path);
        }
    }

    let journal_path = recovery::journal_path(&dir);
    let dirty = recovery::needs_repair(&journal_path);
    if !dirty && orphans.is_empty() {
        return;
    }

    if dirty {
        tracing::warn!("sockscap: dirty recovery journal — repairing network state");
        if let Some(j) = recovery::read_journal(&journal_path) {
            tracing::warn!(
                "sockscap: dirty journal pid={} backend={} relay={:?} helper={:?}",
                j.pid,
                j.capture_backend,
                j.relay_port,
                j.helper_port
            );
        }
    }

    // If macOS is still waiting for first-use approval, the System Extension
    // is not enabled and cannot have installed a Provider scope. A Preparing
    // journal with no recorded bridge/provider/scope is therefore an aborted
    // approval attempt, not residual capture. Once its dead sockets and exact
    // coordinator processes are gone, clear it without launching another
    // coordinator that would only wait for the same approval again.
    #[cfg(target_os = "macos")]
    if dirty
        && stale_sockets_clean
        && stale_launchers_clean
        && matches!(
            redirector::installer::system_extension_state(),
            redirector::installer::RedirectorSystemExtensionState::WaitingForUser
        )
        && recovery::read_journal(&journal_path)
            .as_ref()
            .is_some_and(pending_approval_never_recorded_scope)
    {
        match recovery::mark_clean_and_clear(&journal_path) {
            Ok(()) => {
                tracing::info!(
                    "sockscap: cleared aborted first-use approval journal; waiting for System Settings approval"
                );
                state.sockscap.orch.write().await.force_idle();
            }
            Err(error) => {
                state.sockscap.orch.write().await.set_recovery_required(
                    "mitmproxy-redirector",
                    format!(
                        "Redirector never applied capture while System Extension approval was pending, but its journal could not be cleared: {error}"
                    ),
                );
            }
        }
        return;
    }

    // The previous helper cannot be contacted without its token, so recovery
    // terminates what it can and reports what needs elevation.
    match capture::recover_system(None).await {
        Ok(needs_elevation) => {
            for pid in needs_elevation {
                if !orphans.contains(&pid) {
                    orphans.push(pid);
                }
            }
        }
        Err(e) => {
            // Leave the journal dirty so a later boot retries instead of falsely
            // declaring potentially-live nftables/cgroup state recovered.
            tracing::warn!("sockscap: boot recover failed; leaving journal dirty: {e}");
            queue_reap(state, &orphans);
            #[cfg(target_os = "macos")]
            state.sockscap.orch.write().await.set_recovery_required(
                "mitmproxy-redirector",
                format!("macOS Redirector recovery failed: {e}"),
            );
            return;
        }
    }

    queue_reap(state, &orphans);
    if orphans.is_empty() {
        #[cfg(target_os = "macos")]
        match recovery::mark_clean_and_clear(&journal_path) {
            Ok(()) => tracing::info!("sockscap: recovery complete"),
            Err(error) => {
                tracing::warn!("sockscap: recovery journal cleanup failed: {error}");
                #[cfg(target_os = "macos")]
                state.sockscap.orch.write().await.set_recovery_required(
                    "mitmproxy-redirector",
                    format!(
                        "macOS network recovery succeeded, but journal cleanup failed: {error}"
                    ),
                );
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = recovery::mark_clean_and_clear(&journal_path);
            tracing::info!("sockscap: recovery complete");
        }
    } else {
        // Do not declare success while an elevated orphan is still diverting
        // packets. The journal stays dirty until a helper launch reaps it.
        let backend = capture::capabilities().capture_backend;
        let message = format!(
            "{} orphaned elevated helper process(es) from a previous run need Administrator to \
             clean up; they will be reaped when you next Start SocksCap (accept the UAC prompt)",
            orphans.len()
        );
        tracing::warn!("sockscap: {message}");
        state
            .sockscap
            .orch
            .write()
            .await
            .set_recovery_required(&backend, message);
    }
}

pub(super) fn queue_reap(state: &AppState, pids: &[u32]) {
    if pids.is_empty() {
        return;
    }
    if let Ok(mut slot) = state.sockscap.pending_reap.lock() {
        for pid in pids {
            if !slot.contains(pid) {
                slot.push(*pid);
            }
        }
    }
}
