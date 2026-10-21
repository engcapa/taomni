use super::recovery::should_block_exit_for_recovery;
use super::teardown::full_teardown;
use crate::sockscap::helper;
use crate::sockscap::orchestrator;
use crate::sockscap::orchestrator::SocksCapStatus;
use crate::state::AppState;
use tauri::AppHandle;
use tauri::State;

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
