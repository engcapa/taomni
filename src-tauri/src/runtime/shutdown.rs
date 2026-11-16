//! Shared graceful preparation and idempotent final teardown.
use super::ApplicationRuntime;
use crate::state::AppState;
use tauri::Manager;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ExitAction {
    Quit,
    Restart,
}

pub(crate) async fn request(app: tauri::AppHandle, action: ExitAction) -> Result<(), String> {
    app.state::<crate::app_exit::ExitGate>()
        .run(
            async {
                // Backup needs live stores/services. No permanent stop until all
                // fallible cleanup has succeeded, so a refused exit can be retried.
                crate::backup::scheduler::prepare_exit(&app, action == ExitAction::Restart).await;
                crate::sockscap::prepare_for_exit(&app, app.state::<AppState>()).await?;
                crate::screenshot::wait_for_recovery_recording().await?;
                app.state::<ApplicationRuntime>()
                    .shutdown(&app.state::<AppState>())
                    .await;
                Ok(())
            },
            || {
                crate::webview_recovery::closing_all(&app);
                match action {
                    ExitAction::Quit => app.exit(0),
                    ExitAction::Restart => app.restart(),
                }
            },
        )
        .await
}

pub(crate) fn handle_exit_requested(
    app: &tauri::AppHandle,
    code: Option<i32>,
    api: &tauri::ExitRequestApi,
) {
    if app.state::<crate::app_exit::ExitGate>().is_committed() {
        return;
    }
    // Tauri cannot prevent its restart exit code; the backend restart command
    // prepares first. Direct process-plugin restarts still get final fallback.
    if code == Some(tauri::RESTART_EXIT_CODE) {
        return;
    }
    api.prevent_exit();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = request(app, ExitAction::Quit).await {
            tracing::warn!(%error, "Application remains open after refused exit");
        }
    });
}

pub(crate) fn final_exit(app: &tauri::AppHandle) {
    crate::viewer::shutdown();
    crate::screenshot::shutdown();
    if let (Some(runtime), Some(state)) = (
        app.try_state::<ApplicationRuntime>(),
        app.try_state::<AppState>(),
    ) {
        tauri::async_runtime::block_on(runtime.shutdown(&state));
        crate::sockscap::shutdown_on_exit(app, &state);
    }
}

pub(super) async fn stop_business_runtimes(state: &AppState) {
    // Listener shutdown is bounded; all remaining task owners still cancel.
    let _ = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        state.legacy.mobile.stop(),
    )
    .await;
    let runs = std::mem::take(&mut *state.core.agent.chat_runs.lock().await);
    for (_, run) in runs {
        run.stop().await;
    }
    let cc = std::mem::take(&mut *state.core.agent.cc_processes.lock().await);
    for (_, process) in cc {
        process.stop().await;
    }
    let codex = std::mem::take(&mut *state.core.agent.codex_processes.lock().await);
    for (_, process) in codex {
        process.stop().await;
    }
    let acp = std::mem::take(&mut *state.core.agent.acp_processes.lock().await);
    for (_, process) in acp {
        process.stop().await;
    }
    let media = std::mem::take(&mut *state.core.agent.acp_media_processes.lock().await);
    for (_, process) in media {
        process.stop().await;
    }
    state.core.workspace.dap.shutdown().await;
    state.core.workspace.lsp.shutdown().await;
    let terminals = std::mem::take(&mut *state.core.terminal.terminals.write().await);
    for (_, terminal) in terminals {
        match terminal {
            crate::terminal::ActiveTerminal::Local { child, .. } => {
                if let Ok(mut child) = child.lock() {
                    let _ = child.kill();
                }
            }
            crate::terminal::ActiveTerminal::Ssh {
                forwards, handle, ..
            } => {
                for task in forwards.lock().await.drain(..) {
                    task.abort();
                }
                let _ = handle
                    .disconnect(russh::Disconnect::ByApplication, "Application exiting", "")
                    .await;
            }
        }
    }
    for transfer in state.core.files.transfers.read().await.values() {
        transfer.cancel();
    }
    state
        .core
        .files
        .read_handles
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clear();
    state
        .core
        .files
        .write_handles
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clear();
    let servers = std::mem::take(&mut *state.legacy.servers.running.lock().await);
    for (_, server) in servers {
        server.cancel.cancel();
        server.task.abort();
        if let Some(task) = server.auto_stop_task {
            task.abort();
        }
    }
    let tunnels = std::mem::take(&mut *state.core.tunnels.running.lock().await);
    for (_, tunnel) in tunnels {
        tunnel.task.abort();
        for bridge in tunnel.bridges.lock().await.drain(..) {
            bridge.abort();
        }
    }
    state
        .legacy
        .remote_desktop
        .vnc_sessions
        .write()
        .await
        .clear();
    for (_, session) in state
        .legacy
        .remote_desktop
        .rdp_sessions
        .write()
        .await
        .drain()
    {
        session.cancel.cancel();
    }
}
