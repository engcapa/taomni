use super::repair::queue_reap;
use super::teardown::full_teardown;
use crate::module_lock::ModuleLock;
use crate::sockscap::capture;
use crate::sockscap::data_dir;
use crate::sockscap::recovery;
use crate::sockscap::redirector;
use crate::state::AppState;
use tauri::AppHandle;
use tauri::State;
use zeroize::Zeroizing;

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

pub(in crate::sockscap) fn should_block_exit_for_recovery(
    recovery_required: bool,
    owns_capture: bool,
) -> bool {
    recovery_required && owns_capture
}

#[cfg(target_os = "macos")]
pub(in crate::sockscap) fn pending_approval_never_recorded_scope(
    journal: &recovery::RecoveryJournal,
) -> bool {
    matches!(journal.phase, recovery::RecoveryPhase::Preparing)
        && journal.scope_hash.is_none()
        && journal.bridge_pid.is_none()
        && journal.provider_pid.is_none()
}
