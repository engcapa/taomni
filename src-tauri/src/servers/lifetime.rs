use super::credentials::resolve_rdp_password;
use super::model::ServerConfig;
use super::model::ServerRunState;
use super::model::ServerStatus;
use super::model::ServerType;
use super::model::now_ms;
use super::registry::ActiveServer;
use super::registry::ServerRegistry;
use crate::module_lock::ModuleLock;
use crate::servers::engine;
use crate::servers::engine::ServerCtx;
use crate::servers::engine::set_status;
use crate::state::AppState;
use std::time::Duration;
use tauri::AppHandle;
use tauri::State;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

/* ---------------------------- internals ----------------------------- */

/// Cancel the server and its auto-stop timer, then publish `Stopped`.
/// Safe to call when nothing is running (no-op apart from publishing Stopped).
pub(super) async fn stop_internal(
    app: &AppHandle,
    registry: &ServerRegistry,
    server_type: ServerType,
) -> ServerStatus {
    {
        let mut running = registry.running.lock().await;
        if let Some(mut active) = running.remove(&server_type) {
            if let Some(t) = active.auto_stop_task.take() {
                t.abort();
            }
            finish_server(server_type, active).await;
        }
    }
    let info = ServerStatus::stopped(server_type);
    set_status(app, registry, info.clone()).await;
    info
}

/// Spawn the auto-stop timer for a freshly started server. After
/// `auto_stop_seconds` it logs `Auto-stopped after Ns`, tears the server down
/// and publishes `Stopped`. Exits early (without stopping) if the server is
/// cancelled first.
pub(super) fn spawn_auto_stop(
    app: AppHandle,
    registry: std::sync::Arc<ServerRegistry>,
    server_type: ServerType,
    cancel: CancellationToken,
    log: engine::LogEmitter,
    seconds: u64,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        tokio::select! {
            _ = tokio::time::sleep(std::time::Duration::from_secs(seconds)) => {
                log.line(format!("Auto-stopped after {}s", seconds));
                {
                    let mut running = registry.running.lock().await;
                    if let Some(active) = running.remove(&server_type) {
                        // active.auto_stop_task is this very task — just drop it.
                        finish_server(server_type, active).await;
                    } else {
                        // Already stopped elsewhere; nothing to do.
                        return;
                    }
                }
                set_status(&app, &registry, ServerStatus::stopped(server_type)).await;
            }
            _ = cancel.cancelled() => {
                // Server stopped (manually or on error) before the timer fired.
            }
        }
    })
}

async fn finish_server(server_type: ServerType, mut active: ActiveServer) {
    active.cancel.cancel();
    if matches!(server_type, ServerType::Vnc | ServerType::Rdp) {
        // The monitor forwards cancellation and waits for the listener to close.
        if tokio::time::timeout(Duration::from_secs(12), &mut active.task)
            .await
            .is_ok()
        {
            return;
        }
    }
    active.task.abort();
}

fn watch_desktop_server_exit(
    ctx: ServerCtx,
    registry: std::sync::Arc<ServerRegistry>,
    task: JoinHandle<()>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let server_type = ctx.server_type;
        if let Err(error) = task.await {
            ctx.log.line(format!("Server monitor stopped: {error}"));
        }
        // Manual and automatic stops already own the registry and publish
        // Stopped after the module has reaped its process.
        let mut running = tokio::select! {
            biased;
            _ = ctx.cancel.cancelled() => return,
            running = registry.running.lock() => running,
        };
        if let Some(active) = running.remove(&server_type) {
            if let Some(timer) = &active.auto_stop_task {
                timer.abort();
            }
            set_status(&ctx.app, &registry, ServerStatus::stopped(server_type)).await;
        }
    })
}

/* ---------------------------- Tauri commands ------------------------ */

#[tauri::command]
pub async fn start_local_server(
    app: AppHandle,
    state: State<'_, AppState>,
    server_type: String,
    config: serde_json::Value,
) -> Result<ServerStatus, String> {
    let st = ServerType::from_str(&server_type)
        .ok_or_else(|| format!("unknown server type: {}", server_type))?;

    // Ignore duplicate start: return the current status.
    {
        let running = state.legacy.servers.running.lock().await;
        if let Some(active) = running.get(&st) {
            return Ok(active.status.clone());
        }
    }

    let mut config: ServerConfig = serde_json::from_value(config)
        .map_err(|e| format!("invalid config for {}: {}", server_type, e))?;
    // There is one persisted configuration per server type. Keep that type
    // exclusive across Taomni processes; different server types may coexist.
    let process_lock = ModuleLock::try_acquire_for_app(
        &app,
        "local-server",
        st.as_str(),
        &format!("{} server", st.as_str()),
    )?;

    // Publish Starting.
    let starting = ServerStatus {
        server_type: st,
        status: ServerRunState::Starting,
        pid: None,
        started_at: None,
        error: None,
    };
    set_status(&app, &state.legacy.servers, starting).await;

    if st == ServerType::Rdp {
        if let Err(e) = resolve_rdp_password(&state, &mut config) {
            let info = ServerStatus {
                server_type: st,
                status: ServerRunState::Error,
                pid: None,
                started_at: None,
                error: Some(e.clone()),
            };
            set_status(&app, &state.legacy.servers, info).await;
            return Err(e);
        }
    }

    // Dispatch to the leaf. Fallible setup (bind/locate) surfaces here.
    let cancel = CancellationToken::new();
    let ctx = ServerCtx::new(app.clone(), st, cancel.clone());
    let log = ctx.log.clone();
    let started = match engine::start(ctx.clone(), config.clone()).await {
        Ok(s) => s,
        Err(e) => {
            cancel.cancel();
            let info = ServerStatus {
                server_type: st,
                status: ServerRunState::Error,
                pid: None,
                started_at: None,
                error: Some(e.clone()),
            };
            set_status(&app, &state.legacy.servers, info).await;
            return Err(e);
        }
    };

    let running_status = ServerStatus {
        server_type: st,
        status: ServerRunState::Running,
        pid: started.pid,
        started_at: Some(now_ms()),
        error: None,
    };

    // Optional auto-stop timer.
    let auto_stop_task = if config.auto_stop {
        Some(spawn_auto_stop(
            app.clone(),
            state.legacy.servers.clone(),
            st,
            cancel.clone(),
            log,
            config.auto_stop_seconds,
        ))
    } else {
        None
    };

    {
        let mut running = state.legacy.servers.running.lock().await;
        let task = if matches!(st, ServerType::Vnc | ServerType::Rdp) {
            watch_desktop_server_exit(ctx, state.legacy.servers.clone(), started.task)
        } else {
            started.task
        };
        running.insert(
            st,
            ActiveServer {
                cancel,
                task,
                auto_stop_task,
                status: running_status.clone(),
                _process_lock: process_lock,
            },
        );
        set_status(&app, &state.legacy.servers, running_status.clone()).await;
    }
    Ok(running_status)
}

#[tauri::command]
pub async fn stop_local_server(
    app: AppHandle,
    state: State<'_, AppState>,
    server_type: String,
) -> Result<ServerStatus, String> {
    let st = ServerType::from_str(&server_type)
        .ok_or_else(|| format!("unknown server type: {}", server_type))?;
    Ok(stop_internal(&app, &state.legacy.servers, st).await)
}

#[tauri::command]
pub async fn get_server_status(
    state: State<'_, AppState>,
    server_type: String,
) -> Result<ServerStatus, String> {
    let st = ServerType::from_str(&server_type)
        .ok_or_else(|| format!("unknown server type: {}", server_type))?;
    let s = state.legacy.servers.statuses.lock().await;
    Ok(s.get(&st)
        .cloned()
        .unwrap_or_else(|| ServerStatus::stopped(st)))
}

#[tauri::command]
pub async fn list_server_statuses(state: State<'_, AppState>) -> Result<Vec<ServerStatus>, String> {
    let s = state.legacy.servers.statuses.lock().await;
    // Return a status for every known server type so the UI has a complete
    // list even before anything has started.
    let out = ServerType::all()
        .into_iter()
        .map(|st| {
            s.get(&st)
                .cloned()
                .unwrap_or_else(|| ServerStatus::stopped(st))
        })
        .collect();
    Ok(out)
}
