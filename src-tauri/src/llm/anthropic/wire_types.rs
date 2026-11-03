use serde::Deserialize;
use serde_json::Value;

use super::super::{ChatResponse, ChatToolCall, TokenUsage};

#[derive(Deserialize)]
pub(super) struct ApiResponse {
    content: Vec<ApiBlock>,
    model: Option<String>,
    usage: Option<ApiUsage>,
}

#[derive(Deserialize)]
struct ApiBlock {
    #[serde(rename = "type")]
    block_type: String,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    input: Option<Value>,
}

#[derive(Deserialize)]
struct ApiUsage {
    input_tokens: u32,
    output_tokens: u32,
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
        let mut text_blocks = Vec::new();
        let mut tool_calls = Vec::new();
        for block in self.content {
            match block.block_type.as_str() {
                "text" => {
                    if let Some(text) = block.text {
                        text_blocks.push(text);
                    }
                }
                "tool_use" => {
                    let name = block.name.unwrap_or_default();
                    if !name.is_empty() {
                        tool_calls.push(ChatToolCall {
                            id: block
                                .id
                                .unwrap_or_else(|| format!("toolu_{}", tool_calls.len())),
                            name,
                            arguments: block
                                .input
                                .unwrap_or_else(|| Value::Object(serde_json::Map::new())),
                        });
                    }
                }
                _ => {}
            }
        }

        let usage = self.usage.map(|u| TokenUsage {
            prompt_tokens: u.input_tokens,
            completion_tokens: u.output_tokens,
            total_tokens: u.input_tokens + u.output_tokens,
        });

        ChatResponse {
            content: text_blocks.join(""),
            model: self.model,
            usage,
            tool_calls,
        }
    }
}

pub(super) fn error_message(text: String) -> String {
    serde_json::from_str::<ApiError>(&text)
        .map(|e| e.error.message)
        .unwrap_or(text)
}
