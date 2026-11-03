use reqwest::{Client, RequestBuilder, header::HeaderMap};
use serde_json::{Value, json};

use super::super::{
    ChatContent, ChatContentPart, ChatMessage, ChatRequest, ChatTool, ChatToolCall,
};

pub(super) fn build(
    client: &Client,
    base_url: &str,
    api_key: &str,
    extra_headers: &HeaderMap,
    body: &Value,
) -> RequestBuilder {
    client
        .post(format!("{base_url}/chat/completions"))
        .bearer_auth(api_key)
        .headers(extra_headers.clone())
        .json(body)
}

pub(super) fn body(model: &str, req: &ChatRequest, stream: bool, tools: &[ChatTool]) -> Value {
    let messages: Vec<Value> = req.messages.iter().map(openai_message).collect();
    let mut body = json!({
        "model": model,
        "messages": messages,
        "stream": stream,
    });
    if let Some(max_tokens) = req.max_tokens {
        body["max_tokens"] = json!(max_tokens);
    }
    if let Some(temp) = req.temperature {
        body["temperature"] = json!(temp);
    }
    if !tools.is_empty() {
        body["tools"] = Value::Array(tools.iter().map(openai_tool).collect());
        body["tool_choice"] = json!("auto");
    }
    body
}

fn openai_message(message: &ChatMessage) -> Value {
    if let Some(result) = first_tool_result(&message.content) {
        return json!({
            "role": "tool",
            "tool_call_id": result.tool_call_id,
            "content": result.content,
        });
    }

    let tool_calls = tool_use_parts(&message.content);
    if message.role == "assistant" && !tool_calls.is_empty() {
        let text = text_parts(&message.content);
        return json!({
            "role": "assistant",
            "content": if text.is_empty() { Value::Null } else { Value::String(text) },
            "tool_calls": tool_calls
                .into_iter()
                .map(|call| json!({
                    "id": call.id,
                    "type": "function",
                    "function": {
                        "name": call.name,
                        "arguments": call.arguments.to_string(),
                    },
                }))
                .collect::<Vec<_>>(),
        });
    }

    json!({ "role": &message.role, "content": openai_content(&message.content) })
}

fn openai_content(content: &ChatContent) -> Value {
    match content {
        ChatContent::Text(text) => Value::String(text.clone()),
        ChatContent::Parts(parts) => Value::Array(
            parts
                .iter()
                .filter_map(|part| match part {
                    ChatContentPart::Text { text } => Some(json!({ "type": "text", "text": text })),
                    ChatContentPart::Image {
                        mime_type,
                        data_base64,
                    } => Some(json!({
                            "type": "image_url",
                            "image_url": {
                                "url": format!("data:{};base64,{}", mime_type, data_base64)
                            }
                    })),
                    ChatContentPart::ToolUse { .. } | ChatContentPart::ToolResult { .. } => None,
                })
                .collect(),
        ),
    }
}

fn openai_tool(tool: &ChatTool) -> Value {
    let mut function = json!({
        "name": &tool.name,
        "parameters": tool.input_schema.clone(),
    });
    if let Some(description) = tool.description.as_ref() {
        function["description"] = json!(description);
    }
    json!({
        "type": "function",
        "function": function,
    })
}

struct ToolResultPart<'a> {
    tool_call_id: &'a str,
    content: &'a str,
}

fn first_tool_result(content: &ChatContent) -> Option<ToolResultPart<'_>> {
    match content {
        ChatContent::Text(_) => None,
        ChatContent::Parts(parts) => parts.iter().find_map(|part| match part {
            ChatContentPart::ToolResult {
                tool_call_id,
                content,
                ..
            } => Some(ToolResultPart {
                tool_call_id,
                content,
            }),
            _ => None,
        }),
    }
}

fn tool_use_parts(content: &ChatContent) -> Vec<ChatToolCall> {
    match content {
        ChatContent::Text(_) => Vec::new(),
        ChatContent::Parts(parts) => parts
            .iter()
            .filter_map(|part| match part {
                ChatContentPart::ToolUse {
                    id,
                    name,
                    arguments,
                } => Some(ChatToolCall {
                    id: id.clone(),
                    name: name.clone(),
                    arguments: arguments.clone(),
                }),
                _ => None,
            })
            .collect(),
    }
}

fn text_parts(content: &ChatContent) -> String {
    match content {
        ChatContent::Text(text) => text.clone(),
        ChatContent::Parts(parts) => parts
            .iter()
            .filter_map(|part| match part {
                ChatContentPart::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n\n"),
    }
}
