#[cfg(target_os = "macos")]
use super::recovery::pending_approval_never_recorded_scope;
use crate::module_lock::ModuleLock;
#[cfg(target_os = "macos")]
use crate::sockscap::RecoveryReadyGuard;
use crate::sockscap::StaleReadyFile;
use crate::sockscap::capture;
use crate::sockscap::data_dir;
use crate::sockscap::process;
use crate::sockscap::recovery;
use crate::sockscap::redirector;
use crate::state::AppState;
use tauri::AppHandle;

pub(in crate::sockscap) fn read_ready_files(dir: &std::path::Path) -> Vec<StaleReadyFile> {
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

pub(in crate::sockscap) fn queue_reap(state: &AppState, pids: &[u32]) {
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
