use crate::{chat::StreamEventOut, state::AppState};
use serde_json::json;

pub(crate) fn emit_stream_event(
    app: Option<&tauri::AppHandle>,
    state: &AppState,
    thread: &str,
    name: &str,
    event: &StreamEventOut,
) {
    if let Ok(payload) = serde_json::to_value(event) {
        crate::mobile::events::emit_optional(app, name, payload);
    }
    let (status, summary) = match event {
        StreamEventOut::AssistantStart { .. } => ("running", "turn_started"),
        StreamEventOut::End { .. } => return, // the turn owner publishes the terminal state exactly once
        StreamEventOut::Error { .. } => {
            if let Some(turn) = state
                .mobile
                .pending_turns
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(thread)
            {
                turn.failed
                    .store(true, std::sync::atomic::Ordering::Relaxed);
            }
            return;
        }
        StreamEventOut::CcToolActivity {
            phase,
            tool,
            call_id,
            ..
        } => {
            let mut tools = state.mobile.tools.lock().unwrap_or_else(|e| e.into_inner());
            let calls = tools.entry(thread.into()).or_default();
            if phase == "use" {
                if calls.len() >= 20 {
                    calls.remove(0);
                }
                calls.push(json!({"id":call_id,"name":tool,"status":"running"}));
            } else if let Some(call) = calls.iter_mut().find(|v| v["id"] == *call_id) {
                call["status"] = json!("completed");
            }
            (
                "running",
                if phase == "use" {
                    tool.as_str()
                } else {
                    "tool_finished"
                },
            )
        }
        _ => return,
    };
    state.mobile.task_status(thread, status, summary);
}
