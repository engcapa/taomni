use crate::llm::ChatRequest;
use crate::llm::ChatResponse;
use crate::llm::ChatStreamEvent;
use crate::llm::ChatTool;
use crate::llm::Llm;
use crate::llm::LlmError;
use crate::llm::LlmResult;
use crate::llm::TaskKind;
use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

pub const PROVIDER_GROUP_PREFIX: &str = "group:";

pub fn provider_group_route_id(group_id: &str) -> String {
    if group_id.starts_with(PROVIDER_GROUP_PREFIX) {
        group_id.to_string()
    } else {
        format!("{PROVIDER_GROUP_PREFIX}{group_id}")
    }
}

pub fn provider_group_id_from_route(route_id: &str) -> Option<&str> {
    route_id.strip_prefix(PROVIDER_GROUP_PREFIX)
}

pub(super) struct ProviderGroupState {
    pub(super) provider_ids: Vec<String>,
    pub(super) next_provider: AtomicUsize,
}

impl ProviderGroupState {
    pub(super) fn new(provider_ids: Vec<String>) -> Self {
        Self {
            provider_ids,
            next_provider: AtomicUsize::new(0),
        }
    }

    pub(super) fn len(&self) -> usize {
        self.provider_ids.len()
    }

    pub(super) fn next_provider_id(&self) -> Option<String> {
        if self.provider_ids.is_empty() {
            return None;
        }
        let idx = self.next_provider.fetch_add(1, Ordering::Relaxed) % self.provider_ids.len();
        self.provider_ids.get(idx).cloned()
    }
}

pub(super) struct ProviderGroupLlm {
    pub(super) route_id: String,
    pub(super) state: Arc<ProviderGroupState>,
    pub(super) providers: HashMap<String, Arc<dyn Llm>>,
}

impl ProviderGroupLlm {
    pub(super) fn new(
        route_id: impl Into<String>,
        state: Arc<ProviderGroupState>,
        providers: HashMap<String, Arc<dyn Llm>>,
    ) -> Self {
        Self {
            route_id: route_id.into(),
            state,
            providers,
        }
    }
}

#[async_trait]
impl Llm for ProviderGroupLlm {
    async fn chat(&self, req: ChatRequest) -> LlmResult<ChatResponse> {
        let mut last_err = None;
        for _ in 0..self.state.len() {
            let Some(provider_id) = self.state.next_provider_id() else {
                break;
            };
            let Some(provider) = self.providers.get(&provider_id).cloned() else {
                continue;
            };
            match provider.chat(req.clone()).await {
                Ok(resp) => return Ok(resp),
                Err(err) => {
                    tracing::warn!(
                        group = %self.route_id,
                        provider = %provider_id,
                        error = %err,
                        "LLM provider group member failed, trying next provider"
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
        for _ in 0..self.state.len() {
            let Some(provider_id) = self.state.next_provider_id() else {
                break;
            };
            let Some(provider) = self.providers.get(&provider_id).cloned() else {
                continue;
            };
            if !provider.supports_tools_for(&req) {
                continue;
            }
            match provider.chat_with_tools(req.clone(), tools.clone()).await {
                Ok(resp) => return Ok(resp),
                Err(err) => {
                    tracing::warn!(
                        group = %self.route_id,
                        provider = %provider_id,
                        error = %err,
                        "LLM provider group member failed during tool call, trying next provider"
                    );
                    last_err = Some(err);
                }
            }
        }
        Err(last_err.unwrap_or(LlmError::Provider {
            status: 400,
            message: format!(
                "provider group '{}' has no tool-capable providers",
                self.route_id
            ),
        }))
    }

    fn supports_tools(&self) -> bool {
        self.providers
            .values()
            .any(|provider| provider.supports_tools())
    }

    fn supports_tools_for(&self, req: &ChatRequest) -> bool {
        self.providers
            .values()
            .any(|provider| provider.supports_tools_for(req))
    }

    async fn chat_stream(
        &self,
        req: ChatRequest,
    ) -> LlmResult<futures::stream::BoxStream<'static, LlmResult<ChatStreamEvent>>> {
        let mut last_err = None;
        for _ in 0..self.state.len() {
            let Some(provider_id) = self.state.next_provider_id() else {
                break;
            };
            let Some(provider) = self.providers.get(&provider_id).cloned() else {
                continue;
            };
            match provider.chat_stream(req.clone()).await {
                Ok(stream) => return Ok(stream),
                Err(err) => {
                    tracing::warn!(
                        group = %self.route_id,
                        provider = %provider_id,
                        error = %err,
                        "LLM provider group member failed before stream started, trying next provider"
                    );
                    last_err = Some(err);
                }
            }
        }
        Err(last_err.unwrap_or(LlmError::NoProvider(TaskKind::ChatDrawer)))
    }

    fn provider_id(&self) -> &str {
        &self.route_id
    }

    fn model(&self) -> &str {
        "provider-group"
    }
}
