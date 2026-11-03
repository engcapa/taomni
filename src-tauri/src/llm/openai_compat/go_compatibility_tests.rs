use super::*;
use crate::llm::{ChatContent, ChatContentPart, ChatMessage};
use serde_json::{Value, json};

#[test]
fn default_headers_and_request_metadata_do_not_change_legacy_body() {
    let provider = OpenAiCompatProvider::new(
        "deepseek",
        "https://example.invalid",
        "test",
        "configured-model",
    );
    assert!(provider.extra_headers.is_empty());
    let mut req = ChatRequest::simple("system", "user");
    let before = openai_request_body("configured-model", &req, false, &[]);
    req.model_override = Some("go-model".into());
    req.session_key = Some("hashed-thread".into());
    assert_eq!(
        before,
        openai_request_body("configured-model", &req, false, &[])
    );
    assert_eq!(before["model"], "configured-model");
    assert!(before.get("model_override").is_none());
}

#[test]
fn legacy_body_golden_retains_max_tokens_temperature_and_stream_false() {
    let mut req = ChatRequest::simple("system", "user");
    req.temperature = Some(0.5);
    assert_eq!(
        openai_request_body("configured", &req, false, &[]),
        json!({
            "model":"configured",
            "messages":[{"role":"system","content":"system"},{"role":"user","content":"user"}],
            "max_tokens":512,"temperature":0.5,"stream":false
        })
    );
    req.max_tokens = None;
    req.temperature = None;
    let body = openai_request_body("configured", &req, true, &[]);
    assert_eq!(body["stream"], true);
    assert!(body.get("max_tokens").is_none());
    assert!(body.get("temperature").is_none());
    assert!(body.get("stream_options").is_none());
    assert!(body.get("max_completion_tokens").is_none());
}

#[test]
fn images_assistant_tools_and_first_tool_result_keep_wire_shape() {
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
                content: ChatContent::Parts(vec![
                    ChatContentPart::Text {
                        text: "first".into(),
                    },
                    ChatContentPart::ToolUse {
                        id: "call-1".into(),
                        name: "read".into(),
                        arguments: json!({"path":"a"}),
                    },
                    ChatContentPart::Text {
                        text: "second".into(),
                    },
                ]),
            },
            ChatMessage {
                role: "user".into(),
                content: ChatContent::Parts(vec![
                    ChatContentPart::ToolResult {
                        tool_call_id: "call-1".into(),
                        content: "result".into(),
                        is_error: true,
                    },
                    ChatContentPart::ToolResult {
                        tool_call_id: "call-2".into(),
                        content: "ignored".into(),
                        is_error: false,
                    },
                ]),
            },
        ],
        ..Default::default()
    };
    let tools = [ChatTool {
        name: "read".into(),
        description: Some("Read a file".into()),
        input_schema: json!({"type":"object"}),
    }];
    let body = openai_request_body("configured", &req, false, &tools);
    assert_eq!(
        body["messages"][0],
        json!({"role":"user","content":[{"type":"text","text":"look"},{"type":"image_url","image_url":{"url":"data:image/png;base64,aGVsbG8="}}]})
    );
    assert_eq!(
        body["messages"][1],
        json!({"role":"assistant","content":"first\n\nsecond","tool_calls":[{"id":"call-1","type":"function","function":{"name":"read","arguments":"{\"path\":\"a\"}"}}]})
    );
    assert_eq!(
        body["messages"][2],
        json!({"role":"tool","tool_call_id":"call-1","content":"result"})
    );
    assert_eq!(
        body["tools"][0],
        json!({"type":"function","function":{"name":"read","description":"Read a file","parameters":{"type":"object"}}})
    );
    assert_eq!(body["tool_choice"], "auto");
}

#[test]
fn go_client_injection_preserves_session_and_header_override_order() {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert("x-opencode-session", "hashed-thread".parse().unwrap());
    headers.insert("authorization", "Bearer go-override".parse().unwrap());
    let provider = OpenAiCompatProvider::new(
        "go",
        "https://example.invalid/custom/",
        "configured-key",
        "configured",
    )
    .with_go_client(Client::builder().no_proxy().build().unwrap(), headers);
    let req = ChatRequest::simple("s", "u");
    let body = openai_request_body(&provider.model, &req, true, &[]);
    let built = request::build(
        &provider.client,
        &provider.base_url,
        &provider.api_key,
        &provider.extra_headers,
        &body,
    )
    .build()
    .unwrap();
    assert_eq!(
        built.url().as_str(),
        "https://example.invalid/custom/chat/completions"
    );
    assert_eq!(built.headers()["authorization"], "Bearer go-override");
    assert_eq!(built.headers()["x-opencode-session"], "hashed-thread");
    assert_eq!(
        serde_json::from_slice::<Value>(built.body().unwrap().as_bytes().unwrap()).unwrap(),
        body
    );
    assert_eq!(provider.provider_id(), "go");
    assert_eq!(provider.model(), "configured");
    assert!(provider.supports_tools());
}

#[test]
fn response_mapping_preserves_first_choice_tool_ids_invalid_json_and_usage() {
    let response: wire_types::ApiResponse = serde_json::from_value(json!({
        "model":"effective", "choices":[{"message":{"content":null,"tool_calls":[
            {"id":"","function":{"name":"first","arguments":"{\"a\":1}"}},
            {"id":"provided","function":{"name":"second","arguments":"not-json"}}
        ]}},{"message":{"content":"ignored"}}],
        "usage":{"prompt_tokens":12,"completion_tokens":3,"total_tokens":15}
    }))
    .unwrap();
    let response = response.into_chat_response();
    assert_eq!(response.content, "");
    assert_eq!(response.model.as_deref(), Some("effective"));
    assert_eq!(response.tool_calls.len(), 2);
    assert_eq!(response.tool_calls[0].id, "call_0");
    assert_eq!(response.tool_calls[0].arguments, json!({"a":1}));
    assert_eq!(response.tool_calls[1].id, "provided");
    assert_eq!(response.tool_calls[1].arguments, json!("not-json"));
    let usage = response.usage.unwrap();
    assert_eq!(
        (
            usage.prompt_tokens,
            usage.completion_tokens,
            usage.total_tokens
        ),
        (12, 3, 15)
    );
    let empty: wire_types::ApiResponse = serde_json::from_value(json!({"choices":[]})).unwrap();
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
