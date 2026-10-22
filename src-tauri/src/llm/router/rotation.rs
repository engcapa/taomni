use crate::llm::ChatRequest;
use crate::llm::ChatResponse;
use crate::llm::ChatStreamEvent;
use crate::llm::ChatTool;
use crate::llm::Llm;
use crate::llm::LlmError;
use crate::llm::LlmResult;
use crate::llm::TaskKind;
use async_trait::async_trait;
use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

pub(super) struct KeyRotatingLlm {
    pub(super) provider_id: String,
    pub(super) model: String,
    pub(super) variants: Vec<Arc<dyn Llm>>,
    pub(super) key_state: Arc<KeyRotationState>,
}

impl KeyRotatingLlm {
    pub(super) fn new(
        provider_id: impl Into<String>,
        variants: Vec<Arc<dyn Llm>>,
        key_state: Arc<KeyRotationState>,
    ) -> Self {
        let model = variants
            .first()
            .map(|provider| provider.model().to_string())
            .unwrap_or_default();
        Self {
            provider_id: provider_id.into(),
            model,
            variants,
            key_state,
        }
    }

    pub(super) fn next_variant(&self) -> Option<Arc<dyn Llm>> {
        if self.variants.is_empty() {
            return None;
        }
        let idx = self.key_state.next_key_index(self.variants.len());
        self.variants.get(idx).cloned()
    }
}

pub(super) struct KeyRotationState {
    pub(super) next_key: AtomicUsize,
}

impl KeyRotationState {
    pub(super) fn new() -> Self {
        Self {
            next_key: AtomicUsize::new(0),
        }
    }

    pub(super) fn next_key_index(&self, key_count: usize) -> usize {
        if key_count <= 1 {
            0
        } else {
            self.next_key.fetch_add(1, Ordering::Relaxed) % key_count
        }
    }
}

#[async_trait]
impl Llm for KeyRotatingLlm {
    async fn chat(&self, req: ChatRequest) -> LlmResult<ChatResponse> {
        let mut last_err = None;
        for _ in 0..self.variants.len() {
            let Some(provider) = self.next_variant() else {
                break;
            };
            match provider.chat(req.clone()).await {
                Ok(resp) => return Ok(resp),
                Err(err) => {
                    tracing::warn!(
                        provider = %self.provider_id,
                        key_model = %provider.model(),
                        error = %err,
                        "LLM provider key failed, trying next key"
                    );
                    last_err = Some(err);
                }
            }
        }
        Err(last_err.unwrap_or(LlmError::NoProvider(TaskKind::ChatDrawer)))
    }

    async fn chat_with_tools(
        &self,
        req: ChatRequest,
        tools: Vec<ChatTool>,
    ) -> LlmResult<ChatResponse> {
        let mut last_err = None;
        for _ in 0..self.variants.len() {
            let Some(provider) = self.next_variant() else {
                break;
            };
            match provider.chat_with_tools(req.clone(), tools.clone()).await {
                Ok(resp) => return Ok(resp),
                Err(err) => {
                    tracing::warn!(
                        provider = %self.provider_id,
                        key_model = %provider.model(),
                        error = %err,
                        "LLM provider key failed during tool call, trying next key"
                    );
                    last_err = Some(err);
                }
            }
        }
        Err(last_err.unwrap_or(LlmError::NoProvider(TaskKind::ChatDrawer)))
    }

    fn supports_tools(&self) -> bool {
        self.variants
            .iter()
            .any(|provider| provider.supports_tools())
    }

    fn supports_tools_for(&self, req: &ChatRequest) -> bool {
        self.variants
            .iter()
            .any(|provider| provider.supports_tools_for(req))
    }

    async fn chat_stream(
        &self,
        req: ChatRequest,
    ) -> LlmResult<futures::stream::BoxStream<'static, LlmResult<ChatStreamEvent>>> {
        let mut last_err = None;
        for _ in 0..self.variants.len() {
            let Some(provider) = self.next_variant() else {
                break;
            };
            match provider.chat_stream(req.clone()).await {
                Ok(stream) => return Ok(stream),
                Err(err) => {
                    tracing::warn!(
                        provider = %self.provider_id,
                        key_model = %provider.model(),
                        error = %err,
                        "LLM provider key failed before stream started, trying next key"
                    );
                    last_err = Some(err);
                }
            }
        }
        Err(last_err.unwrap_or(LlmError::NoProvider(TaskKind::ChatDrawer)))
    }

    fn provider_id(&self) -> &str {
        &self.provider_id
    }

    fn model(&self) -> &str {
        &self.model
    }
}
