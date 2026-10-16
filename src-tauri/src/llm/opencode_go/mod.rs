pub mod catalog;
pub mod google;
pub mod responses;
mod transport;
#[cfg(test)]
pub(crate) mod test_gateway;

use crate::llm::{ChatRequest, ChatResponse, ChatStreamEvent, ChatTool, Llm, LlmError, LlmResult};
use async_trait::async_trait;
use futures::{StreamExt, stream::BoxStream};
use reqwest::{Client, header::{HeaderMap, HeaderValue}};
use std::{collections::HashMap, sync::{Arc, Mutex}};
use catalog::{CatalogService, valid_protocol};

pub fn client(proxy: Option<&str>, timeout: u64) -> LlmResult<Client> {
    let mut builder = Client::builder().no_proxy()
        .user_agent(concat!("taomni/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(timeout));
    if let Some(proxy) = proxy {
        builder = builder.proxy(reqwest::Proxy::all(proxy)?);
    }
    Ok(builder.build()?)
}

pub fn unavailable(id: String, model: String, message: String) -> Arc<dyn Llm> {
    Arc::new(UnavailableGo { id, model, message })
}
struct UnavailableGo { id: String, model: String, message: String }
#[async_trait]
impl Llm for UnavailableGo {
    async fn chat(&self, _: ChatRequest) -> LlmResult<ChatResponse> {
        Err(LlmError::Provider { status:503,message:self.message.clone() })
    }
    fn provider_id(&self) -> &str { &self.id }
    fn model(&self) -> &str { &self.model }
}

pub struct OpenCodeGoProvider {
    id: String,
    base: String,
    key: String,
    model: String,
    proxy: Option<String>,
    catalog: Arc<CatalogService>,
    overrides: HashMap<String,String>,
    // Four independent connection pools, lazy and shared across request adapters.
    clients: Mutex<HashMap<String,Client>>,
    session: String,
}
impl OpenCodeGoProvider {
    pub fn new(id: String, base: String, key: String, model: String, proxy: Option<String>, catalog: Arc<CatalogService>, overrides: HashMap<String,String>) -> Self {
        Self { id,base,key,model,proxy,catalog,overrides,clients:Mutex::new(HashMap::new()),session:uuid::Uuid::new_v4().simple().to_string() }
    }
    fn effective_model<'a>(&'a self, req: &'a ChatRequest) -> &'a str {
        req.model_override.as_deref().filter(|m| !m.trim().is_empty()).unwrap_or(&self.model)
    }
    fn model_supports_tools(&self, model: &str) -> bool {
        self.catalog.get().models.iter().find(|m| m.id == model).map(|m| m.tool_call).unwrap_or(true)
    }
    fn transport(&self, req: &ChatRequest) -> LlmResult<(Arc<dyn Llm>, bool)> {
        let model = self.effective_model(req);
        let catalog = self.catalog.get();
        let entry = catalog.models.iter().find(|m| m.id == model);
        let protocol = valid_protocol(self.overrides.get(model).map(String::as_str).or(entry.map(|m| m.protocol.as_str())).unwrap_or("chat"));
        let base = entry.and_then(|m| m.base_url.as_deref()).unwrap_or(&self.base);
        let mut clients = self.clients.lock().unwrap();
        let client = if let Some(client) = clients.get(protocol) { client.clone() } else {
            let client = client(self.proxy.as_deref(), if protocol == "chat" {30} else {60})?;
            clients.insert(protocol.into(),client.clone()); client
        };
        let mut headers = HeaderMap::new();
        headers.insert("x-opencode-session", HeaderValue::from_str(req.session_key.as_deref().unwrap_or(&self.session))
            .map_err(|e| LlmError::Provider { status:400,message:format!("Invalid Go session header: {e}") })?);
        let provider: Arc<dyn Llm> = match protocol {
            "chat" => Arc::new(crate::llm::openai_compat::OpenAiCompatProvider::new(&self.id,base,&self.key,model).with_go_client(client,headers)),
            "messages" => Arc::new(crate::llm::anthropic::AnthropicProvider::new(&self.id,base,&self.key,model).with_go_client(client,headers)),
            _ => Arc::new(transport::MappedProvider { client,base:base.into(),key:self.key.clone(),model:model.into(),headers,google:protocol == "google" }),
        };
        Ok((provider, entry.is_none()))
    }
    fn refresh_after<T>(&self, unknown: bool, result: &LlmResult<T>) {
        if unknown || result.as_ref().err().is_some_and(model_missing) { self.catalog.trigger(true); }
    }
}
fn model_missing(error: &LlmError) -> bool {
    let text = error.to_string().to_lowercase();
    text.contains("model") && ["not found","does not exist","unknown","not available","not_found"].iter().any(|s| text.contains(s))
}
#[async_trait]
impl Llm for OpenCodeGoProvider {
    async fn chat(&self, req: ChatRequest) -> LlmResult<ChatResponse> {
        let (transport,unknown) = self.transport(&req)?;
        let result = transport.chat(req).await;
        self.refresh_after(unknown,&result); result
    }
    async fn chat_with_tools(&self, req: ChatRequest, tools: Vec<ChatTool>) -> LlmResult<ChatResponse> {
        let (transport,unknown) = self.transport(&req)?;
        let result = if self.supports_tools_for(&req) {
            transport.chat_with_tools(req,tools).await
        } else {
            transport.chat(req).await
        };
        self.refresh_after(unknown,&result); result
    }
    async fn chat_stream(&self, req: ChatRequest) -> LlmResult<BoxStream<'static,LlmResult<ChatStreamEvent>>> {
        let (transport,unknown) = self.transport(&req)?;
        let result = transport.chat_stream(req).await;
        if result.is_err() { self.refresh_after(unknown,&result); }
        let mut stream = result?;
        let catalog = self.catalog.clone();
        Ok(Box::pin(async_stream::stream! {
            let mut refreshed = false;
            while let Some(event) = stream.next().await {
                let missing = match &event {
                    Err(e) => model_missing(e),
                    Ok(ChatStreamEvent::Error { message }) => model_missing(&LlmError::Provider { status:400,message:message.clone() }),
                    _ => false,
                };
                let terminal = matches!(&event, Err(_) | Ok(ChatStreamEvent::End { .. } | ChatStreamEvent::Error { .. }));
                // Consumers stop at terminal events, so refresh before yielding one.
                if !refreshed && (missing || (unknown && terminal)) { catalog.trigger(true); refreshed = true; }
                yield event;
            }
            if unknown && !refreshed { catalog.trigger(true); }
        }))
    }
    fn supports_tools(&self) -> bool {
        self.model_supports_tools(&self.model)
    }
    fn supports_tools_for(&self, req: &ChatRequest) -> bool {
        self.model_supports_tools(self.effective_model(req))
    }
    fn provider_id(&self) -> &str { &self.id }
    fn model(&self) -> &str { &self.model }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn request_metadata_is_optional_and_errors_are_not_retried() {
        let req = ChatRequest::simple("s","u");
        let json = serde_json::to_value(&req).unwrap();
        assert!(json.get("model_override").is_none());
        assert!(json.get("session_key").is_none());
        assert!(model_missing(&LlmError::Provider { status:404,message:"Model not found".into() }));
        assert!(!model_missing(&LlmError::Provider { status:401,message:"invalid key".into() }));
    }
    #[test]
    fn protocols_override_and_unknown_model() {
        let catalog = Arc::new(CatalogService::new(std::env::temp_dir().join(uuid::Uuid::new_v4().to_string())));
        let go = OpenCodeGoProvider::new("opencode-go".into(),"https://example.invalid/v1".into(),"test".into(),"deepseek-v4.1-flash".into(),None,catalog,HashMap::from([("grok-4.7".into(),"messages".into())]));
        let req = ChatRequest { model_override:Some("grok-4.7".into()),..Default::default() };
        assert_eq!(go.transport(&req).unwrap().0.model(),"grok-4.7");
        assert!(go.clients.lock().unwrap().contains_key("messages"));
        let req = ChatRequest { model_override:Some("unlisted".into()),..Default::default() };
        assert!(go.transport(&req).unwrap().1);
        assert!(go.clients.lock().unwrap().contains_key("chat"));
    }

    #[tokio::test]
    async fn four_protocols_send_correct_endpoints_auth_usage_and_stable_headers() {
        use serde_json::json;
        let responses = [
            ("deepseek-v4.1-flash", "/chat/completions", "authorization: bearer unit-key", json!({"model":"deepseek-v4.1-flash","choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}})),
            ("minimax-m3", "/messages", "x-api-key: unit-key", json!({"model":"minimax-m3","content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":2,"output_tokens":3}})),
            ("grok-4.7", "/responses", "authorization: bearer unit-key", json!({"model":"grok-4.7","output":[{"type":"message","content":[{"type":"output_text","text":"ok"}]}],"usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5}})),
            ("gemini-4-argon-contributor", ":generateContent", "x-goog-api-key: unit-key", json!({"candidates":[{"content":{"parts":[{"text":"ok"}]}}],"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":3,"totalTokenCount":5}})),
        ];
        for (model,endpoint,auth,response) in responses {
            let (base,requests,task) = test_gateway::start(3, move |_| (200,response.to_string(),"application/json")).await;
            let catalog = Arc::new(CatalogService::new(std::env::temp_dir().join(uuid::Uuid::new_v4().to_string())));
            let provider = OpenCodeGoProvider::new("opencode-go".into(),base,"unit-key".into(),model.into(),None,catalog,HashMap::new());
            let a = super::catalog::session_key("thread-a");
            let b = super::catalog::session_key("thread-b");
            assert_eq!(a.len(),32);
            assert_eq!(a,super::catalog::session_key("thread-a"));
            assert_ne!(a,b);
            for session in [a.as_str(),a.as_str(),b.as_str()] {
                let req = ChatRequest { session_key:Some(session.into()),..ChatRequest::simple("code","hi") };
                let result = provider.chat(req).await.unwrap();
                assert_eq!(result.content,"ok");
                assert_eq!(result.usage.unwrap().total_tokens,5);
            }
            task.await.unwrap();
            let requests = requests.lock().unwrap();
            for raw in requests.iter() {
                assert!(raw.contains(endpoint), "{raw}");
                assert!(raw.to_lowercase().contains(auth), "{raw}");
                assert!(raw.to_lowercase().contains(&format!("user-agent: taomni/{}",env!("CARGO_PKG_VERSION"))));
                assert!(!raw.contains("\"session_key\""));
                assert!(!raw.contains("\"model_override\""));
            }
            assert!(requests[0].contains(&format!("x-opencode-session: {a}")));
            assert!(requests[1].contains(&format!("x-opencode-session: {a}")));
            assert!(requests[2].contains(&format!("x-opencode-session: {b}")));
            assert!(requests.iter().all(|raw| !raw.contains("thread-a") && !raw.contains("thread-b")));
        }
    }

    #[tokio::test]
    async fn streaming_new_protocols_and_gateway_errors() {
        for (model,body) in [
            ("grok-4.7", "data: {\"type\":\"response.output_text.delta\",\"delta\":\"你好\"}\r\n\r\ndata: {\"type\":\"response.completed\",\"response\":{\"model\":\"grok-4.7\",\"usage\":{\"input_tokens\":2,\"output_tokens\":3,\"total_tokens\":5}}}\r\n\r\n"),
            ("gemini-4-argon-contributor", "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"你好\"}]}}]}\n\ndata: {\"candidates\":[{\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":2,\"candidatesTokenCount\":3,\"totalTokenCount\":5}}\n\n"),
        ] {
            let (base,requests,task) = test_gateway::start(1,move |_| (200,body.into(),"text/event-stream")).await;
            let provider = OpenCodeGoProvider::new("opencode-go".into(),base,"test".into(),model.into(),None,Arc::new(CatalogService::new(std::env::temp_dir().join(uuid::Uuid::new_v4().to_string()))),HashMap::new());
            let events = provider.chat_stream(ChatRequest::simple("s","u")).await.unwrap().collect::<Vec<_>>().await;
            assert!(matches!(&events[0],Ok(ChatStreamEvent::Token {content}) if content == "你好"));
            assert!(matches!(events.last().unwrap(),Ok(ChatStreamEvent::End {usage:Some(u),..}) if u.total_tokens == 5));
            task.await.unwrap();
            if model.starts_with("gemini") { assert!(requests.lock().unwrap()[0].contains(":streamGenerateContent?alt=sse")); }
        }
        let (base,_,task) = test_gateway::start(1, |_| (403,"subscription required".into(),"text/plain")).await;
        let provider = OpenCodeGoProvider::new("opencode-go".into(),base,"test".into(),"grok-4.7".into(),None,Arc::new(CatalogService::new(std::env::temp_dir().join(uuid::Uuid::new_v4().to_string()))),HashMap::new());
        assert!(matches!(provider.chat(ChatRequest::default()).await,Err(LlmError::Provider {status:403,message}) if message == "subscription required"));
        task.await.unwrap();
    }

    #[tokio::test]
    async fn model_missing_refreshes_once_and_never_resends_or_substitutes() {
        use serde_json::json;
        for stream in [false,true] {
            let (base,requests,task) = test_gateway::start(3,move |raw| {
                if raw.starts_with("GET /models ") { return (200,json!({"data":[{"id":"deepseek-v4.1-flash"}]}).to_string(),"application/json"); }
                if raw.starts_with("GET /metadata ") { return (200,json!({"opencode-go":{"models":{}}}).to_string(),"application/json"); }
                if stream { (200,"data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"message\":\"model not found\"}}}\n\n".into(),"text/event-stream") }
                else { (404,"{\"error\":{\"message\":\"model not found\"}}".into(),"application/json") }
            }).await;
            let catalog = Arc::new(CatalogService::new(std::env::temp_dir().join(uuid::Uuid::new_v4().to_string())).with_metadata_url(format!("{base}/metadata")));
            catalog.configure(base.clone(),Ok(None),false);
            let provider = OpenCodeGoProvider::new("opencode-go".into(),base,"unit-key".into(),"grok-4.7".into(),None,catalog.clone(),
                if stream {HashMap::from([("unknown-pin".into(),"responses".into())])} else {HashMap::new()});
            let req = ChatRequest { model_override:Some("unknown-pin".into()),..Default::default() };
            if stream {
                let events = provider.chat_stream(req).await.unwrap().collect::<Vec<_>>().await;
                assert!(matches!(&events[0],Ok(ChatStreamEvent::Error {message}) if message.contains("model not found")));
            } else {
                assert!(matches!(provider.chat(req).await,Err(LlmError::Provider {status:404,message}) if message == "model not found"));
            }
            task.await.unwrap();
            let raws = requests.lock().unwrap();
            assert_eq!(raws.iter().filter(|r| r.starts_with("POST ")).count(),1);
            assert_eq!(raws.iter().filter(|r| r.starts_with("GET ")).count(),2);
            assert!(raws.iter().find(|r| r.starts_with("POST ")).unwrap().contains("unknown-pin"));
            assert_eq!(provider.model(),"grok-4.7");
        }
    }

    #[tokio::test]
    async fn malformed_or_incomplete_sse_fails_and_proxy_errors_fail_closed() {
        for body in ["data: not-json\n\n","data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n"] {
            let (base,_,task) = test_gateway::start(1,move |_| (200,body.into(),"text/event-stream")).await;
            let provider = OpenCodeGoProvider::new("opencode-go".into(),base,"test".into(),"grok-4.7".into(),None,Arc::new(CatalogService::new(std::env::temp_dir().join(uuid::Uuid::new_v4().to_string()))),HashMap::new());
            let events = provider.chat_stream(ChatRequest::default()).await.unwrap().collect::<Vec<_>>().await;
            assert!(matches!(events.last().unwrap(),Ok(ChatStreamEvent::Error {..})));
            task.await.unwrap();
        }
        let provider = unavailable("opencode-go".into(),"default".into(),"invalid configured proxy".into());
        assert!(matches!(provider.chat(ChatRequest::default()).await,Err(LlmError::Provider {status:503,message}) if message.contains("proxy")));
    }
    #[tokio::test]
    async fn unknown_stream_refreshes_before_consumer_drops_terminal_event() {
        use serde_json::json;
        for body in [
            "data: {\"type\":\"response.completed\",\"response\":{\"model\":\"unknown-pin\"}}\n\n",
            "data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"message\":\"quota exceeded\"}}}\n\n",
            "data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"message\":\"model not found\"}}}\n\n",
            "data: invalid-json\n\n",
        ] {
            let (base, requests, task) = test_gateway::start(3, move |raw| {
                if raw.starts_with("GET /models ") { return (200, json!({"data":[{"id":"unknown-pin"}]}).to_string(), "application/json"); }
                if raw.starts_with("GET /metadata ") { return (200, json!({"opencode-go":{"models":{}}}).to_string(), "application/json"); }
                (200, body.into(), "text/event-stream")
            }).await;
            let dir = tempfile::tempdir().unwrap();
            let catalog = Arc::new(CatalogService::new(dir.path().join("catalog.json")).with_metadata_url(format!("{base}/metadata")));
            catalog.configure(base.clone(), Ok(None), false);
            let provider = OpenCodeGoProvider::new("opencode-go".into(), base, "test".into(), "grok-4.7".into(), None, catalog,
                HashMap::from([("unknown-pin".into(), "responses".into())]));
            let req = ChatRequest { model_override: Some("unknown-pin".into()), ..Default::default() };
            let mut stream = provider.chat_stream(req).await.unwrap();
            loop {
                let event = stream.next().await.expect("terminal event required");
                if matches!(event, Err(_) | Ok(ChatStreamEvent::End { .. } | ChatStreamEvent::Error { .. })) { break; }
            }
            drop(stream); // Exactly how chat_send consumes End/Error: never poll to EOF.
            task.await.unwrap();
            let requests = requests.lock().unwrap();
            assert_eq!(requests.iter().filter(|r| r.starts_with("POST ")).count(), 1);
            assert_eq!(requests.iter().filter(|r| r.starts_with("GET /models ")).count(), 1);
            assert_eq!(requests.iter().filter(|r| r.starts_with("GET /metadata ")).count(), 1);
            assert_eq!(provider.model(), "grok-4.7");
        }
    }

    #[tokio::test]
    async fn pinned_model_controls_tool_capabilities_and_wire_declarations() {
        use serde_json::json;
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("catalog.json");
        let models = catalog::merge(&["with-tools".into(), "without-tools".into()],
            &json!({"models":{"with-tools":{"tool_call":true},"without-tools":{"tool_call":false}}}),
            &json!({}), &HashMap::new());
        std::fs::write(&cache, json!({"fetched_at":1,"digest":catalog::digest(&models),"models":models}).to_string()).unwrap();
        for (default, pinned, supported) in [("with-tools", "without-tools", false), ("without-tools", "with-tools", true)] {
            let (base, requests, task) = test_gateway::start(1, |_| (200,
                json!({"choices":[{"message":{"content":"ok"}}]}).to_string(), "application/json")).await;
            let provider = OpenCodeGoProvider::new("opencode-go".into(), base, "test".into(), default.into(), None,
                Arc::new(CatalogService::new(cache.clone())), HashMap::new());
            let mut req = ChatRequest { model_override: Some(pinned.into()), ..Default::default() };
            assert_eq!(provider.supports_tools(), !supported);
            assert_eq!(provider.supports_tools_for(&req), supported);
            provider.chat_with_tools(req.clone(), vec![ChatTool { name: "example".into(), description: None, input_schema: json!({"type":"object"}) }]).await.unwrap();
            task.await.unwrap();
            let raw = requests.lock().unwrap()[0].clone();
            let body: serde_json::Value = serde_json::from_str(raw.split("\r\n\r\n").nth(1).unwrap()).unwrap();
            assert_eq!(body["model"], pinned);
            assert_eq!(body.get("tools").is_some(), supported);
            req.model_override = Some("  ".into());
            assert_eq!(provider.supports_tools_for(&req), !supported);
            req.model_override = Some("unknown".into());
            assert!(provider.supports_tools_for(&req));
        }
    }

    #[tokio::test]
    async fn configured_proxy_routes_http_and_errors_do_not_retry_direct() {
        let destination = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target = format!("http://{}/chat/completions", destination.local_addr().unwrap());
        let (proxy_url, requests, task) = test_gateway::start(1, |_| (502, "proxy failure".into(), "text/plain")).await;
        let url = reqwest::Url::parse(&proxy_url).unwrap();
        let mut config = crate::ai::config::default_opencode_go_provider();
        config.proxy_mode = "custom".into();
        config.custom_proxy = Some(crate::proxy::AppProxyConfig {
            enabled: true, host: url.host_str().unwrap().into(), port: url.port().unwrap(), ..Default::default()
        });
        let proxy = crate::ai::config::resolve_go_proxy_url(&config, None, None).unwrap();
        let response = client(proxy.as_deref(), 2).unwrap().get(&target).send().await.unwrap();
        assert_eq!(response.status(), 502);
        task.await.unwrap();
        assert!(requests.lock().unwrap()[0].starts_with(&format!("GET {target} ")));
        assert!(tokio::time::timeout(std::time::Duration::from_millis(100), destination.accept()).await.is_err());
        config.proxy_mode = "none".into();
        let (direct, _, task) = test_gateway::start(1, |_| (200, "direct".into(), "text/plain")).await;
        let proxy = crate::ai::config::resolve_go_proxy_url(&config, None, None).unwrap();
        assert_eq!(client(proxy.as_deref(), 2).unwrap().get(direct).send().await.unwrap().text().await.unwrap(), "direct");
        task.await.unwrap();
    }

}
