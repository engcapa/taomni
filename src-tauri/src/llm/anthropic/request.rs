use reqwest::{Client, RequestBuilder, header::HeaderMap};
use serde_json::{Value, json};

use super::super::{ChatContent, ChatContentPart, ChatMessage, ChatRequest, ChatTool};

pub(super) fn build(
    client: &Client,
    base_url: &str,
    api_key: &str,
    api_version: &str,
    extra_headers: &HeaderMap,
    body: &Value,
) -> RequestBuilder {
    client
        .post(format!("{base_url}/messages"))
        .header("x-api-key", api_key)
        .header("anthropic-version", api_version)
        .headers(extra_headers.clone())
        .json(body)
}

fn split_system_user(messages: &[ChatMessage]) -> (Option<String>, Vec<Value>) {
    let mut system: Option<String> = None;
    let mut convo: Vec<Value> = Vec::with_capacity(messages.len());
    for m in messages {
        match m.role.as_str() {
            "system" => {
                if let Some(existing) = system.as_mut() {
                    existing.push_str("\n\n");
                    existing.push_str(&m.content.as_text_lossy());
                } else {
                    system = Some(m.content.as_text_lossy());
                }
            }
            role => {
                let anthropic_role = if role == "tool" { "user" } else { role };
                convo.push(json!({
                    "role": anthropic_role,
                    "content": anthropic_content(&m.content),
                }));
            }
        }
    }
    (system, convo)
}

pub(super) fn body(model: &str, req: &ChatRequest, stream: bool, tools: &[ChatTool]) -> Value {
    let (system, messages) = split_system_user(&req.messages);
    let mut body = json!({
        "model": model,
        "messages": messages,
        "max_tokens": req.max_tokens.unwrap_or(1024),
    });
    if stream {
        body["stream"] = json!(true);
    }
    if let Some(temp) = req.temperature {
        body["temperature"] = json!(temp);
    }
    if let Some(s) = system {
        body["system"] = json!(s);
    }
    if !tools.is_empty() {
        body["tools"] = Value::Array(tools.iter().map(anthropic_tool).collect());
    }
    body
}

fn anthropic_content(content: &ChatContent) -> Value {
    match content {
        ChatContent::Text(text) => Value::String(text.clone()),
        ChatContent::Parts(parts) => Value::Array(
            parts
                .iter()
                .map(|part| match part {
                    ChatContentPart::Text { text } => {
                        json!({ "type": "text", "text": text })
                    }
                    ChatContentPart::Image {
                        mime_type,
                        data_base64,
                    } => {
                        json!({
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": mime_type,
                                "data": data_base64
                            }
                        })
                    }
                    ChatContentPart::ToolUse {
                        id,
                        name,
                        arguments,
                    } => json!({
                        "type": "tool_use",
                        "id": id,
                        "name": name,
                        "input": arguments
                    }),
                    ChatContentPart::ToolResult {
                        tool_call_id,
                        content,
                        is_error,
                    } => json!({
                        "type": "tool_result",
                        "tool_use_id": tool_call_id,
                        "content": content,
                        "is_error": is_error,
                    }),
                })
                .collect(),
        ),
    }
}

fn anthropic_tool(tool: &ChatTool) -> Value {
    let mut value = json!({
        "name": &tool.name,
        "input_schema": tool.input_schema.clone(),
    });
    if let Some(description) = tool.description.as_ref() {
        value["description"] = json!(description);
    }
    value
}
