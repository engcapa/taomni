// ⚠️ This module must NOT use crate::asr::*
// LLM receives plain text; it does not know about audio or ASR.

pub mod anthropic;
pub mod gpu_detect;
pub mod llama_server;
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
    /// The provider's API key is stored as a `vault:<id>` reference but the
    /// vault is currently locked (or the entry could not be resolved). The
    /// frontend matches on the literal `VAULT_LOCKED` substring to surface
    /// the unlock dialog — keep it stable.
    #[error("VAULT_LOCKED: provider '{provider}' needs the vault unlocked to load its API key")]
    VaultLocked { provider: String },
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
#[serde(untagged)]
pub enum ChatContent {
    Text(String),
    Parts(Vec<ChatContentPart>),
}

impl ChatContent {
    pub fn text(content: impl Into<String>) -> Self {
        Self::Text(content.into())
    }

    pub fn as_text_lossy(&self) -> String {
        match self {
            Self::Text(text) => text.clone(),
            Self::Parts(parts) => parts
                .iter()
                .filter_map(|part| match part {
                    ChatContentPart::Text { text } => Some(text.as_str()),
                    ChatContentPart::Image { .. } => None,
                })
                .collect::<Vec<_>>()
                .join("\n\n"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ChatContentPart {
    Text { text: String },
    Image {
        mime_type: String,
        data_base64: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: ChatContent,
}

impl ChatMessage {
    pub fn system(content: impl Into<String>) -> Self {
        Self {
            role: "system".into(),
            content: ChatContent::text(content),
        }
    }
    pub fn user(content: impl Into<String>) -> Self {
        Self {
            role: "user".into(),
            content: ChatContent::text(content),
        }
    }
    pub fn assistant(content: impl Into<String>) -> Self {
        Self {
            role: "assistant".into(),
            content: ChatContent::text(content),
        }
    }
    pub fn user_parts(parts: Vec<ChatContentPart>) -> Self {
        Self {
            role: "user".into(),
            content: ChatContent::Parts(parts),
        }
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
            messages: vec![ChatMessage::system(system), ChatMessage::user(user)],
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

    /// Streaming chat. Default implementation yields a single full event from
    /// the non-streaming `chat` method, so providers that don't natively
    /// stream still satisfy the trait.
    async fn chat_stream(
        &self,
        req: ChatRequest,
    ) -> LlmResult<futures::stream::BoxStream<'static, LlmResult<ChatStreamEvent>>> {
        let resp = self.chat(req).await?;
        let model = resp.model.clone();
        let usage = resp.usage.clone();
        let content = resp.content.clone();
        let s = futures::stream::iter(vec![
            Ok(ChatStreamEvent::Token { content }),
            Ok(ChatStreamEvent::End { model, usage }),
        ]);
        Ok(Box::pin(s))
    }

    /// Provider identifier for logging/display.
    fn provider_id(&self) -> &str;

    /// Model name being used.
    fn model(&self) -> &str;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ChatStreamEvent {
    /// Incremental text token(s).
    Token { content: String },
    /// Stream finished cleanly. May include the final model id and token usage.
    End {
        #[serde(skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        usage: Option<TokenUsage>,
    },
    /// Stream ended with an error.
    Error { message: String },
}
