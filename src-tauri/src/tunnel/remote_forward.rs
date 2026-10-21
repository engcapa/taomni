use super::model::TunnelConfig;
use super::registry::TunnelRegistry;
use std::sync::Arc;
use tauri::AppHandle;
use tokio::sync::Mutex as AsyncMutex;
use tokio::task::JoinHandle;

/* ---------------------------- Remote (server-side bind) ------------- */
//
// Remote forwarding requires a russh `Handler` whose
// `server_channel_open_forwarded_tcpip` is called for each incoming
// connection. Wiring that up cleanly with the existing `SshHandler`
// (which is shared with terminals) needs a dedicated handler. Until
// that is in place this returns a clear, user-visible error so the UI
// surfaces the limitation instead of silently doing nothing.

pub(super) async fn run_remote_forward(
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
