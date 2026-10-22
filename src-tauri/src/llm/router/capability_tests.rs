use super::groups::ProviderGroupLlm;
use super::groups::ProviderGroupState;
use super::rotation::KeyRotatingLlm;
use super::rotation::KeyRotationState;
use crate::llm::ChatRequest;
use crate::llm::ChatResponse;
use crate::llm::ChatTool;
use crate::llm::Llm;
use crate::llm::LlmResult;
use crate::llm::openai_compat::OpenAiCompatProvider;
use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::Arc;

struct RequestCapabilities;
#[async_trait]
impl Llm for RequestCapabilities {
    async fn chat(&self, _: ChatRequest) -> LlmResult<ChatResponse> {
        unreachable!()
    }
    async fn chat_with_tools(&self, req: ChatRequest, _: Vec<ChatTool>) -> LlmResult<ChatResponse> {
        assert!(self.supports_tools_for(&req));
        Ok(ChatResponse {
            content: "tool-capable pin".into(),
            model: req.model_override,
            usage: None,
            tool_calls: vec![],
        })
    }
    fn supports_tools_for(&self, req: &ChatRequest) -> bool {
        req.model_override.as_deref() == Some("tools")
    }
    fn provider_id(&self) -> &str {
        "test"
    }
    fn model(&self) -> &str {
        "no-tools"
    }
}

#[tokio::test]
async fn key_rotation_and_groups_forward_request_capabilities() {
    let rotating: Arc<dyn Llm> = Arc::new(KeyRotatingLlm::new(
        "test",
        vec![Arc::new(RequestCapabilities)],
        Arc::new(KeyRotationState::new()),
    ));
    let group = ProviderGroupLlm::new(
        "group:test",
        Arc::new(ProviderGroupState::new(vec!["test".into()])),
        HashMap::from([("test".into(), rotating.clone())]),
    );
    let req = ChatRequest {
        model_override: Some("tools".into()),
        ..Default::default()
    };
    for provider in [rotating.as_ref(), &group as &dyn Llm] {
        assert!(!provider.supports_tools());
        assert!(!provider.supports_tools_for(&ChatRequest::default()));
        assert!(provider.supports_tools_for(&req));
        assert_eq!(
            provider
                .chat_with_tools(req.clone(), vec![])
                .await
                .unwrap()
                .model
                .as_deref(),
            Some("tools")
        );
    }
    // Providers without the new override still use their old capability implementation.
    let legacy = crate::llm::openai_compat::OpenAiCompatProvider::new(
        "legacy",
        "http://example.invalid",
        "",
        "default",
    );
    assert_eq!(legacy.supports_tools_for(&req), legacy.supports_tools());
}
