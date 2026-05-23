// ⚠️ This module must NOT use crate::asr::*
// LLM receives plain text; it does not know about audio or ASR.

pub mod openai_compat;
pub mod router;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum LlmError {
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("Provider error: {status} — {message}")]
    Provider { status: u16, message: String },
    #[error("Timeout after {ms}ms")]
    Timeout { ms: u64 },
    #[error("No provider configured for task {0:?}")]
    NoProvider(TaskKind),
    #[error("Serialization error: {0}")]
    Serde(#[from] serde_json::Error),
}

pub type LlmResult<T> = Result<T, LlmError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskKind {
    VoiceIntent,
    VoiceToShell,
    TabCompletion,
    CommandRewrite,
    ChatDrawer,
    InlineQq,
    AgentDefault,
    WebSearch,
    CodeMode,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

impl ChatMessage {
    pub fn system(content: impl Into<String>) -> Self {
        Self { role: "system".into(), content: content.into() }
    }
    pub fn user(content: impl Into<String>) -> Self {
        Self { role: "user".into(), content: content.into() }
    }
    pub fn assistant(content: impl Into<String>) -> Self {
        Self { role: "assistant".into(), content: content.into() }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatRequest {
    pub messages: Vec<ChatMessage>,
    pub max_tokens: Option<u32>,
    pub temperature: Option<f32>,
    pub stream: bool,
}

impl ChatRequest {
    pub fn simple(system: impl Into<String>, user: impl Into<String>) -> Self {
        Self {
            messages: vec![
                ChatMessage::system(system),
                ChatMessage::user(user),
            ],
            max_tokens: Some(512),
            temperature: Some(0.3),
            stream: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatResponse {
    pub content: String,
    pub model: Option<String>,
    pub usage: Option<TokenUsage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenUsage {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub total_tokens: u32,
}

#[async_trait]
pub trait Llm: Send + Sync {
    async fn chat(&self, req: ChatRequest) -> LlmResult<ChatResponse>;

    /// Provider identifier for logging/display.
    fn provider_id(&self) -> &str;

    /// Model name being used.
    fn model(&self) -> &str;
}
