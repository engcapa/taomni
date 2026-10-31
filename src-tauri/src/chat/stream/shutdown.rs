use crate::chat::run;
use crate::state::AppState;
use serde_json::json;
use tauri::AppHandle;
use tauri::Emitter;
use tauri::State;

#[tauri::command]
pub async fn chat_stop_stream(
    thread_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    stop_thread_runtime(&thread_id, &app, state.inner()).await;
    Ok(())
}

/// Stop every process and pending native permission tied to one thread. This
/// is used both for an explicit Stop action and when deleting a thread so an
/// already-visible confirmation card cannot approve work for a removed chat.
pub(in crate::chat) async fn stop_thread_runtime(
    thread_id: &str,
    app: &AppHandle,
    state: &AppState,
) {
    stop_thread_runtime_inner(thread_id, Some(app), state).await;
}

pub(crate) async fn stop_thread_runtime_inner(
    thread_id: &str,
    app: Option<&AppHandle>,
    state: &AppState,
) {
    // Stop the in-flight turn regardless of provider/runtime. Claude Code also
    // and Codex keep persistent per-thread process registries for reuse; remove
    // those entries on explicit stop so the next turn starts from clean bridge
    // processes.
    state.mobile.turn_cancel(thread_id).cancel();
    let run = { state.agent.chat_runs.lock().await.remove(thread_id) };
    let cc_process = { state.agent.cc_processes.lock().await.remove(thread_id) };
    let codex_process = { state.agent.codex_processes.lock().await.remove(thread_id) };
    let acp_process = { state.agent.acp_processes.lock().await.remove(thread_id) };
    let acp_media_process = {
        state
            .agent
            .acp_media_processes
            .lock()
            .await
            .remove(thread_id)
    };

    if let Some(run) = run {
        run.stop().await;
    }
    if let Some(process) = cc_process {
        if !process.is_stopped() {
            process.stop().await;
        }
    }
    if let Some(process) = codex_process {
        process.stop().await;
    }
    if let Some(process) = acp_process {
        process.stop().await;
    }
    if let Some(process) = acp_media_process {
        process.stop().await;
    }
    let confirmation_ids: Vec<_> = {
        let mut confirmations = state.mobile.confirmations.lock().unwrap();
        let ids = confirmations
            .iter()
            .filter(|(_, v)| v["thread_id"] == thread_id)
            .map(|(id, _)| id.clone())
            .collect();
        confirmations.retain(|_, v| v["thread_id"] != thread_id || v["supported"] == true);
        ids
    };
    for id in confirmation_ids {
        state
            .agent
            .cc_pending_permissions
            .lock()
            .unwrap()
            .remove(&id);
    }
    state.mobile.task_status(thread_id, "idle", "stopped");
    // Clear a visible native-tool gate immediately even when its subprocess
    // has just been stopped and cannot deliver its own runtime event.
    if let Some(app) = app {
        let _ = app.emit(
            "agent-acp-permission-dismissed",
            json!({ "threadId": thread_id, "permissionOwnerId": null, "callId": null }),
        );
    }
}
