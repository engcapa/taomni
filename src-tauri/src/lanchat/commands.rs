//! LanChat Tauri command surface (`lanchat_*`).
//!
//! Single backend entry point for the frontend IPC layer (`src/lib/ipc.ts`).
//! Commands are added per phase; phase 1 ships only a lightweight status probe
//! used by the status bar / web-preview banner.

use serde::Serialize;
use tauri::State;

use crate::state::AppState;

/// Snapshot of the LanChat service for the status bar.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanChatStatus {
    /// Whether the background service task is running.
    pub running: bool,
    /// Number of peers currently discovered on the LAN.
    pub peer_count: usize,
}

/// Report current LanChat service status (running + discovered peer count).
#[tauri::command]
pub async fn lanchat_status(state: State<'_, AppState>) -> Result<LanChatStatus, String> {
    Ok(LanChatStatus {
        running: true,
        peer_count: state.lanchat.peer_count().await,
    })
}
