//! Tunneling backend (MobaSSHTunnel-style)
//!
//! Persists `TunnelConfig` records as JSON in the app data directory and
//! manages running port-forwarders. Three forwarding modes are supported:
//!
//! * `Local`   - listen locally, forward to `dest_host:dest_port` via SSH.
//! * `Remote`  - ask the SSH server to listen on `listen_port` and forward
//!               inbound connections back to a local `dest_host:dest_port`.
//! * `Dynamic` - listen locally as a SOCKS5 (CONNECT only) proxy and tunnel
//!               each client connection through SSH using `direct-tcpip`.
//!
//! All commands return early-exit `Result<_, String>` so the frontend gets
//! a clean error message in invoke().

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Mutex as AsyncMutex;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::state::AppState;
use crate::terminal::ssh_pool::{
    PooledSshStream, RusshConnectionFactory, SshChannelPool, SshConnectionFactory,
    SshCredentialSource, SshDirectTcpipTarget, SshPoolConfig, SshPoolKey,
};
use crate::vault::Vault;

/* ---------------------------- data model ---------------------------- */

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "PascalCase")]
pub enum TunnelKind {
    Local,
    Remote,
    Dynamic,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "PascalCase")]
pub enum TunnelAuthMethod {
    Password,
    PrivateKey,
    Agent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelSshCreds {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: TunnelAuthMethod,
    #[serde(default)]
    pub auth_data: Option<String>,
    #[serde(default)]
    pub save_auth: Option<bool>,
    /// Synthetic, output-only flag set by `list_tunnels` so the UI can show
    /// a masked indicator and enable the eye/reveal toggle without leaking
    /// the secret. Values: "vault" (auth_data is `vault:<id>`), "session"
    /// (plaintext lives only in the in-memory cache), "plaintext" (raw
    /// data on disk — only happens for PrivateKey paths), or "none".
    /// Stripped before persistence so this never round-trips to disk.
    #[serde(default, skip_deserializing, skip_serializing_if = "Option::is_none")]
    pub auth_status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelConfig {
    pub id: String,
    pub name: String,
    pub kind: TunnelKind,
    pub listen_host: String,
    pub listen_port: u16,
    pub dest_host: String,
    pub dest_port: u16,
    #[serde(default)]
    pub ssh_session_id: Option<String>,
    pub ssh: TunnelSshCreds,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub autostart: Option<bool>,
    #[serde(default)]
    pub sort_order: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStatusInfo {
    pub id: String,
    pub status: TunnelStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_connections: Option<u32>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TunnelStatus {
    Stopped,
    Starting,
    Running,
    Error,
}

/* ---------------------------- runtime registry ---------------------- */

pub struct ActiveTunnel {
    pub task: JoinHandle<()>,
    /// Per-client bridge tasks. We keep the join handles so a `Stop`
    /// also tears down in-flight forwarded connections instead of
    /// leaking them past the listener.
    pub bridges: Arc<AsyncMutex<Vec<JoinHandle<()>>>>,
    pub cancellation: CancellationToken,
    pub ssh_pool: Option<Arc<SshChannelPool>>,
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

/* ---------------------------- persistence --------------------------- */

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {}", e))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create app dir: {}", e))?;
    Ok(dir.join("tunnels.json"))
}

fn load_all(app: &AppHandle) -> Result<Vec<TunnelConfig>, String> {
    let path = store_path(app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("read tunnels.json: {}", e))?;
    let mut list: Vec<TunnelConfig> =
        serde_json::from_slice(&bytes).map_err(|e| format!("parse tunnels.json: {}", e))?;
    list.sort_by_key(|t| t.sort_order.unwrap_or(0));
    Ok(list)
}

fn save_all(app: &AppHandle, list: &[TunnelConfig]) -> Result<(), String> {
    // Strip secrets unless save_auth is true.
    let sanitized: Vec<TunnelConfig> = list
        .iter()
        .cloned()
        .map(|mut t| {
            let keep = t.ssh.save_auth.unwrap_or(false)
                || matches!(t.ssh.auth_method, TunnelAuthMethod::PrivateKey);
            if !keep {
                t.ssh.auth_data = None;
            }
            // `auth_status` is purely UI-side metadata; never persist it.
            t.ssh.auth_status = None;
            t
        })
        .collect();
    let bytes = serde_json::to_vec_pretty(&sanitized).map_err(|e| format!("encode: {}", e))?;
    let path = store_path(app)?;
    std::fs::write(&path, bytes).map_err(|e| format!("write tunnels.json: {}", e))?;
    Ok(())
}

/* ---------------------------- helpers ------------------------------- */

#[derive(Clone)]
struct TunnelSshRuntime {
    pool: Arc<SshChannelPool>,
    key: SshPoolKey,
    factory: Arc<dyn SshConnectionFactory>,
    cancellation: CancellationToken,
}

impl TunnelSshRuntime {
    async fn warm_up(&self) -> Result<(), String> {
        self.pool
            .warm_up(&self.key, self.factory.as_ref(), &self.cancellation)
            .await
            .map_err(|error| error.to_string())
    }

    async fn open_direct_tcpip(
        &self,
        host: &str,
        port: u16,
        originator: std::net::SocketAddr,
    ) -> Result<PooledSshStream, String> {
        let target = SshDirectTcpipTarget::with_originator(
            host,
            port,
            originator.ip().to_string(),
            originator.port(),
        )
        .map_err(|error| error.to_string())?;
        self.pool
            .open_direct_tcpip(
                &self.key,
                self.factory.as_ref(),
                &target,
                &self.cancellation,
            )
            .await
            .map_err(|error| error.to_string())
    }
}

/// Build a reconnect-capable credential source without resolving a saved
/// Vault reference into a long-lived plaintext field. Transient passwords are
/// moved into zeroizing storage and removed from the spawned tunnel config.
fn build_tunnel_ssh_runtime(
    config: &mut TunnelConfig,
    vault: Arc<Vault>,
    session_password: Option<String>,
    cancellation: CancellationToken,
) -> Result<TunnelSshRuntime, String> {
    let credentials = match config.ssh.auth_method {
        TunnelAuthMethod::Password => {
            let persisted = config
                .ssh
                .auth_data
                .take()
                .filter(|value| !value.is_empty());
            let raw = persisted
                .or(session_password)
                .ok_or_else(|| "Password is empty".to_string())?;
            SshCredentialSource::password(vault, raw).map_err(|error| error.to_string())?
        }
        TunnelAuthMethod::PrivateKey => {
            let path = config
                .ssh
                .auth_data
                .clone()
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "Private key path is empty".to_string())?;
            SshCredentialSource::PrivateKey(path)
        }
        TunnelAuthMethod::Agent => SshCredentialSource::Agent,
    };
    let key = SshPoolKey::new(
        format!("tunnel:{}", config.id),
        &config.ssh.host,
        config.ssh.port,
        &config.ssh.username,
    )
    .map_err(|error| error.to_string())?;
    let pool = Arc::new(
        SshChannelPool::new(SshPoolConfig::default())
            .map_err(|error| format!("could not initialize shared SSH channel pool: {error}"))?,
    );
    let factory: Arc<dyn SshConnectionFactory> =
        Arc::new(RusshConnectionFactory::background(credentials));
    Ok(TunnelSshRuntime {
        pool,
        key,
        factory,
        cancellation,
    })
}

async fn shutdown_active_tunnel(active: ActiveTunnel) {
    active.cancellation.cancel();
    if let Some(pool) = &active.ssh_pool {
        pool.shutdown().await;
    }
    active.task.abort();
    let bridges = active.bridges.lock().await;
    for bridge in bridges.iter() {
        bridge.abort();
    }
}

fn emit_status(app: &AppHandle, info: &TunnelStatusInfo) {
    let _ = app.emit("tunnel-status", info.clone());
}

async fn set_status(app: &AppHandle, registry: &TunnelRegistry, info: TunnelStatusInfo) {
    {
        let mut s = registry.statuses.lock().await;
        s.insert(info.id.clone(), info.clone());
    }
    emit_status(app, &info);
}

/* ---------------------------- Local forwarder ----------------------- */

async fn run_local_forward(
    app: AppHandle,
    registry: Arc<TunnelRegistry>,
    bridges: Arc<AsyncMutex<Vec<JoinHandle<()>>>>,
    config: TunnelConfig,
    runtime: TunnelSshRuntime,
) -> Result<(), String> {
    let listener = TcpListener::bind((config.listen_host.as_str(), config.listen_port))
        .await
        .map_err(|e| format!("bind {}:{}: {}", config.listen_host, config.listen_port, e))?;
    runtime.warm_up().await?;

    set_status(
        &app,
        &registry,
        TunnelStatusInfo {
            id: config.id.clone(),
            status: TunnelStatus::Running,
            error: None,
            active_connections: Some(0),
        },
    )
    .await;

    let dest_host = config.dest_host.clone();
    let dest_port = config.dest_port;
    let id = config.id.clone();
    loop {
        let accepted = tokio::select! {
            biased;
            _ = runtime.cancellation.cancelled() => return Ok(()),
            result = listener.accept() => result,
        };
        let (mut stream, peer) = match accepted {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!("tunnel {}: accept failed: {}", id, e);
                continue;
            }
        };
        let ssh = runtime.clone();
        let dh = dest_host.clone();
        let dp = dest_port;
        let task = tokio::spawn(async move {
            let mut channel = match ssh.open_direct_tcpip(&dh, dp, peer).await {
                Ok(channel) => channel,
                Err(e) => {
                    tracing::warn!("direct-tcpip open failed: {}", e);
                    let _ = stream.shutdown().await;
                    return;
                }
            };
            if let Err(e) = tokio::io::copy_bidirectional(&mut stream, &mut channel).await {
                tracing::debug!("bridge ended: {}", e);
            }
        });
        bridges.lock().await.push(task);
    }
}

/* ---------------------------- Dynamic SOCKS5 ------------------------ */

async fn run_dynamic_forward(
    app: AppHandle,
    registry: Arc<TunnelRegistry>,
    bridges: Arc<AsyncMutex<Vec<JoinHandle<()>>>>,
    config: TunnelConfig,
    runtime: TunnelSshRuntime,
) -> Result<(), String> {
    let listener = TcpListener::bind((config.listen_host.as_str(), config.listen_port))
        .await
        .map_err(|e| format!("bind {}:{}: {}", config.listen_host, config.listen_port, e))?;
    runtime.warm_up().await?;

    set_status(
        &app,
        &registry,
        TunnelStatusInfo {
            id: config.id.clone(),
            status: TunnelStatus::Running,
            error: None,
            active_connections: Some(0),
        },
    )
    .await;

    let id = config.id.clone();
    loop {
        let accepted = tokio::select! {
            biased;
            _ = runtime.cancellation.cancelled() => return Ok(()),
            result = listener.accept() => result,
        };
        let (mut stream, peer) = match accepted {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!("socks {}: accept: {}", id, e);
                continue;
            }
        };
        let ssh = runtime.clone();
        let task = tokio::spawn(async move {
            if let Err(e) = handle_socks5(&mut stream, peer, ssh).await {
                tracing::debug!("socks5 client ended: {}", e);
            }
        });
        bridges.lock().await.push(task);
    }
}

async fn handle_socks5(
    stream: &mut tokio::net::TcpStream,
    peer: std::net::SocketAddr,
    ssh: TunnelSshRuntime,
) -> Result<(), String> {
    // --- greeting ---
    let mut greet = [0u8; 2];
    stream
        .read_exact(&mut greet)
        .await
        .map_err(|e| e.to_string())?;
    if greet[0] != 0x05 {
        return Err("not a SOCKS5 client".to_string());
    }
    let mut methods = vec![0u8; greet[1] as usize];
    stream
        .read_exact(&mut methods)
        .await
        .map_err(|e| e.to_string())?;
    // We support "no authentication" (0x00) only.
    if !methods.contains(&0x00) {
        let _ = stream.write_all(&[0x05, 0xff]).await;
        return Err("SOCKS5 client did not offer no-authentication".to_string());
    }
    stream
        .write_all(&[0x05, 0x00])
        .await
        .map_err(|e| e.to_string())?;

    // --- request ---
    let mut req = [0u8; 4];
    stream
        .read_exact(&mut req)
        .await
        .map_err(|e| e.to_string())?;
    if req[0] != 0x05 {
        return Err("bad SOCKS5 request".to_string());
    }
    if req[1] != 0x01 {
        // CONNECT only
        let _ = stream
            .write_all(&[0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
            .await;
        return Err("only CONNECT is supported".to_string());
    }
    let host = match req[3] {
        0x01 => {
            let mut a = [0u8; 4];
            stream.read_exact(&mut a).await.map_err(|e| e.to_string())?;
            std::net::IpAddr::from(a).to_string()
        }
        0x03 => {
            let mut len = [0u8; 1];
            stream
                .read_exact(&mut len)
                .await
                .map_err(|e| e.to_string())?;
            let mut name = vec![0u8; len[0] as usize];
            stream
                .read_exact(&mut name)
                .await
                .map_err(|e| e.to_string())?;
            String::from_utf8_lossy(&name).to_string()
        }
        0x04 => {
            let mut a = [0u8; 16];
            stream.read_exact(&mut a).await.map_err(|e| e.to_string())?;
            std::net::IpAddr::from(a).to_string()
        }
        _ => {
            let _ = stream
                .write_all(&[0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
                .await;
            return Err("unknown ATYP".to_string());
        }
    };
    let mut port_bytes = [0u8; 2];
    stream
        .read_exact(&mut port_bytes)
        .await
        .map_err(|e| e.to_string())?;
    let port = u16::from_be_bytes(port_bytes);

    let mut channel = match ssh.open_direct_tcpip(&host, port, peer).await {
        Ok(channel) => channel,
        Err(e) => {
            // 0x05 = connection refused
            let _ = stream
                .write_all(&[0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
                .await;
            return Err(format!("ssh open: {}", e));
        }
    };
    // success reply (BND.ADDR/PORT zeroed)
    stream
        .write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
        .await
        .map_err(|e| e.to_string())?;

    tokio::io::copy_bidirectional(stream, &mut channel)
        .await
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/* ---------------------------- Remote (server-side bind) ------------- */
//
// Remote forwarding requires a russh `Handler` whose
// `server_channel_open_forwarded_tcpip` is called for each incoming
// connection. Wiring that up cleanly with the existing `SshHandler`
// (which is shared with terminals) needs a dedicated handler. Until
// that is in place this returns a clear, user-visible error so the UI
// surfaces the limitation instead of silently doing nothing.

async fn run_remote_forward(
    _app: AppHandle,
    _registry: Arc<TunnelRegistry>,
    _bridges: Arc<AsyncMutex<Vec<JoinHandle<()>>>>,
    _config: TunnelConfig,
) -> Result<(), String> {
    // Remote forwarding requires a dedicated russh Handler whose
    // `server_channel_open_forwarded_tcpip` is invoked for each inbound
    // connection. Wiring that up requires more infrastructure than the
    // current shared `SshHandler` provides. Until that lands we fail
    // hard so the UI presents an honest error instead of false success.
    Err("Remote port forwarding is not yet implemented in this build. Please use Local or Dynamic for now.".to_string())
}

/* ---------------------------- Tauri commands ------------------------ */

#[tauri::command]
pub async fn list_tunnels(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<TunnelConfig>, String> {
    let mut list = {
        let _guard = state.tunnels.store_lock.lock().await;
        load_all(&app)?
    };
    // Annotate each entry with `auth_status` so the UI can show a masked
    // indicator (and enable the eye-toggle) without exposing plaintext.
    let cache = state.tunnels.session_passwords.lock().await;
    for t in list.iter_mut() {
        t.ssh.auth_status = Some(compute_auth_status(&t.ssh, cache.contains_key(&t.id)));
    }
    Ok(list)
}

fn compute_auth_status(creds: &TunnelSshCreds, has_session: bool) -> String {
    if matches!(creds.auth_method, TunnelAuthMethod::Agent) {
        return "agent".to_string();
    }
    match creds.auth_data.as_deref() {
        Some(s) if s.starts_with(crate::vault::VAULT_REF_PREFIX) => "vault".to_string(),
        Some(s) if !s.is_empty() => "plaintext".to_string(),
        _ => {
            if has_session {
                "session".to_string()
            } else {
                "none".to_string()
            }
        }
    }
}

#[tauri::command]
pub async fn upsert_tunnel(
    config: TunnelConfig,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<TunnelConfig, String> {
    // Capture (or evict) the in-memory password BEFORE save_all strips it.
    //
    // Cases (auth_method == Password, save_auth == false):
    // * Plaintext authData supplied  → insert/replace the cache so
    //   "Save then Start" works without re-prompting.
    // * Empty/None authData          → KEEP whatever we already have. The
    //   user is editing the row (e.g. renaming, toggling autostart) and
    //   the editor leaves authData blank when the original was a stripped
    //   secret; evicting here would silently break a working tunnel.
    //
    // Anything else (PrivateKey/Agent, save_auth=true, vault ref) → drop
    // any prior cache entry to avoid stale secrets surviving an auth
    // method or storage change.
    {
        let cache = &state.tunnels.session_passwords;
        let mut map = cache.lock().await;
        let is_password = matches!(config.ssh.auth_method, TunnelAuthMethod::Password);
        let wants_session = is_password && !config.ssh.save_auth.unwrap_or(false);
        match (wants_session, config.ssh.auth_data.as_deref()) {
            (true, Some(raw))
                if !raw.is_empty() && !raw.starts_with(crate::vault::VAULT_REF_PREFIX) =>
            {
                // Fresh plaintext typed by the user: refresh the cache.
                map.insert(config.id.clone(), raw.to_string());
            }
            (true, _) => {
                // No new plaintext provided. Preserve any existing cached
                // password so unrelated edits don't break the tunnel.
            }
            _ => {
                // Switched away from cached-password mode (vault, agent,
                // private key, etc.) — clear the stale cache entry.
                map.remove(&config.id);
            }
        }
    }

    let _guard = state.tunnels.store_lock.lock().await;
    let mut all = load_all(&app)?;
    if let Some(idx) = all.iter().position(|t| t.id == config.id) {
        all[idx] = config.clone();
    } else {
        all.push(config.clone());
    }
    save_all(&app, &all)?;
    Ok(config)
}

#[tauri::command]
pub async fn delete_tunnel(
    id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    {
        let _guard = state.tunnels.store_lock.lock().await;
        let mut all = load_all(&app)?;
        all.retain(|t| t.id != id);
        save_all(&app, &all)?;
    }
    state.tunnels.session_passwords.lock().await.remove(&id);
    let active = state.tunnels.running.lock().await.remove(&id);
    if let Some(active) = active {
        shutdown_active_tunnel(active).await;
    }
    state.tunnels.statuses.lock().await.remove(&id);
    Ok(())
}

#[tauri::command]
pub async fn get_tunnel_status(
    id: String,
    state: State<'_, AppState>,
) -> Result<TunnelStatusInfo, String> {
    let s = state.tunnels.statuses.lock().await;
    Ok(s.get(&id).cloned().unwrap_or(TunnelStatusInfo {
        id,
        status: TunnelStatus::Stopped,
        error: None,
        active_connections: None,
    }))
}

#[tauri::command]
pub async fn list_tunnel_statuses(
    state: State<'_, AppState>,
) -> Result<Vec<TunnelStatusInfo>, String> {
    let s = state.tunnels.statuses.lock().await;
    Ok(s.values().cloned().collect())
}

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
    let kind = config.kind.clone();
    let cancellation = CancellationToken::new();
    let ssh_runtime = if matches!(kind, TunnelKind::Local | TunnelKind::Dynamic) {
        Some(build_tunnel_ssh_runtime(
            &mut config,
            state.vault.clone(),
            session_pwd,
            cancellation.clone(),
        )?)
    } else {
        None
    };
    let ssh_pool = ssh_runtime.as_ref().map(|runtime| runtime.pool.clone());

    let starting = TunnelStatusInfo {
        id: id.clone(),
        status: TunnelStatus::Starting,
        error: None,
        active_connections: Some(0),
    };

    // Spawn the actual forwarder. It updates status to Running on success.
    let registry = state.tunnels.clone();
    let app_for_task = app.clone();
    let task_id = id.clone();
    let bridges: Arc<AsyncMutex<Vec<JoinHandle<()>>>> = Arc::new(AsyncMutex::new(Vec::new()));
    let bridges_for_task = bridges.clone();
    let pool_for_task = ssh_pool.clone();
    let cancellation_for_task = cancellation.clone();
    let (start_sender, start_receiver) = tokio::sync::oneshot::channel::<()>();
    let task = tokio::spawn(async move {
        if start_receiver.await.is_err() {
            return;
        }
        let result = match (kind, ssh_runtime) {
            (TunnelKind::Local, Some(runtime)) => {
                run_local_forward(
                    app_for_task.clone(),
                    registry.clone(),
                    bridges_for_task.clone(),
                    config,
                    runtime,
                )
                .await
            }
            (TunnelKind::Dynamic, Some(runtime)) => {
                run_dynamic_forward(
                    app_for_task.clone(),
                    registry.clone(),
                    bridges_for_task.clone(),
                    config,
                    runtime,
                )
                .await
            }
            (TunnelKind::Remote, _) => {
                run_remote_forward(
                    app_for_task.clone(),
                    registry.clone(),
                    bridges_for_task.clone(),
                    config,
                )
                .await
            }
            (_, None) => Err("shared SSH channel pool is not configured".to_string()),
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
        cancellation_for_task.cancel();
        if let Some(pool) = &pool_for_task {
            pool.shutdown().await;
        }
        // Cancel any in-flight bridges, then remove this runtime.
        {
            let bridges = bridges_for_task.lock().await;
            for bridge in bridges.iter() {
                bridge.abort();
            }
        }
        let mut running = registry.running.lock().await;
        running.remove(&task_id);
    });

    let mut running = state.tunnels.running.lock().await;
    if running.contains_key(&id) {
        drop(running);
        cancellation.cancel();
        if let Some(pool) = &ssh_pool {
            pool.shutdown().await;
        }
        task.abort();
        let statuses = state.tunnels.statuses.lock().await;
        return Ok(statuses.get(&id).cloned().unwrap_or(TunnelStatusInfo {
            id,
            status: TunnelStatus::Running,
            error: None,
            active_connections: None,
        }));
    }
    running.insert(
        id.clone(),
        ActiveTunnel {
            task,
            bridges,
            cancellation,
            ssh_pool,
        },
    );
    set_status(&app, &state.tunnels, starting.clone()).await;
    drop(running);
    let _ = start_sender.send(());
    Ok(starting)
}

#[tauri::command]
pub async fn stop_tunnel(
    id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<TunnelStatusInfo, String> {
    let active = state.tunnels.running.lock().await.remove(&id);
    if let Some(active) = active {
        shutdown_active_tunnel(active).await;
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
pub async fn reorder_tunnels(
    ids: Vec<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let _guard = state.tunnels.store_lock.lock().await;
    let mut all = load_all(&app)?;
    let mut by_id: HashMap<String, TunnelConfig> =
        all.drain(..).map(|t| (t.id.clone(), t)).collect();
    let mut reordered: Vec<TunnelConfig> = Vec::with_capacity(by_id.len());
    for (idx, id) in ids.iter().enumerate() {
        if let Some(mut t) = by_id.remove(id) {
            t.sort_order = Some(idx as i32);
            reordered.push(t);
        }
    }
    // Append any tunnels not present in `ids` (defensive).
    for (_id, t) in by_id.into_iter() {
        reordered.push(t);
    }
    save_all(&app, &reordered)?;
    Ok(())
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

#[tauri::command]
pub async fn test_tunnel(
    id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
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
    let runtime = build_tunnel_ssh_runtime(
        &mut config,
        state.vault.clone(),
        session_pwd,
        CancellationToken::new(),
    )?;
    let result = runtime.warm_up().await;
    runtime.pool.shutdown().await;
    result?;
    Ok(format!(
        "SSH connection to {}@{}:{} succeeded",
        config.ssh.username, config.ssh.host, config.ssh.port
    ))
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

#[cfg(test)]
mod tests {
    use std::sync::Mutex as StdMutex;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    use async_trait::async_trait;
    use tokio::net::TcpStream;

    use super::*;
    use crate::terminal::ssh_pool::{
        BoxedSshChannelStream, ControlOpenError, SshControlConnection, SshPoolError,
    };

    #[derive(Default)]
    struct EchoControl {
        targets: StdMutex<Vec<(String, u16)>>,
    }

    #[async_trait]
    impl SshControlConnection for EchoControl {
        fn is_closed(&self) -> bool {
            false
        }

        async fn open_direct_tcpip(
            &self,
            target: &SshDirectTcpipTarget,
        ) -> Result<BoxedSshChannelStream, ControlOpenError> {
            self.targets
                .lock()
                .unwrap()
                .push((target.host().to_string(), target.port()));
            let (stream, mut remote) = tokio::io::duplex(1024);
            tokio::spawn(async move {
                let mut buffer = [0_u8; 256];
                loop {
                    let read = match remote.read(&mut buffer).await {
                        Ok(0) | Err(_) => return,
                        Ok(read) => read,
                    };
                    if remote.write_all(&buffer[..read]).await.is_err() {
                        return;
                    }
                }
            });
            Ok(Box::new(stream))
        }
    }

    struct EchoFactory {
        control: Arc<EchoControl>,
        connects: AtomicUsize,
    }

    #[async_trait]
    impl SshConnectionFactory for EchoFactory {
        async fn connect(
            &self,
            _key: &SshPoolKey,
            _keepalive_interval: Duration,
        ) -> Result<Arc<dyn SshControlConnection>, SshPoolError> {
            self.connects.fetch_add(1, Ordering::AcqRel);
            Ok(self.control.clone())
        }
    }

    fn echo_runtime() -> (TunnelSshRuntime, Arc<EchoControl>, Arc<EchoFactory>) {
        let control = Arc::new(EchoControl::default());
        let factory = Arc::new(EchoFactory {
            control: control.clone(),
            connects: AtomicUsize::new(0),
        });
        let config = SshPoolConfig {
            max_control_connections: 1,
            max_channels_per_connection: 4,
            connect_timeout: Duration::from_secs(2),
            ..SshPoolConfig::default()
        };
        let runtime = TunnelSshRuntime {
            pool: Arc::new(SshChannelPool::new(config).unwrap()),
            key: SshPoolKey::new("tunnel:test", "ssh.example", 22, "private-user").unwrap(),
            factory: factory.clone(),
            cancellation: CancellationToken::new(),
        };
        (runtime, control, factory)
    }

    #[tokio::test]
    async fn dynamic_socks_uses_shared_pool_and_remote_dns() {
        let (runtime, control, factory) = echo_runtime();
        runtime.warm_up().await.unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server_runtime = runtime.clone();
        let server = tokio::spawn(async move {
            let (mut stream, peer) = listener.accept().await.unwrap();
            handle_socks5(&mut stream, peer, server_runtime).await
        });

        let mut client = TcpStream::connect(address).await.unwrap();
        client.write_all(&[5, 1, 0]).await.unwrap();
        let mut greeting = [0_u8; 2];
        client.read_exact(&mut greeting).await.unwrap();
        assert_eq!(greeting, [5, 0]);

        let host = b"SERVICE.INTERNAL";
        let mut request = vec![5, 1, 0, 3, host.len() as u8];
        request.extend_from_slice(host);
        request.extend_from_slice(&443_u16.to_be_bytes());
        client.write_all(&request).await.unwrap();
        let mut reply = [0_u8; 10];
        client.read_exact(&mut reply).await.unwrap();
        assert_eq!(&reply[..2], &[5, 0]);

        client.write_all(b"ping").await.unwrap();
        let mut echo = [0_u8; 4];
        client.read_exact(&mut echo).await.unwrap();
        assert_eq!(&echo, b"ping");
        client.shutdown().await.unwrap();
        drop(client);

        tokio::time::timeout(Duration::from_secs(1), server)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(factory.connects.load(Ordering::Acquire), 1);
        assert_eq!(
            control.targets.lock().unwrap().as_slice(),
            &[("service.internal".into(), 443)]
        );
        assert_eq!(runtime.pool.snapshot().active_channels, 0);
        runtime.pool.shutdown().await;
    }
}
