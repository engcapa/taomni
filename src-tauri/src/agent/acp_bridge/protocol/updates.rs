use super::display::parse_generated_media;
use super::display::tool_call_display_input;
use super::display::tool_call_display_output;
use super::display::truncate_display_text;
use super::update_model::AcpSessionUpdate;
use super::update_model::AcpUsageUpdate;
use crate::agent::local::LocalAgentEvent;
use serde_json::Value;

/// Parse an ACP `session/update` params object into the limited UI-safe event
/// vocabulary. Raw tool input, tool output, provider metadata, and thoughts are
/// deliberately never forwarded into the shared local-agent model.
pub fn parse_session_update(params: &Value) -> Option<AcpSessionUpdate> {
    let session_id = params
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())?
        .to_string();
    let update = params.get("update").unwrap_or(params);
    let update_type = update.get("sessionUpdate").and_then(Value::as_str)?;
    let is_replay = params
        .get("_meta")
        .and_then(Value::as_object)
        .and_then(|meta| meta.get("isReplay"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let generated_media = if is_replay {
        None
    } else {
        parse_generated_media(update, update_type)
    };

    let event = if is_replay {
        None
    } else {
        match update_type {
            "agent_message_chunk" | "agent_text" | "agent-text" => update
                .get("content")
                .and_then(Value::as_object)
                .filter(|content| {
                    content
                        .get("type")
                        .and_then(Value::as_str)
                        .is_none_or(|kind| kind == "text")
                })
                .and_then(|content| content.get("text"))
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
                .map(|content| LocalAgentEvent::AssistantDelta {
                    content: content.to_string(),
                }),
            "tool_call" => {
                let id = update
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|id| !id.is_empty());
                let title = update
                    .get("title")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|title| !title.is_empty())
                    .unwrap_or("Tool");
                id.map(|id| LocalAgentEvent::ToolStarted {
                    id: id.to_string(),
                    name: truncate_display_text(title, 240),
                    // Display-safe subset only — never forward arbitrary rawInput.
                    input: tool_call_display_input(update),
                })
            }
            "tool_call_update" => {
                let id = update
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|id| !id.is_empty());
                let status = update
                    .get("status")
                    .and_then(Value::as_str)
                    .filter(|status| matches!(*status, "completed" | "failed"));
                id.zip(status)
                    .map(|(id, status)| LocalAgentEvent::ToolCompleted {
                        id: id.to_string(),
                        output: tool_call_display_output(update, status),
                    })
            }
            _ => None,
        }
    };

    let usage = if !is_replay && update_type == "usage_update" {
        let used_tokens = update.get("used").and_then(Value::as_u64)?;
        let total_tokens = update.get("size").and_then(Value::as_u64)?;
        let cost = update.get("cost").and_then(Value::as_object);
        Some(AcpUsageUpdate {
            used_tokens,
            total_tokens,
            cost_amount: cost
                .and_then(|cost| cost.get("amount"))
                .and_then(Value::as_f64),
            cost_currency: cost
                .and_then(|cost| cost.get("currency"))
                .and_then(Value::as_str)
                .map(|currency| truncate_display_text(currency, 16)),
        })
    } else {
        None
    };

    Some(AcpSessionUpdate {
        session_id,
        is_replay,
        event,
        usage,
        generated_media,
    })
}

/// Keys whose string values are useful and safe to show in the tool-activity
/// transcript. Secrets / credentials are never allowlisted here.
pub(super) const TOOL_DISPLAY_INPUT_KEYS: &[&str] = &[
    "command",
    "cmd",
    "query",
    "pattern",
    "path",
    "file_path",
    "filePath",
    "target_file",
    "targetFile",
    "notebook_path",
    "url",
    "uri",
    "prompt",
    "description",
    "glob",
    "directory",
    "cwd",
    "working_directory",
    "name",
    "tool",
    "tool_name",
    "toolName",
    "server",
    "server_name",
    "message",
    "text",
    "search",
    "replace",
    "old_string",
    "new_string",
    "content",
    "offset",
    "limit",
    "language",
];
