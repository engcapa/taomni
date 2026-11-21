//! Shared graceful preparation and idempotent final teardown.
use super::ApplicationRuntime;
use crate::state::AppState;
use tauri::Manager;

pub(crate) enum ExitAction {
    Quit,
    Restart,
    UpgradeMfa(super::mfa_restart::MfaRestart),
}

pub(crate) async fn request(app: tauri::AppHandle, action: ExitAction) -> Result<(), String> {
    let quiet = std::sync::Mutex::new(None);
    let restarting = !matches!(&action, ExitAction::Quit);
    let await_handoff = matches!(&action, ExitAction::UpgradeMfa(_));
    let (completion, finished) = tokio::sync::oneshot::channel();
    app.state::<crate::app_exit::ExitGate>()
        .run(
            async {
                // Backup needs live stores/services. No permanent stop until all
                // fallible cleanup has succeeded, so a refused exit can be retried.
                crate::backup::scheduler::prepare_exit(&app, restarting).await;
                crate::sockscap::prepare_for_exit(&app, app.state::<AppState>()).await?;
                crate::screenshot::wait_for_recovery_recording().await?;
                // Keep this reversible barrier through commit. Confirmation
                // failures reach the existing exit UI before other owners stop.
                let plugins = app.state::<AppState>().plugins.clone();
                let guard = tauri::async_runtime::spawn_blocking(move || plugins.quiesce())
                    .await.map_err(|error| error.to_string())?
                    .map_err(|error| error.to_string())?;
                *quiet.lock().expect("exit quiescence poisoned") = Some(guard);
                Ok(())
            },
            || {
                // Commit owns teardown independently of the caller's IPC future.
                // A renderer reload/cancellation cannot reset a partly stopped app.
                let app = app.clone();
                let guard = quiet.lock().expect("exit quiescence poisoned").take();
                tauri::async_runtime::spawn(async move {
                    let _guard = guard;
                    if let Err(error) = app.state::<ApplicationRuntime>()
                        .shutdown(&app.state::<AppState>())
                        .await
                    {
                        tracing::warn!(%error, "Application remains open after unconfirmed plugin teardown");
                        app.state::<crate::app_exit::ExitGate>().refuse_teardown();
                        let _ = completion.send(Err(error));
                        return;
                    }
                    crate::webview_recovery::closing_all(&app);
                    app.state::<crate::app_exit::ExitGate>()
                        .allow_platform_exit();
                    match action {
                        ExitAction::Quit => app.exit(0),
                        ExitAction::Restart => app.restart(),
                        ExitAction::UpgradeMfa(handoff) => match handoff.approve() {
                            Ok(approval) => {
                                app.manage(approval);
                                let _ = completion.send(Ok(()));
                                app.exit(0);
                            }
                            Err(error) => {
                                tracing::error!(%error, "MFA handoff failed during restart");
                                let _ = completion.send(Err(error));
                                app.restart();
                            }
                        },
                    }
                });
            },
        )
        .await?;
    if await_handoff {
        finished.await.map_err(|error| error.to_string())??;
    }
    Ok(())
}

pub(crate) fn handle_exit_requested(
    app: &tauri::AppHandle,
    code: Option<i32>,
    api: &tauri::ExitRequestApi,
) {
    let Some(gate) = app.try_state::<crate::app_exit::ExitGate>() else {
        return;
    };
    if gate.platform_exit_allowed() {
        return;
    }
    if gate.is_committed() {
        api.prevent_exit();
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
        if let Err(error) = tauri::async_runtime::block_on(runtime.shutdown(&state)) {
            tracing::warn!(%error, "Final plugin termination was not confirmed");
        }
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
    state
        .legacy
        .remote_desktop
        .rdp_sessions
        .write()
        .await
        .clear();
}
