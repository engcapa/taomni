use super::model::ServerStatus;
use super::model::ServerType;
use crate::module_lock::ModuleLock;
use crate::servers::rdp;
use crate::state::AppState;
use std::collections::HashMap;
use std::collections::VecDeque;
use tauri::State;
use tokio::sync::Mutex as AsyncMutex;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

/* ---------------------------- runtime registry ---------------------- */

pub struct ActiveServer {
    pub cancel: CancellationToken,
    pub task: JoinHandle<()>,
    pub auto_stop_task: Option<JoinHandle<()>>,
    pub status: ServerStatus,
    pub(super) _process_lock: ModuleLock,
}

/// Log lines kept per server so a Local servers window opened later shows
/// what happened while it was closed (the window keeps as many,
/// `MAX_LOG_LINES` in `serversStore.ts`).
pub(super) const LOG_HISTORY_LINES: usize = 500;

#[derive(Default)]
pub struct ServerRegistry {
    pub running: AsyncMutex<HashMap<ServerType, ActiveServer>>,
    pub statuses: AsyncMutex<HashMap<ServerType, ServerStatus>>,
    pub(crate) rdp_approvals: std::sync::Arc<rdp::ApprovalBroker>,
    /// Recent `server://output/<type>` lines, oldest first.
    pub(super) logs: std::sync::Mutex<HashMap<ServerType, VecDeque<String>>>,
}

#[tauri::command]
pub async fn resolve_rdp_connection_request(
    state: State<'_, AppState>,
    request_id: String,
    approved: bool,
) -> Result<bool, String> {
    Ok(state.servers.rdp_approvals.resolve(&request_id, approved))
}

impl ServerRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub(crate) fn record_log(&self, server_type: ServerType, line: &str) {
        let Ok(mut logs) = self.logs.lock() else {
            return;
        };
        let lines = logs.entry(server_type).or_default();
        if lines.len() == LOG_HISTORY_LINES {
            lines.pop_front();
        }
        lines.push_back(line.to_string());
    }

    pub(super) fn log_history(&self) -> HashMap<String, Vec<String>> {
        self.logs
            .lock()
            .map(|logs| {
                logs.iter()
                    .map(|(t, lines)| (t.as_str().to_string(), lines.iter().cloned().collect()))
                    .collect()
            })
            .unwrap_or_default()
    }

    pub(super) fn clear_log(&self, server_type: ServerType) {
        if let Ok(mut logs) = self.logs.lock() {
            logs.remove(&server_type);
        }
    }
}

/// Recent log lines of every server that logged since the app started.
#[tauri::command]
pub fn list_server_logs(state: State<'_, AppState>) -> HashMap<String, Vec<String>> {
    state.servers.log_history()
}

#[tauri::command]
pub fn clear_server_log(state: State<'_, AppState>, server_type: String) -> Result<(), String> {
    let st = ServerType::from_str(&server_type)
        .ok_or_else(|| format!("unknown server type: {}", server_type))?;
    state.servers.clear_log(st);
    Ok(())
}
