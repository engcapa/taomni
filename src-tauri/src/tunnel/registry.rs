use super::model::TunnelStatusInfo;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::AppHandle;
use tauri::Emitter;
use tokio::sync::Mutex as AsyncMutex;
use tokio::task::JoinHandle;

/* ---------------------------- runtime registry ---------------------- */

pub struct ActiveTunnel {
    pub task: JoinHandle<()>,
    /// Per-client bridge tasks. We keep the join handles so a `Stop`
    /// also tears down in-flight forwarded connections instead of
    /// leaking them past the listener.
    pub bridges: Arc<AsyncMutex<Vec<JoinHandle<()>>>>,
}

#[derive(Default)]
pub struct TunnelRegistry {
    pub running: AsyncMutex<HashMap<String, ActiveTunnel>>,
    pub statuses: AsyncMutex<HashMap<String, TunnelStatusInfo>>,
    /// Serialises all read-modify-write access to `tunnels.json` so that
    /// concurrent `upsert_tunnel` / `delete_tunnel` calls (e.g. when the
    /// UI batches a reorder) cannot lose updates.
    pub store_lock: AsyncMutex<()>,
    /// Per-tunnel-id in-memory passwords supplied through `upsert_tunnel`
    /// while `save_auth` is false. The disk store strips secrets in that
    /// case (so the password never lands in tunnels.json), but the user
    /// still expects "Save → Start" within the same session to succeed
    /// without re-prompting. This cache lives only as long as the process.
    pub session_passwords: AsyncMutex<HashMap<String, String>>,
}

impl TunnelRegistry {
    pub fn new() -> Self {
        Self::default()
    }
}

pub(super) fn emit_status(app: &AppHandle, info: &TunnelStatusInfo) {
    let _ = app.emit("tunnel-status", info.clone());
}

pub(super) async fn set_status(app: &AppHandle, registry: &TunnelRegistry, info: TunnelStatusInfo) {
    {
        let mut s = registry.statuses.lock().await;
        s.insert(info.id.clone(), info.clone());
    }
    emit_status(app, &info);
}
