use super::{
    ChatContent, ChatContentPart, ChatRequest, ChatResponse, ChatStreamEvent, ChatTool, Llm,
    LlmError, LlmResult,
};
use crate::ai::config::{CustomLlmModel, LlmProviderConfig};
use async_trait::async_trait;
use futures::stream::BoxStream;
use std::{collections::HashMap, time::Duration};

pub struct ConfiguredProvider {
    id: String,
    model: String,
    models: HashMap<String, (CustomLlmModel, Box<dyn Llm>)>,
}

impl ConfiguredProvider {
    pub fn new(
        id: &str,
        provider: &LlmProviderConfig,
        key: &str,
        proxy: Option<String>,
    ) -> Result<Self, String> {
        provider.validate_custom()?;
        let custom = provider
            .custom
            .as_ref()
            .ok_or("configuration: custom models are missing")?;
        let mut builder = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(20))
            .timeout(Duration::from_secs(120));
        if let Some(proxy) = proxy {
            builder = builder.proxy(
                reqwest::Proxy::all(proxy).map_err(|_| "configuration: invalid provider proxy")?,
            );
        }
        let client = builder
            .build()
            .map_err(|_| "network: cannot create provider client")?;
        let mut models = HashMap::new();
        for model in &custom.models {
            let base = &provider.base_url;
            let transport: Box<dyn Llm> = match provider.runtime.as_str() {
                "anthropic" => Box::new(
                    super::anthropic::AnthropicProvider::new(id, base, key, &model.id)
                        .with_go_client(client.clone(), Default::default())
                        .with_configured_model(model.clone()),
                ),
                "openai-compat" => Box::new(
                    super::openai_compat::OpenAiCompatProvider::new(id, base, key, &model.id)
                        .with_go_client(client.clone(), Default::default())
                        .with_configured_model(model.clone()),
                ),
                "openai-responses" => Box::new(super::opencode_go::transport::MappedProvider {
                    client: client.clone(),
                    base: base.clone(),
                    key: key.to_owned(),
                    model: model.id.clone(),
                    headers: Default::default(),
                    google: false,
                    configured_model: Some(model.clone()),
                }),
                _ => unreachable!("custom protocol validated above"),
            };
            models.insert(model.id.clone(), (model.clone(), transport));
        }
        Ok(Self {
            id: id.to_owned(),
            model: provider.model.clone(),
            models,
        })
    }

    fn model_for(&self, req: &ChatRequest) -> LlmResult<&dyn Llm> {
        let id = req.model_override.as_deref().unwrap_or(&self.model);
        let (model, backend) = self.models.get(id).ok_or_else(|| LlmError::Provider {
            status: 400,
            message: "Choose a configured model".into(),
        })?;
        if !model.multimodal && req.messages.iter().any(|message| matches!(&message.content, ChatContent::Parts(parts) if parts.iter().any(|part| matches!(part, ChatContentPart::Image{..})))) {
            return Err(LlmError::Provider { status: 400, message: "This model does not support image input".into() });
        }
        Ok(backend.as_ref())
    }
}

#[async_trait]
impl Llm for ConfiguredProvider {
    async fn chat(&self, req: ChatRequest) -> LlmResult<ChatResponse> {
        self.model_for(&req)?.chat(req).await
    }
    async fn chat_with_tools(
        &self,
        req: ChatRequest,
        tools: Vec<ChatTool>,
    ) -> LlmResult<ChatResponse> {
        self.model_for(&req)?.chat_with_tools(req, tools).await
    }
    async fn chat_stream(
        &self,
        req: ChatRequest,
    ) -> LlmResult<BoxStream<'static, LlmResult<ChatStreamEvent>>> {
        self.model_for(&req)?.chat_stream(req).await
    }
    fn supports_tools(&self) -> bool {
        true
    }
    fn supports_tools_for(&self, req: &ChatRequest) -> bool {
        self.model_for(req)
            .is_ok_and(|backend| backend.supports_tools_for(req))
    }
    fn provider_id(&self) -> &str {
        &self.id
    }
    fn model(&self) -> &str {
        &self.model
    }
}
