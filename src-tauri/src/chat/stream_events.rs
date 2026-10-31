use crate::mobile::events::{DesktopSink, EventSink};
use crate::{chat::StreamEventOut, state::AppState};
use serde_json::json;

pub(crate) fn emit_stream_event(
    app: Option<&tauri::AppHandle>,
    state: &AppState,
    thread: &str,
    name: &str,
    event: &StreamEventOut,
) {
    if let Some(app) = app {
        if let Ok(payload) = serde_json::to_value(event) {
            DesktopSink(app.clone()).emit(name, payload);
        }
    }
    let (status, summary) = match event {
        StreamEventOut::AssistantStart { .. } => ("running", "turn_started"),
        StreamEventOut::End { .. } => ("idle", "turn_finished"),
        StreamEventOut::Error { .. } => ("idle", "turn_failed"),
        StreamEventOut::CcToolActivity { phase, tool, .. } => (
            "running",
            if phase == "use" {
                tool.as_str()
            } else {
                "tool_finished"
            },
        ),
        _ => return,
    };
    state.mobile.task_status(thread, status, summary);
}
