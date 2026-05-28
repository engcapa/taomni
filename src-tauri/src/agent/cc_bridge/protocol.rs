use serde::{Deserialize, Serialize};

/// Events emitted by Claude Code's stream-json output format.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CcEvent {
    /// A text message from the assistant.
    AssistantMessage { content: String },
    /// CC wants to call a tool (requires user confirmation).
    ToolUse {
        id: String,
        name: String,
        input: serde_json::Value,
    },
    /// Result of a tool call.
    ToolResult {
        tool_use_id: String,
        content: String,
    },
    /// Session header; emitted on the first event with a fresh session id.
    SessionInit { session_id: String },
    /// Session is complete.
    Done,
    /// An error occurred.
    Error { message: String },
    /// Partial/streaming text (included with --include-partial-messages).
    Partial { content: String },
    /// Unknown event type — preserved for forward compatibility.
    Unknown { raw: String },
}

/// Parse a single NDJSON line from CC stdout into a CcEvent.
pub fn parse_ndjson_line(line: &str) -> Option<CcEvent> {
    let value: serde_json::Value = serde_json::from_str(line).ok()?;

    let event_type = value.get("type").and_then(|v| v.as_str()).unwrap_or("");

    match event_type {
        "system" => {
            // CC stream-json: {"type":"system","subtype":"init","session_id":"<id>",...}
            if value.get("subtype").and_then(|v| v.as_str()) == Some("init") {
                let session_id = value
                    .get("session_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if !session_id.is_empty() {
                    return Some(CcEvent::SessionInit { session_id });
                }
            }
            Some(CcEvent::Unknown {
                raw: line.to_string(),
            })
        }
        "assistant" => {
            // CC stream-json: {"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
            let content = value
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_array())
                .and_then(|arr| {
                    arr.iter()
                        .filter_map(|item| {
                            if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                                item.get("text")
                                    .and_then(|t| t.as_str())
                                    .map(|s| s.to_string())
                            } else {
                                None
                            }
                        })
                        .reduce(|a, b| a + &b)
                })
                .unwrap_or_default();
            Some(CcEvent::AssistantMessage { content })
        }
        "tool_use" => {
            let id = value
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let name = value
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let input = value
                .get("input")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            Some(CcEvent::ToolUse { id, name, input })
        }
        "tool_result" => {
            let tool_use_id = value
                .get("tool_use_id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let content = value
                .get("content")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            Some(CcEvent::ToolResult {
                tool_use_id,
                content,
            })
        }
        "result" => {
            // CC final result event
            if value.get("subtype").and_then(|v| v.as_str()) == Some("error") {
                let msg = value
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Unknown error")
                    .to_string();
                Some(CcEvent::Error { message: msg })
            } else {
                Some(CcEvent::Done)
            }
        }
        "error" => {
            let msg = value
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown error")
                .to_string();
            Some(CcEvent::Error { message: msg })
        }
        _ => Some(CcEvent::Unknown {
            raw: line.to_string(),
        }),
    }
}

/// Extract the final text answer from a list of CC events.
pub fn extract_answer(events: &[CcEvent]) -> String {
    events
        .iter()
        .filter_map(|e| match e {
            CcEvent::AssistantMessage { content } => Some(content.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("")
}

/// Pull a freshly-issued CC session id out of a stream, if present.
pub fn extract_session_id(events: &[CcEvent]) -> Option<String> {
    events.iter().find_map(|e| match e {
        CcEvent::SessionInit { session_id } => Some(session_id.clone()),
        _ => None,
    })
}
