//! Server engine: the contract between the registry/commands in `mod.rs`
//! and the individual leaf server modules (`ssh.rs`, `http.rs`, ...).
//!
//! Leaf modules never touch the registry directly. Instead they receive a
//! [`ServerCtx`] (carrying the app handle, their [`ServerType`], a
//! [`CancellationToken`] and a [`LogEmitter`]) and return a [`ServerStarted`]
//! describing the running task. The engine's [`start`] dispatch routes a
//! generic start request to the matching leaf, and [`set_status`] keeps the
//! registry + frontend in sync.

use tauri::{AppHandle, Emitter};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::{ServerRegistry, ServerStatus, ServerType};

/// Per-server runtime context handed to each leaf's `start()`.
#[derive(Clone)]
pub struct ServerCtx {
    // Available to leaves that need the app handle (e.g. to read app data
    // dirs); placeholder leaves don't use it yet.
    #[allow(dead_code)]
    pub app: AppHandle,
    pub server_type: ServerType,
    /// Cancel this to ask the leaf's accept-loop/supervisor to shut down.
    pub cancel: CancellationToken,
    pub log: LogEmitter,
}

impl ServerCtx {
    pub fn new(app: AppHandle, server_type: ServerType, cancel: CancellationToken) -> Self {
        let log = LogEmitter::new(app.clone(), server_type);
        Self {
            app,
            server_type,
            cancel,
            log,
        }
    }
}

/// Emits human-readable log lines to the frontend on
/// `server://output/<type>`. Each line is prefixed with a `[HH:MM:SS]`
/// local-time timestamp.
#[derive(Clone)]
pub struct LogEmitter {
    app: AppHandle,
    server_type: ServerType,
}

impl LogEmitter {
    pub fn new(app: AppHandle, t: ServerType) -> Self {
        Self {
            app,
            server_type: t,
        }
    }

    /// Emit one timestamped log line to the frontend.
    pub fn line(&self, msg: impl Into<String>) {
        let ts = chrono::Local::now().format("%H:%M:%S");
        let line = format!("[{}] {}", ts, msg.into());
        let channel = format!("server://output/{}", self.server_type.as_str());
        let _ = self.app.emit(&channel, line);
    }
}

/// Returned by a leaf's `start()` once its long-running work has been spawned.
pub struct ServerStarted {
    /// OS pid for supervised (external-binary) servers; `None` for in-process
    /// servers that have no distinct process.
    pub pid: Option<u32>,
    /// The running accept-loop / supervisor task. Must exit when the
    /// context's `cancel` token is cancelled.
    pub task: JoinHandle<()>,
}

/// Update the registry's status map for `status.server_type` and emit the new
/// status on `server://status/<type>`.
pub async fn set_status(app: &AppHandle, registry: &ServerRegistry, status: ServerStatus) {
    {
        let mut s = registry.statuses.lock().await;
        s.insert(status.server_type, status.clone());
    }
    let channel = format!("server://status/{}", status.server_type.as_str());
    let _ = app.emit(&channel, status);
}

/// Dispatch a generic start request to the matching leaf module.
///
/// Each leaf performs its own fallible setup (bind socket / locate binary)
/// and returns `Err` synchronously on failure so the caller can map it to an
/// `Error` status.
pub async fn start(
    ctx: ServerCtx,
    config: super::ServerConfig,
) -> Result<ServerStarted, String> {
    match ctx.server_type {
        ServerType::Ssh => super::ssh::start(ctx, config).await,
        ServerType::Ftp => super::ftp::start(ctx, config).await,
        ServerType::Tftp => super::tftp::start(ctx, config).await,
        ServerType::Http => super::http::start(ctx, config).await,
        ServerType::Telnet => super::telnet::start(ctx, config).await,
        ServerType::Vnc => super::vnc::start(ctx, config).await,
        ServerType::Nfs => super::nfs::start(ctx, config).await,
        ServerType::Cron => super::cron::start(ctx, config).await,
        ServerType::Iperf => super::iperf::start(ctx, config).await,
        ServerType::Rdp => super::rdp::start(ctx, config).await,
    }
}
