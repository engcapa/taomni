use serde::Deserialize;
use serde_json::Value;

use super::super::{ChatResponse, ChatToolCall, TokenUsage};

#[derive(Deserialize)]
pub(super) struct ApiResponse {
    choices: Vec<Choice>,
    model: Option<String>,
    usage: Option<ApiUsage>,
}

#[derive(Deserialize)]
struct Choice {
    message: ApiMessage,
}

#[derive(Deserialize)]
struct ApiMessage {
    content: Option<String>,
    #[serde(default)]
    tool_calls: Vec<ApiToolCall>,
}

#[derive(Deserialize)]
struct ApiToolCall {
    id: String,
    function: ApiFunctionCall,
}

#[derive(Deserialize)]
struct ApiFunctionCall {
    name: String,
    arguments: String,
}

#[derive(Deserialize)]
struct ApiUsage {
    prompt_tokens: u32,
    completion_tokens: u32,
    total_tokens: u32,
}

#[derive(Deserialize)]
struct ApiError {
    error: ApiErrorBody,
}

#[derive(Deserialize)]
struct ApiErrorBody {
    message: String,
}

impl ApiResponse {
    pub fn into_chat_response(self) -> ChatResponse {
        let message = self.choices.into_iter().next().map(|c| c.message);
        let (content, tool_calls) = match message {
            Some(message) => (
                message.content.unwrap_or_default(),
                parse_openai_tool_calls(message.tool_calls),
            ),
            None => (String::new(), Vec::new()),
        };

        ChatResponse {
            content,
            model: self.model,
            usage: self.usage.map(|u| TokenUsage {
                prompt_tokens: u.prompt_tokens,
                completion_tokens: u.completion_tokens,
                total_tokens: u.total_tokens,
            }),
            tool_calls,
        }
    }
}

pub(super) fn error_message(text: String) -> String {
    serde_json::from_str::<ApiError>(&text)
        .map(|e| e.error.message)
        .unwrap_or(text)
}

fn parse_openai_tool_calls(calls: Vec<ApiToolCall>) -> Vec<ChatToolCall> {
    calls
        .into_iter()
        .enumerate()
        .map(|(idx, call)| {
            let arguments = serde_json::from_str(&call.function.arguments)
                .unwrap_or_else(|_| Value::String(call.function.arguments));
            ChatToolCall {
                id: if call.id.is_empty() {
                    format!("call_{idx}")
                } else {
                    call.id
                },
                name: call.function.name,
                arguments,
            }
        })
        .collect()
}

#[derive(Deserialize)]
pub(super) struct StreamChunk {
    pub choices: Vec<StreamChoice>,
    #[serde(default)]
    pub model: Option<String>,
}

#[derive(Deserialize)]
pub(super) struct StreamChoice {
    pub delta: StreamDelta,
}

#[derive(Deserialize)]
pub(super) struct StreamDelta {
    #[serde(default)]
    pub content: Option<String>,
}
