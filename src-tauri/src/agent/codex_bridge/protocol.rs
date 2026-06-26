use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct CodexUsage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CodexEvent {
    AssistantMessage {
        content: String,
    },
    Partial {
        content: String,
    },
    ToolUse {
        id: String,
        name: String,
        input: serde_json::Value,
    },
    ToolResult {
        tool_use_id: String,
        content: String,
    },
    SessionInit {
        session_id: String,
    },
    Done {
        usage: Option<CodexUsage>,
    },
    Error {
        message: String,
    },
    Unknown {
        raw: String,
    },
}

pub fn extract_answer(events: &[CodexEvent]) -> String {
    events
        .iter()
        .filter_map(|e| match e {
            CodexEvent::AssistantMessage { content } => Some(content.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("")
}

pub fn extract_session_id(events: &[CodexEvent]) -> Option<String> {
    events.iter().find_map(|e| match e {
        CodexEvent::SessionInit { session_id } => Some(session_id.clone()),
        _ => None,
    })
}

pub(crate) fn item_tool_name(item: &serde_json::Value) -> Option<String> {
    match item.get("type").and_then(|v| v.as_str()) {
        Some("mcpToolCall") => {
            let server = item.get("server").and_then(|v| v.as_str()).unwrap_or("");
            let tool = item
                .get("tool")
                .and_then(|v| v.as_str())
                .unwrap_or("mcpToolCall");
            if server.is_empty() {
                Some(tool.to_string())
            } else {
                Some(format!("{server}.{tool}"))
            }
        }
        Some("commandExecution") => Some("commandExecution".into()),
        Some("dynamicToolCall") => item
            .get("tool")
            .and_then(|v| v.as_str())
            .map(|tool| format!("dynamic.{tool}")),
        _ => None,
    }
}

pub(crate) fn item_tool_input(item: &serde_json::Value) -> serde_json::Value {
    match item.get("type").and_then(|v| v.as_str()) {
        Some("mcpToolCall") => item
            .get("arguments")
            .cloned()
            .unwrap_or(serde_json::Value::Null),
        Some("commandExecution") => serde_json::json!({
            "command": item.get("command").cloned().unwrap_or(serde_json::Value::Null),
            "cwd": item.get("cwd").cloned().unwrap_or(serde_json::Value::Null),
        }),
        Some("dynamicToolCall") => item
            .get("arguments")
            .cloned()
            .unwrap_or(serde_json::Value::Null),
        _ => serde_json::Value::Null,
    }
}

pub(crate) fn tool_result_text(item: &serde_json::Value) -> String {
    match item.get("type").and_then(|v| v.as_str()) {
        Some("mcpToolCall") => {
            if let Some(err) = item
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(|v| v.as_str())
            {
                return err.to_string();
            }
            let Some(result) = item.get("result") else {
                return String::new();
            };
            content_array_text(result.get("content"))
        }
        Some("commandExecution") => item
            .get("aggregatedOutput")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        Some("dynamicToolCall") => item
            .get("contentItems")
            .map(|v| v.to_string())
            .unwrap_or_default(),
        _ => String::new(),
    }
}

pub(crate) fn content_array_text(value: Option<&serde_json::Value>) -> String {
    value
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    item.get("text")
                        .and_then(|v| v.as_str())
                        .or_else(|| item.get("content").and_then(|v| v.as_str()))
                        .map(str::to_string)
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

pub(crate) fn parse_token_usage(value: &serde_json::Value) -> CodexUsage {
    let last = value
        .get("params")
        .and_then(|p| p.get("tokenUsage"))
        .and_then(|u| u.get("last"));
    let u64_at = |key: &str| last.and_then(|o| o.get(key)).and_then(|v| v.as_u64());
    CodexUsage {
        input_tokens: u64_at("inputTokens"),
        output_tokens: u64_at("outputTokens"),
        total_tokens: u64_at("totalTokens"),
        duration_ms: None,
    }
}
