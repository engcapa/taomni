use super::permissions::AcpPermissionOptionKind;
use super::permissions::is_taomni_mcp_tool_name;
use super::permissions::parse_permission_request;
use super::permissions::permission_cancelled_response;
use super::permissions::permission_selected_response;
use super::requests::AcpResourceLink;
use super::requests::cancel_notification;
use super::requests::initialize_request;
use super::requests::new_session_request;
use super::requests::prompt_request;
use super::requests::prompt_with_resource_links_request;
use super::responses::AcpAgentInfo;
use super::responses::AcpAuthMethod;
use super::responses::AcpPromptResult;
use super::responses::AcpStopReason;
use super::responses::parse_initialize_result;
use super::responses::parse_prompt_result;
use super::responses::session_id_from_response;
use super::update_model::AcpGeneratedMedia;
use super::update_model::AcpSessionUpdate;
use super::update_model::AcpUsageUpdate;
use super::updates::parse_session_update;
use super::wire::AcpIncomingMessage;
use super::wire::AcpProtocolError;
use super::wire::AcpRequestId;
use super::wire::AcpRpcError;
use super::wire::METHOD_INITIALIZE;
use super::wire::parse_incoming_line;
use crate::agent::local::LocalAgentEvent;
use crate::agent::local::LocalAgentUsage;
use serde_json::Value;
use serde_json::json;

#[test]
fn builders_follow_acp_v1_and_advertise_restricted_capabilities() {
    let initialize = initialize_request(1, "taomni", "0.3.0");
    assert_eq!(initialize.method, METHOD_INITIALIZE);
    assert_eq!(
        serde_json::to_value(initialize).unwrap(),
        json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": 1,
                "clientCapabilities": {
                    "fs": { "readTextFile": false, "writeTextFile": false },
                    "terminal": false,
                },
                "clientInfo": { "name": "taomni", "version": "0.3.0" },
            },
        }),
    );

    assert_eq!(
        serde_json::to_value(new_session_request(2, "/workspace", vec![])).unwrap(),
        json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "session/new",
            "params": { "cwd": "/workspace", "mcpServers": [] },
        }),
    );
    assert_eq!(
        serde_json::to_value(prompt_request(3, "session-1", "hello")).unwrap(),
        json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "session/prompt",
            "params": {
                "sessionId": "session-1",
                "prompt": [{ "type": "text", "text": "hello" }],
            },
        }),
    );
    assert_eq!(
        serde_json::to_value(prompt_with_resource_links_request(
            4,
            "session-1",
            "Describe the attachment.",
            &[AcpResourceLink::new(
                "file:///workspace/reference%20image.png",
                "reference image.png",
                Some("image/png".into()),
            )],
        ))
        .unwrap(),
        json!({
            "jsonrpc": "2.0",
            "id": 4,
            "method": "session/prompt",
            "params": {
                "sessionId": "session-1",
                "prompt": [
                    { "type": "text", "text": "Describe the attachment." },
                    {
                        "type": "resource_link",
                        "uri": "file:///workspace/reference%20image.png",
                        "name": "reference image.png",
                        "mimeType": "image/png",
                    },
                ],
            },
        }),
    );
    assert_eq!(
        serde_json::to_value(cancel_notification("session-1")).unwrap(),
        json!({
            "jsonrpc": "2.0",
            "method": "session/cancel",
            "params": { "sessionId": "session-1" },
        }),
    );
}

#[test]
fn parses_json_rpc_response_error_notification_and_peer_request() {
    assert_eq!(
        parse_incoming_line(r#"{"jsonrpc":"2.0","id":7,"result":{"sessionId":"s1"}}"#).unwrap(),
        AcpIncomingMessage::Response {
            id: AcpRequestId::Number(7),
            result: json!({ "sessionId": "s1" }),
        },
    );
    assert_eq!(
            parse_incoming_line(
                r#"{"jsonrpc":"2.0","id":7,"error":{"code":-32001,"message":"not authenticated","data":{"secret":"discarded"}}}"#,
            )
            .unwrap(),
            AcpIncomingMessage::ErrorResponse {
                id: Some(AcpRequestId::Number(7)),
                error: AcpRpcError {
                    code: -32001,
                    message: "not authenticated".into(),
                },
            },
        );
    assert_eq!(
        parse_incoming_line(r#"{"jsonrpc":"2.0","method":"session/update","params":{}}"#).unwrap(),
        AcpIncomingMessage::Notification {
            method: "session/update".into(),
            params: json!({}),
        },
    );
    assert_eq!(
        parse_incoming_line(
            r#"{"jsonrpc":"2.0","id":"fs-1","method":"fs/read_text_file","params":{}}"#
        )
        .unwrap(),
        AcpIncomingMessage::Request {
            id: AcpRequestId::String("fs-1".into()),
            method: "fs/read_text_file".into(),
            params: json!({}),
        },
    );
}

#[test]
fn parses_safe_permission_requests_and_builds_standard_outcomes() {
    let request = parse_permission_request(&json!({
        "sessionId": "session-1",
        "toolCall": {
            "toolCallId": "tool-1",
            "title": "Edit README.md",
            "kind": "edit",
            "rawInput": { "api_key": "must-not-retain" },
        },
        "options": [
            {
                "optionId": "allow-once",
                "name": "Allow once",
                "kind": "allow_once",
            },
            {
                "optionId": "reject-once",
                "name": "Deny",
                "kind": "reject_once",
            },
        ],
    }))
    .unwrap();
    assert_eq!(request.session_id, "session-1");
    assert_eq!(request.tool_call_id, "tool-1");
    assert_eq!(request.title, "Edit README.md");
    assert!(!request.deferred_to_mcp);
    assert_eq!(request.options[0].kind, AcpPermissionOptionKind::AllowOnce);
    assert!(!format!("{request:?}").contains("must-not-retain"));
    assert_eq!(
        permission_selected_response(AcpRequestId::String("permission-1".into()), "allow-once"),
        json!({
            "jsonrpc": "2.0",
            "id": "permission-1",
            "result": { "outcome": { "outcome": "selected", "optionId": "allow-once" } },
        }),
    );
    assert_eq!(
        permission_cancelled_response(AcpRequestId::Number(2)),
        json!({
            "jsonrpc": "2.0",
            "id": 2,
            "result": { "outcome": { "outcome": "cancelled" } },
        }),
    );
}

#[test]
fn defers_taomni_mcp_permission_requests_without_retaining_raw_input() {
    let request = parse_permission_request(&json!({
        "sessionId": "session-1",
        "toolCall": {
            "toolCallId": "tool-mcp-1",
            "title": "taomni__run_in_terminal",
            "kind": "execute",
            "rawInput": {
                "command": "rm -rf /",
                "session_id": "tab-1",
                "api_key": "must-not-retain",
            },
        },
        "options": [
            {
                "optionId": "allow-once",
                "name": "Allow once",
                "kind": "allow_once",
            },
        ],
    }))
    .unwrap();
    assert!(request.deferred_to_mcp);
    assert!(!format!("{request:?}").contains("must-not-retain"));
    assert!(!format!("{request:?}").contains("rm -rf"));

    let nested = parse_permission_request(&json!({
        "sessionId": "session-1",
        "toolCall": {
            "toolCallId": "tool-mcp-2",
            "title": "use_tool",
            "kind": "execute",
            "rawInput": {
                "server": "taomni_control",
                "tool": "session_open",
            },
        },
        "options": [
            {
                "optionId": "allow-once",
                "name": "Allow once",
                "kind": "allow_once",
            },
        ],
    }))
    .unwrap();
    assert!(nested.deferred_to_mcp);

    assert!(is_taomni_mcp_tool_name("mcp__taomni_sql__run_sql"));
    assert!(is_taomni_mcp_tool_name("run_in_terminal"));
    assert!(!is_taomni_mcp_tool_name("run_terminal_command"));
    assert!(!is_taomni_mcp_tool_name("search_replace"));
}

#[test]
fn rejects_ambiguous_permission_options() {
    let error = parse_permission_request(&json!({
        "sessionId": "session-1",
        "toolCall": { "toolCallId": "tool-1" },
        "options": [{
            "optionId": "maybe",
            "name": "Maybe",
            "kind": "ask_later",
        }],
    }))
    .unwrap_err();
    assert_eq!(
        error,
        AcpProtocolError::InvalidPermissionRequest("option kind is unsupported")
    );
}

#[test]
fn rejects_malformed_or_ambiguous_json_rpc_messages() {
    assert_eq!(
        parse_incoming_line("not-json"),
        Err(AcpProtocolError::InvalidJson)
    );
    assert_eq!(
        parse_incoming_line(r#"{"jsonrpc":"1.0","id":1,"result":{}}"#),
        Err(AcpProtocolError::InvalidJsonRpcVersion),
    );
    assert_eq!(
        parse_incoming_line(r#"{"jsonrpc":"2.0","id":1,"result":{},"error":{}}"#),
        Err(AcpProtocolError::InvalidEnvelope(
            "response must contain exactly one of result or error"
        )),
    );
}

#[test]
fn extracts_safe_initialize_session_and_prompt_metadata() {
    let initialize = parse_initialize_result(&json!({
        "protocolVersion": 1,
        "agentInfo": { "name": "grok", "title": "Grok", "version": "0.2.101" },
        "agentCapabilities": {
            "loadSession": true,
            "promptCapabilities": { "image": false },
            "mcpCapabilities": { "http": true, "sse": false },
        },
        "authMethods": [
            { "id": "cached_token", "name": "Cached token" },
            { "id": "xai.api_key", "name": "API key", "credentials": "discarded" },
        ],
    }))
    .unwrap();
    assert_eq!(
        initialize,
        AcpAgentInfo {
            protocol_version: 1,
            name: Some("grok".into()),
            title: Some("Grok".into()),
            version: Some("0.2.101".into()),
            supports_session_load: true,
            supports_prompt_images: false,
            supports_mcp_http: true,
            supports_mcp_sse: false,
            auth_methods: vec![
                AcpAuthMethod {
                    id: "cached_token".into(),
                    name: "Cached token".into(),
                },
                AcpAuthMethod {
                    id: "xai.api_key".into(),
                    name: "API key".into(),
                },
            ],
        },
    );
    assert_eq!(
        session_id_from_response(&json!({ "sessionId": "s1" })).unwrap(),
        "s1",
    );
    assert_eq!(
        parse_prompt_result(&json!({
            "stopReason": "cancelled",
            "_meta": {
                "usage": {
                    "inputTokens": 12,
                    "outputTokens": 7,
                    "totalTokens": 19,
                    "numTurns": 2,
                    "privateConfig": "discarded",
                },
            },
        }))
        .unwrap(),
        AcpPromptResult {
            stop_reason: AcpStopReason::Cancelled,
            usage: Some(LocalAgentUsage {
                input_tokens: Some(12),
                output_tokens: Some(7),
                total_tokens: Some(19),
                total_cost_usd: None,
                duration_ms: None,
                num_turns: Some(2),
            }),
        },
    );
}

#[test]
fn maps_safe_session_updates_without_forwarding_raw_tool_data_or_thoughts() {
    assert_eq!(
        parse_session_update(&json!({
            "sessionId": "s1",
            "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": { "type": "text", "text": "Hello" },
            },
        })),
        Some(AcpSessionUpdate {
            session_id: "s1".into(),
            is_replay: false,
            event: Some(LocalAgentEvent::AssistantDelta {
                content: "Hello".into(),
            }),
            usage: None,
            generated_media: None,
        }),
    );
    assert_eq!(
        parse_session_update(&json!({
            "sessionId": "s1",
            "update": {
                "sessionUpdate": "tool_call",
                "toolCallId": "tool-1",
                "title": "Read config",
                "rawInput": { "token": "must not escape" },
            },
        })),
        Some(AcpSessionUpdate {
            session_id: "s1".into(),
            is_replay: false,
            event: Some(LocalAgentEvent::ToolStarted {
                id: "tool-1".into(),
                name: "Read config".into(),
                // Secrets stay out of the display payload.
                input: Value::Null,
            }),
            usage: None,
            generated_media: None,
        }),
    );
    assert_eq!(
        parse_session_update(&json!({
            "sessionId": "s1",
            "update": {
                "sessionUpdate": "tool_call",
                "toolCallId": "tool-2",
                "title": "search_tool",
                "kind": "search",
                "rawInput": {
                    "query": "recent folders win11",
                    "token": "must not escape",
                },
                "locations": [{ "path": "/tmp/a.rs" }],
            },
        })),
        Some(AcpSessionUpdate {
            session_id: "s1".into(),
            is_replay: false,
            event: Some(LocalAgentEvent::ToolStarted {
                id: "tool-2".into(),
                name: "search_tool".into(),
                input: json!({
                    "kind": "search",
                    "path": "/tmp/a.rs",
                    "query": "recent folders win11",
                }),
            }),
            usage: None,
            generated_media: None,
        }),
    );
    assert_eq!(
        parse_session_update(&json!({
            "sessionId": "s1",
            "update": {
                "sessionUpdate": "tool_call_update",
                "toolCallId": "tool-1",
                "status": "completed",
                "rawOutput": { "token": "must not escape" },
            },
        })),
        Some(AcpSessionUpdate {
            session_id: "s1".into(),
            is_replay: false,
            event: Some(LocalAgentEvent::ToolCompleted {
                id: "tool-1".into(),
                output: "completed".into(),
            }),
            usage: None,
            generated_media: None,
        }),
    );
    assert_eq!(
        parse_session_update(&json!({
            "sessionId": "s1",
            "update": {
                "sessionUpdate": "tool_call_update",
                "toolCallId": "tool-2",
                "status": "completed",
                "content": [{
                    "type": "content",
                    "content": { "type": "text", "text": "Found 3 matches in src/" },
                }],
                "rawOutput": { "token": "must not escape" },
            },
        })),
        Some(AcpSessionUpdate {
            session_id: "s1".into(),
            is_replay: false,
            event: Some(LocalAgentEvent::ToolCompleted {
                id: "tool-2".into(),
                output: "Found 3 matches in src/".into(),
            }),
            usage: None,
            generated_media: None,
        }),
    );
    assert_eq!(
        parse_session_update(&json!({
            "sessionId": "s1",
            "update": {
                "sessionUpdate": "agent_thought_chunk",
                "content": { "type": "text", "text": "hidden reasoning" },
            },
        })),
        Some(AcpSessionUpdate {
            session_id: "s1".into(),
            is_replay: false,
            event: None,
            usage: None,
            generated_media: None,
        }),
    );
    assert_eq!(
        parse_session_update(&json!({
            "sessionId": "s1",
            "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": { "type": "text", "text": "old answer" },
            },
            "_meta": { "isReplay": true },
        })),
        Some(AcpSessionUpdate {
            session_id: "s1".into(),
            is_replay: true,
            event: None,
            usage: None,
            generated_media: None,
        }),
    );
}

#[test]
fn preserves_usage_as_context_window_metadata() {
    assert_eq!(
        parse_session_update(&json!({
            "sessionId": "s1",
            "update": {
                "sessionUpdate": "usage_update",
                "used": 240,
                "size": 8192,
                "cost": { "amount": 0.12, "currency": "USD" },
            },
        })),
        Some(AcpSessionUpdate {
            session_id: "s1".into(),
            is_replay: false,
            event: None,
            usage: Some(AcpUsageUpdate {
                used_tokens: 240,
                total_tokens: 8192,
                cost_amount: Some(0.12),
                cost_currency: Some("USD".into()),
            }),
            generated_media: None,
        }),
    );
}

#[test]
fn extracts_only_completed_tool_output_paths_as_media_candidates() {
    let update = parse_session_update(&json!({
        "sessionId": "s1",
        "update": {
            "sessionUpdate": "tool_call_update",
            "toolCallId": "image-1",
            "status": "completed",
            "rawOutput": {
                "type": "ImageGen",
                "path": "/tmp/grok/images/1.jpg",
                "private": "not retained",
            },
        },
    }))
    .expect("valid update");
    assert_eq!(
        update.generated_media,
        Some(AcpGeneratedMedia {
            path: "/tmp/grok/images/1.jpg".into(),
        }),
    );

    let failed = parse_session_update(&json!({
        "sessionId": "s1",
        "update": {
            "sessionUpdate": "tool_call_update",
            "status": "failed",
            "rawOutput": { "path": "/tmp/grok/images/failed.jpg" },
        },
    }))
    .expect("valid update");
    assert_eq!(failed.generated_media, None);
}
