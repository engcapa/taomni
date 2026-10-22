use crate::sockscap::capture;
use crate::sockscap::data_dir;
use crate::sockscap::helper;
use crate::sockscap::linux_capture;
use crate::sockscap::macos_capture;
use crate::sockscap::recovery;
use crate::sockscap::relay;
use crate::state::AppState;
use tauri::AppHandle;
use tauri::State;

/// Thorough capture teardown:
/// 1) Stop WinDivert NETWORK capture in the elevated helper (with timeout)
/// 2) Stop local relay accept loops (IPv4+IPv6 wake + abort fallback)
/// 3) Stop DNS refresher and clear relay context. The caller decides whether
///    it is safe to clear the recovery journal.
///
/// Does **not** kill the elevated helper process (avoids another UAC on next Start).
pub(in crate::sockscap) async fn full_teardown(
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
