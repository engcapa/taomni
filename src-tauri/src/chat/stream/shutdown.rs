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
    state.legacy.mobile.turn_cancel(thread_id).cancel();
    let run = { state.core.agent.chat_runs.lock().await.remove(thread_id) };
    let cc_process = { state.core.agent.cc_processes.lock().await.remove(thread_id) };
    let codex_process = {
        state
            .core
            .agent
            .codex_processes
            .lock()
            .await
            .remove(thread_id)
    };
    let acp_process = {
        state
            .core
            .agent
            .acp_processes
            .lock()
            .await
            .remove(thread_id)
    };
    let acp_media_process = {
        state
            .core
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
        let mut confirmations = state.legacy.mobile.confirmations.lock().unwrap();
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
            .core
            .agent
            .cc_pending_permissions
            .lock()
            .unwrap()
            .remove(&id);
    }
    // The owning turn publishes its terminal state after cancellation has unwound.
    // Clear a visible native-tool gate immediately even when its subprocess
    // has just been stopped and cannot deliver its own runtime event.
    if let Some(app) = app {
        let _ = app.emit(
            "agent-acp-permission-dismissed",
            json!({ "threadId": thread_id, "permissionOwnerId": null, "callId": null }),
        );
        // Same for a Claude Code approval: its oneshot sender was just dropped,
        // so the prompt can never be answered and its card(s) must go away.
        crate::windowing::thread_delivery::broadcast_cc_permission_resolved(
            app,
            None,
            Some(thread_id),
        );
    }
}
