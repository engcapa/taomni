use crate::agent::acp_bridge::AcpPermissionPrompt;
use crate::agent::acp_bridge::AcpRuntimeEvent;
use crate::agent::local::LocalAgentEvent;
use crate::chat::StreamEventOut;
use crate::chat::presentation::cc_tool_arg_summary;
use crate::chat::presentation::cc_tool_result_preview;
use crate::chat::presentation::format_cc_tool_use;
use futures::StreamExt;
use serde_json::json;
use std::collections::HashMap;
use tauri::AppHandle;
use tauri::Emitter;

#[derive(Default)]
pub(super) struct AcpEventAccumulator {
    pub(super) content: String,
    pub(super) tool_names: HashMap<String, String>,
}

/// Forward only the data required to render and resolve a standard ACP
/// permission gate. In particular, raw tool input, ACP session ids,
/// tool-call ids, and agent-authored option labels stay in the backend.
pub(super) fn emit_acp_permission(
    app: &AppHandle,
    thread_id: &str,
    permission_owner_id: &str,
    source_label: &str,
    permission: AcpPermissionPrompt,
) {
    let options = permission
        .options
        .into_iter()
        .map(|option| {
            json!({
                "optionId": option.option_id,
                "kind": option.kind,
            })
        })
        .collect::<Vec<_>>();
    let _ = app.emit(
        "agent-acp-permission",
        json!({
            "callId": permission.call_id,
            "threadId": thread_id,
            "permissionOwnerId": permission_owner_id,
            "sourceLabel": source_label,
            "title": permission.title,
            "kind": permission.kind,
            "options": options,
        }),
    );
}

pub(super) fn dismiss_acp_permission(
    app: &AppHandle,
    thread_id: &str,
    permission_owner_id: Option<&str>,
    call_id: Option<&str>,
) {
    let _ = app.emit(
        "agent-acp-permission-dismissed",
        json!({
            "threadId": thread_id,
            "permissionOwnerId": permission_owner_id,
            "callId": call_id,
        }),
    );
}

impl AcpEventAccumulator {
    pub(super) fn handle(
        &mut self,
        app: &AppHandle,
        event_name: &str,
        assistant_id: &str,
        thread_id: &str,
        permission_owner_id: &str,
        source_label: &str,
        event: AcpRuntimeEvent,
    ) {
        match event {
            AcpRuntimeEvent::SessionUpdate(update) if !update.is_replay => {
                if let Some(event) = update.event {
                    self.handle_local_event(app, event_name, assistant_id, event);
                }
            }
            AcpRuntimeEvent::PermissionRequest(permission) => {
                emit_acp_permission(
                    app,
                    thread_id,
                    permission_owner_id,
                    source_label,
                    permission,
                );
            }
            AcpRuntimeEvent::PermissionResolved { call_id } => {
                dismiss_acp_permission(app, thread_id, Some(permission_owner_id), Some(&call_id));
            }
            AcpRuntimeEvent::ProtocolWarning { message } => {
                tracing::warn!("ACP protocol warning: {message}");
            }
            AcpRuntimeEvent::Closed => {
                dismiss_acp_permission(app, thread_id, Some(permission_owner_id), None)
            }
            AcpRuntimeEvent::SessionUpdate(_) => {}
        }
    }

    pub(super) fn handle_local_event(
        &mut self,
        app: &AppHandle,
        event_name: &str,
        assistant_id: &str,
        event: LocalAgentEvent,
    ) {
        match event {
            LocalAgentEvent::AssistantDelta { content }
            | LocalAgentEvent::AssistantMessage { content } => {
                self.content.push_str(&content);
                emit(
                    app,
                    event_name,
                    StreamEventOut::Token {
                        id: assistant_id.into(),
                        content,
                    },
                );
            }
            LocalAgentEvent::ToolStarted {
                id, name, input, ..
            } => {
                self.tool_names.insert(id.clone(), name.clone());
                self.content.push_str(&format_cc_tool_use(&name, &input));
                emit(
                    app,
                    event_name,
                    StreamEventOut::CcToolActivity {
                        id: assistant_id.into(),
                        call_id: id,
                        phase: "use".into(),
                        tool: name,
                        detail: cc_tool_arg_summary(&input).unwrap_or_default(),
                    },
                );
            }
            LocalAgentEvent::ToolCompleted { id, output } => {
                let preview = cc_tool_result_preview(&output);
                if !preview.is_empty() {
                    self.content.push_str(&format!("> ↳ {preview}\n"));
                }
                emit(
                    app,
                    event_name,
                    StreamEventOut::CcToolActivity {
                        id: assistant_id.into(),
                        call_id: id.clone(),
                        phase: "result".into(),
                        tool: self.tool_names.remove(&id).unwrap_or_default(),
                        detail: preview,
                    },
                );
            }
            LocalAgentEvent::Error { message } => {
                tracing::warn!("ACP agent event error: {message}");
            }
            LocalAgentEvent::SessionStarted { .. } | LocalAgentEvent::Done { .. } => {}
        }
    }
}

pub(super) fn emit(app: &AppHandle, event_name: &str, event: StreamEventOut) {
    let _ = app.emit(event_name, event);
}

pub(super) fn emit_error(app: &AppHandle, event_name: &str, assistant_id: &str, message: String) {
    emit(
        app,
        event_name,
        StreamEventOut::Error {
            id: assistant_id.into(),
            message,
        },
    );
}
