use super::*;
use crate::llm::{ChatContent, ChatContentPart, ChatMessage};
use serde_json::{Value, json};

#[test]
fn default_headers_and_request_metadata_do_not_change_legacy_body() {
    let provider = AnthropicProvider::new(
        "anthropic",
        "https://example.invalid",
        "test",
        "configured-model",
    );
    assert!(provider.extra_headers.is_empty());
    let mut req = ChatRequest::simple("system", "user");
    let before = provider.request_body(&req, false, &[]);
    req.model_override = Some("go-model".into());
    req.session_key = Some("hashed-thread".into());
    assert_eq!(before, provider.request_body(&req, false, &[]));
    assert_eq!(before["model"], "configured-model");
}

#[test]
fn legacy_body_golden_preserves_system_join_default_limit_and_stream_omission() {
    let mut req = ChatRequest {
        messages: vec![
            ChatMessage::system("first"),
            ChatMessage::user("user"),
            ChatMessage::system("second"),
        ],
        ..Default::default()
    };
    assert_eq!(
        request::body("configured", &req, false, &[]),
        json!({
            "model":"configured", "system":"first\n\nsecond", "messages":[{"role":"user","content":"user"}], "max_tokens":1024
        })
    );
    req.max_tokens = Some(22);
    req.temperature = Some(0.5);
    let body = request::body("configured", &req, true, &[]);
    assert_eq!(body["stream"], true);
    assert_eq!(body["max_tokens"], 22);
    assert_eq!(body["temperature"], 0.5);
    assert!(body.get("max_output_tokens").is_none());
}

#[test]
fn image_tool_use_and_tool_result_blocks_keep_native_shape() {
    let req = ChatRequest {
        messages: vec![
            ChatMessage {
                role: "user".into(),
                content: ChatContent::Parts(vec![
                    ChatContentPart::Text {
                        text: "look".into(),
                    },
                    ChatContentPart::Image {
                        mime_type: "image/png".into(),
                        data_base64: "aGVsbG8=".into(),
                    },
                ]),
            },
            ChatMessage {
                role: "assistant".into(),
                content: ChatContent::Parts(vec![ChatContentPart::ToolUse {
                    id: "tool-1".into(),
                    name: "read".into(),
                    arguments: json!({"path":"a"}),
                }]),
            },
            ChatMessage {
                role: "tool".into(),
                content: ChatContent::Parts(vec![ChatContentPart::ToolResult {
                    tool_call_id: "tool-1".into(),
                    content: "result".into(),
                    is_error: true,
                }]),
            },
        ],
        ..Default::default()
    };
    let tools = [ChatTool {
        name: "read".into(),
        description: Some("Read a file".into()),
        input_schema: json!({"type":"object"}),
    }];
    let body = request::body("configured", &req, false, &tools);
    assert_eq!(
        body["messages"][0],
        json!({"role":"user","content":[{"type":"text","text":"look"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"aGVsbG8="}}]})
    );
    assert_eq!(
        body["messages"][1],
        json!({"role":"assistant","content":[{"type":"tool_use","id":"tool-1","name":"read","input":{"path":"a"}}]})
    );
    assert_eq!(
        body["messages"][2],
        json!({"role":"user","content":[{"type":"tool_result","tool_use_id":"tool-1","content":"result","is_error":true}]})
    );
    assert_eq!(
        body["tools"][0],
        json!({"name":"read","description":"Read a file","input_schema":{"type":"object"}})
    );
    assert!(body.get("tool_choice").is_none());
    assert!(body.get("system").is_none());
}

#[test]
fn go_client_preserves_session_version_and_header_override_order() {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert("x-opencode-session", "hashed-thread".parse().unwrap());
    headers.insert("x-api-key", "go-override".parse().unwrap());
    headers.insert("anthropic-version", "test-version".parse().unwrap());
    let provider = AnthropicProvider::new(
        "go",
        "https://example.invalid/custom/",
        "configured-key",
        "configured",
    )
    .with_go_client(Client::builder().no_proxy().build().unwrap(), headers);
    assert_eq!(provider.api_version, "2023-06-01");
    let body = provider.request_body(&ChatRequest::simple("s", "u"), true, &[]);
    let built = request::build(
        &provider.client,
        &provider.base_url,
        &provider.api_key,
        &provider.api_version,
        &provider.extra_headers,
        &body,
    )
    .build()
    .unwrap();
    assert_eq!(
        built.url().as_str(),
        "https://example.invalid/custom/messages"
    );
    assert_eq!(built.headers()["x-api-key"], "go-override");
    assert_eq!(built.headers()["anthropic-version"], "test-version");
    assert_eq!(built.headers()["x-opencode-session"], "hashed-thread");
    assert!(built.headers().get("authorization").is_none());
    assert_eq!(
        serde_json::from_slice::<Value>(built.body().unwrap().as_bytes().unwrap()).unwrap(),
        body
    );
    assert_eq!(provider.provider_id(), "go");
    assert_eq!(provider.model(), "configured");
    assert!(provider.supports_tools());
}

#[test]
fn response_mapping_preserves_concatenation_tool_fallbacks_and_usage() {
    let response: wire_types::ApiResponse = serde_json::from_value(json!({
        "model":"effective","content":[
            {"type":"text","text":"first"},
            {"type":"thinking","thinking":"hidden"},
            {"type":"tool_use","name":""},
            {"type":"tool_use","name":"read"},
            {"type":"text","text":"second"},
            {"type":"tool_use","id":"provided","name":"next","input":{"x":1}}
        ],"usage":{"input_tokens":12,"output_tokens":3}
    }))
    .unwrap();
    let response = response.into_chat_response();
    assert_eq!(response.content, "firstsecond");
    assert_eq!(response.model.as_deref(), Some("effective"));
    assert_eq!(response.tool_calls.len(), 2);
    assert_eq!(response.tool_calls[0].id, "toolu_0");
    assert_eq!(response.tool_calls[0].name, "read");
    assert_eq!(response.tool_calls[0].arguments, json!({}));
    assert_eq!(response.tool_calls[1].id, "provided");
    assert_eq!(response.tool_calls[1].arguments, json!({"x":1}));
    let usage = response.usage.unwrap();
    assert_eq!(
        (
            usage.prompt_tokens,
            usage.completion_tokens,
            usage.total_tokens
        ),
        (12, 3, 15)
    );
    let empty: wire_types::ApiResponse = serde_json::from_value(json!({"content":[]})).unwrap();
    let empty = empty.into_chat_response();
    assert!(empty.content.is_empty());
    assert!(empty.tool_calls.is_empty());
    assert!(empty.usage.is_none());
}

#[test]
fn error_mapping_preserves_provider_message_and_raw_fallback() {
    assert_eq!(
        wire_types::error_message("{\"error\":{\"message\":\"provider error\"}}".into()),
        "provider error"
    );
    assert_eq!(wire_types::error_message("raw error".into()), "raw error");
}

#[path = "stream_tests.rs"]
mod stream_tests;
