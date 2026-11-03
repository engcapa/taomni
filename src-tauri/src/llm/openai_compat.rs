mod request;
mod stream;
mod wire_types;

#[cfg(test)]
mod go_compatibility_tests;

use super::{ChatRequest, ChatResponse, ChatStreamEvent, ChatTool, Llm, LlmError, LlmResult};
use async_trait::async_trait;
use futures::stream::BoxStream;
use reqwest::Client;
use serde::Serialize;

use request::body as openai_request_body;
use wire_types::ApiResponse;

/// Provider capabilities — enables router-level decisions like "do we
/// register a client-side `web_search` tool, or trust the provider's
/// native one?". Filled by `OpenAiCompatProvider::preset` and exposed via
/// `Llm::caps()`.
#[derive(Debug, Clone, Default, Serialize)]
pub struct ProviderCaps {
    pub native_web_search: bool,
    pub native_search_implicit: bool,
    pub citation_format: &'static str,
}

impl ProviderCaps {
    pub fn for_provider(id: &str) -> Self {
        match id {
            "openai" => Self {
                native_web_search: true,
                native_search_implicit: false,
                citation_format: "openai_annotations",
            },
            "anthropic" | "claude" => Self {
                native_web_search: true,
                native_search_implicit: false,
                citation_format: "anthropic_cited_text",
            },
            "gemini" => Self {
                native_web_search: true,
                native_search_implicit: false,
                citation_format: "gemini_grounding",
            },
            "grok" | "xai" => Self {
                native_web_search: true,
                native_search_implicit: false,
                citation_format: "grok_citations",
            },
            "mistral" => Self {
                native_web_search: true,
                native_search_implicit: false,
                citation_format: "mistral_sources",
            },
            "glm" => Self {
                native_web_search: true,
                native_search_implicit: false,
                citation_format: "glm_web_search",
            },
            "qwen" | "dashscope" => Self {
                native_web_search: true,
                native_search_implicit: false,
                citation_format: "qwen_search_results",
            },
            "perplexity" | "sonar" => Self {
                native_web_search: true,
                native_search_implicit: true, // searches every call
                citation_format: "perplexity_citations",
            },
            // DeepSeek, Groq, Cerebras, SiliconFlow, local — no native search.
            _ => Self::default(),
        }
    }
}

/// Covers DeepSeek, GLM, SiliconFlow, Groq, Cerebras, Mistral, OpenAI, and any
/// other provider that speaks the OpenAI chat completions API.
pub struct OpenAiCompatProvider {
    extra_headers: reqwest::header::HeaderMap,
    client: Client,
    base_url: String,
    api_key: String,
    model: String,
    provider_id: String,
}

impl OpenAiCompatProvider {
    pub fn new(
        provider_id: impl Into<String>,
        base_url: impl Into<String>,
        api_key: impl Into<String>,
        model: impl Into<String>,
    ) -> Self {
        Self::new_with_proxy_url(provider_id, base_url, api_key, model, None)
    }

    pub fn new_with_proxy_url(
        provider_id: impl Into<String>,
        base_url: impl Into<String>,
        api_key: impl Into<String>,
        model: impl Into<String>,
        proxy_url: Option<String>,
    ) -> Self {
        let mut builder = Client::builder()
            .no_proxy()
            .timeout(std::time::Duration::from_secs(30));
        if let Some(proxy_url) = proxy_url
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            if let Ok(proxy) = reqwest::Proxy::all(proxy_url) {
                builder = builder.proxy(proxy);
            }
        }
        Self {
            extra_headers: reqwest::header::HeaderMap::new(),
            client: builder.build().expect("failed to build reqwest client"),
            base_url: base_url.into().trim_end_matches('/').to_string(),
            api_key: api_key.into(),
            model: model.into(),
            provider_id: provider_id.into(),
        }
    }

    /// Go-only injection; existing constructors retain an empty header map.
    pub fn with_go_client(mut self, client: Client, headers: reqwest::header::HeaderMap) -> Self {
        self.client = client;
        self.extra_headers = headers;
        self
    }

    /// Build a preset for one of the known providers.
    pub fn preset(
        id: &str,
        api_key: impl Into<String>,
        model_override: Option<String>,
    ) -> Option<Self> {
        let (base_url, default_model) = match id {
            "deepseek" => ("https://api.deepseek.com/v1", "deepseek-chat"),
            "agnes" => ("https://apihub.agnes-ai.com/v1", "agnes-2.0-flash"),
            "glm" => ("https://open.bigmodel.cn/api/paas/v4", "glm-4-flash"),
            "siliconflow" => (
                "https://api.siliconflow.cn/v1",
                "Qwen/Qwen2.5-Coder-7B-Instruct",
            ),
            "groq" => ("https://api.groq.com/openai/v1", "llama-3.3-70b-versatile"),
            "cerebras" => ("https://api.cerebras.ai/v1", "llama-3.3-70b"),
            "openai" => ("https://api.openai.com/v1", "gpt-4o-mini"),
            "mistral" => ("https://api.mistral.ai/v1", "mistral-small-latest"),
            "gemini" => (
                "https://generativelanguage.googleapis.com/v1beta/openai",
                "gemini-2.5-flash-lite",
            ),
            "local" => ("http://127.0.0.1:8080/v1", "qwen3-1.7b-q4_k_m"),
            "ollama" => ("http://127.0.0.1:11434/v1", "qwen2.5-coder:1.5b"),
            _ => return None,
        };
        Some(Self::new(
            id,
            base_url,
            api_key,
            model_override.unwrap_or_else(|| default_model.to_string()),
        ))
    }
}

#[async_trait]
impl Llm for OpenAiCompatProvider {
    async fn chat(&self, req: ChatRequest) -> LlmResult<ChatResponse> {
        self.chat_once(req, &[]).await
    }

    async fn chat_with_tools(
        &self,
        req: ChatRequest,
        tools: Vec<ChatTool>,
    ) -> LlmResult<ChatResponse> {
        self.chat_once(req, &tools).await
    }

    fn supports_tools(&self) -> bool {
        true
    }

    async fn chat_stream(
        &self,
        req: ChatRequest,
    ) -> LlmResult<BoxStream<'static, LlmResult<ChatStreamEvent>>> {
        let body = openai_request_body(&self.model, &req, true, &[]);
        let resp = request::build(
            &self.client,
            &self.base_url,
            &self.api_key,
            &self.extra_headers,
            &body,
        )
        .send()
        .await?;

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let message = wire_types::error_message(resp.text().await.unwrap_or_default());
            return Err(LlmError::Provider { status, message });
        }
        Ok(stream::decode(resp.bytes_stream(), self.model.clone()))
    }

    fn provider_id(&self) -> &str {
        &self.provider_id
    }

    fn model(&self) -> &str {
        &self.model
    }
}

impl OpenAiCompatProvider {
    async fn chat_once(&self, req: ChatRequest, tools: &[ChatTool]) -> LlmResult<ChatResponse> {
        let body = openai_request_body(&self.model, &req, false, tools);
        let resp = request::build(
            &self.client,
            &self.base_url,
            &self.api_key,
            &self.extra_headers,
            &body,
        )
        .send()
        .await?;

        let status = resp.status().as_u16();
        if !resp.status().is_success() {
            let message = wire_types::error_message(resp.text().await.unwrap_or_default());
            return Err(LlmError::Provider { status, message });
        }

        let api_resp: ApiResponse = resp.json().await?;
        Ok(api_resp.into_chat_response())
    }
}
