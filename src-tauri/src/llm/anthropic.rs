mod request;
mod stream;
mod wire_types;

#[cfg(test)]
mod go_compatibility_tests;

use super::{ChatRequest, ChatResponse, ChatStreamEvent, ChatTool, Llm, LlmError, LlmResult};
use async_trait::async_trait;
use futures::stream::BoxStream;
use reqwest::Client;

use wire_types::ApiResponse;

/// Anthropic Messages API provider (`POST {base_url}/messages`).
///
/// The Messages API differs from OpenAI's chat completions API in three places:
/// 1. `system` is a top-level field, not a role in `messages`.
/// 2. Auth header is `x-api-key`, not `Authorization: Bearer`.
/// 3. Streaming events are a documented set (`message_start`,
///    `content_block_delta`, `message_delta`, `message_stop`) rather than
///    OpenAI's `data: {choices: [{delta: ...}]}` chunks.
pub struct AnthropicProvider {
    extra_headers: reqwest::header::HeaderMap,
    client: Client,
    base_url: String,
    api_key: String,
    model: String,
    provider_id: String,
    api_version: String,
}

impl AnthropicProvider {
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
            .timeout(std::time::Duration::from_secs(60));
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
            api_version: "2023-06-01".into(),
        }
    }

    pub fn with_go_client(mut self, client: Client, headers: reqwest::header::HeaderMap) -> Self {
        self.client = client;
        self.extra_headers = headers;
        self
    }

    pub fn preset(api_key: impl Into<String>, model_override: Option<String>) -> Self {
        Self::new(
            "anthropic",
            "https://api.anthropic.com/v1",
            api_key,
            model_override.unwrap_or_else(|| "claude-sonnet-4-5".into()),
        )
    }

    fn request_body(
        &self,
        req: &ChatRequest,
        stream: bool,
        tools: &[ChatTool],
    ) -> serde_json::Value {
        request::body(&self.model, req, stream, tools)
    }

    async fn chat_once(&self, req: ChatRequest, tools: &[ChatTool]) -> LlmResult<ChatResponse> {
        let body = self.request_body(&req, false, tools);
        let resp = request::build(
            &self.client,
            &self.base_url,
            &self.api_key,
            &self.api_version,
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

        let api_resp: ApiResponse = resp.json().await?;
        Ok(api_resp.into_chat_response())
    }
}

#[async_trait]
impl Llm for AnthropicProvider {
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
        let body = self.request_body(&req, true, &[]);
        let resp = request::build(
            &self.client,
            &self.base_url,
            &self.api_key,
            &self.api_version,
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
