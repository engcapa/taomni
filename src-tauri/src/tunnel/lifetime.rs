use super::credentials::resolve_tunnel_creds;
use super::dynamic_forward::run_dynamic_forward;
use super::local_forward::run_local_forward;
use super::model::TunnelKind;
use super::model::TunnelStatus;
use super::model::TunnelStatusInfo;
use super::persistence::load_all;
use super::registry::ActiveTunnel;
use super::registry::set_status;
use super::remote_forward::run_remote_forward;
use crate::module_lock::ModuleLock;
use crate::state::AppState;
use std::sync::Arc;
use tauri::AppHandle;
use tauri::Emitter;
use tauri::Manager;
use tauri::State;
use tokio::sync::Mutex as AsyncMutex;
use tokio::task::JoinHandle;

#[tauri::command]
pub async fn start_tunnel(
    id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<TunnelStatusInfo, String> {
    // Ignore duplicate start: return the latest persisted status.
    {
        let running = state.tunnels.running.lock().await;
        if running.contains_key(&id) {
            let s = state.tunnels.statuses.lock().await;
            return Ok(s.get(&id).cloned().unwrap_or(TunnelStatusInfo {
                id: id.clone(),
                status: TunnelStatus::Running,
                error: None,
                active_connections: None,
            }));
        }
    }

    let configs = {
        let _guard = state.tunnels.store_lock.lock().await;
        load_all(&app)?
    };
    let mut config = configs
        .into_iter()
        .find(|t| t.id == id)
        .ok_or_else(|| format!("tunnel {} not found", id))?;
    let session_pwd = state
        .tunnels
        .session_passwords
        .lock()
        .await
        .get(&id)
        .cloned();
    resolve_tunnel_creds(&mut config, &state.vault, session_pwd)?;

    // The same persisted tunnel may autostart in several Taomni processes.
    // Own it by tunnel id for the task lifetime; a different tunnel id can run
    // concurrently, with the OS listener still enforcing endpoint uniqueness.
    let process_lock =
        ModuleLock::try_acquire_for_app(&app, "tunnel", &id, &format!("Tunnel {id}"))?;

    let starting = TunnelStatusInfo {
        id: id.clone(),
        status: TunnelStatus::Starting,
        error: None,
        active_connections: Some(0),
    };
    set_status(&app, &state.tunnels, starting.clone()).await;

    // Spawn the actual forwarder. It updates status to Running on success.
    let registry = state.tunnels.clone();
    let app_for_task = app.clone();
    let task_id = id.clone();
    let kind = config.kind.clone();
    let bridges: Arc<AsyncMutex<Vec<JoinHandle<()>>>> = Arc::new(AsyncMutex::new(Vec::new()));
    let bridges_for_task = bridges.clone();
    let task = tokio::spawn(async move {
        let _process_lock = process_lock;
        let result = match kind {
            TunnelKind::Local => {
                run_local_forward(
                    app_for_task.clone(),
                    registry.clone(),
                    bridges_for_task.clone(),
                    config,
                )
                .await
            }
            TunnelKind::Dynamic => {
                run_dynamic_forward(
                    app_for_task.clone(),
                    registry.clone(),
                    bridges_for_task.clone(),
                    config,
                )
                .await
            }
            TunnelKind::Remote => {
                run_remote_forward(
                    app_for_task.clone(),
                    registry.clone(),
                    bridges_for_task.clone(),
                    config,
                )
                .await
            }
        };
        if let Err(e) = result {
            let info = TunnelStatusInfo {
                id: task_id.clone(),
                status: TunnelStatus::Error,
                error: Some(e),
                active_connections: None,
            };
            {
                let mut s = registry.statuses.lock().await;
                s.insert(task_id.clone(), info.clone());
            }
            let _ = app_for_task.emit("tunnel-status", info);
        }
        // Cancel any in-flight bridges, then drop ourselves.
        {
            let bridges = bridges_for_task.lock().await;
            for b in bridges.iter() {
                b.abort();
            }
        }
        let mut running = registry.running.lock().await;
        running.remove(&task_id);
    });

    let mut running = state.tunnels.running.lock().await;
    running.insert(id.clone(), ActiveTunnel { task, bridges });
    Ok(starting)
}

#[tauri::command]
pub async fn stop_tunnel(
    id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<TunnelStatusInfo, String> {
    {
        let mut running = state.tunnels.running.lock().await;
        if let Some(active) = running.remove(&id) {
            active.task.abort();
            let bridges = active.bridges.lock().await;
            for b in bridges.iter() {
                b.abort();
            }
        }
    }
    let info = TunnelStatusInfo {
        id: id.clone(),
        status: TunnelStatus::Stopped,
        error: None,
        active_connections: None,
    };
    set_status(&app, &state.tunnels, info.clone()).await;
    Ok(info)
}

#[tauri::command]
pub async fn start_all_tunnels(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<TunnelStatusInfo>, String> {
    let configs = {
        let _guard = state.tunnels.store_lock.lock().await;
        load_all(&app)?
    };
    let mut out = Vec::with_capacity(configs.len());
    for c in configs {
        match start_tunnel(c.id.clone(), app.clone(), state.clone()).await {
            Ok(info) => out.push(info),
            Err(e) => out.push(TunnelStatusInfo {
                id: c.id,
                status: TunnelStatus::Error,
                error: Some(e),
                active_connections: None,
            }),
        }
    }
    Ok(out)
}

/// Called once at startup to start any tunnels that have
/// `autostart=true` saved on disk. Errors are swallowed but each
/// failure is published via the normal `tunnel-status` event so the
/// UI can surface it.
pub async fn autostart_tunnels(app: AppHandle) {
    let configs = match load_all(&app) {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("autostart: load failed: {}", e);
            return;
        }
    };
    let state: tauri::State<AppState> = app.state();
    for c in configs.into_iter().filter(|t| t.autostart.unwrap_or(false)) {
        let id = c.id.clone();
        if let Err(e) = start_tunnel(id.clone(), app.clone(), state.clone()).await {
            tracing::warn!("autostart {}: {}", id, e);
        }
    }
}

#[tauri::command]
pub async fn stop_all_tunnels(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<TunnelStatusInfo>, String> {
    let configs = {
        let _guard = state.tunnels.store_lock.lock().await;
        load_all(&app)?
    };
    let mut out = Vec::with_capacity(configs.len());
    for c in configs {
        match stop_tunnel(c.id.clone(), app.clone(), state.clone()).await {
            Ok(info) => out.push(info),
            Err(e) => out.push(TunnelStatusInfo {
                id: c.id,
                status: TunnelStatus::Error,
                error: Some(e),
                active_connections: None,
            }),
        }
    }
    Ok(out)
}
