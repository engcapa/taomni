use super::adapter::ConfiguredDebugAdapter;
use super::adapter::DapTransport;
use super::adapter::DebugAdapter;
use super::adapter::DebugAdapterRegistry;
use super::codec::DapDecoder;
use super::codec::InboundMessage;
use super::codec::classify_message;
use super::codec::encode_message;
use super::codec::extract_error_message;
use super::codec::parse_content_length;
use super::reader::reverse_response;
use super::session::normalize_request_arguments;
use serde_json::Value;
use serde_json::json;

#[test]
fn encodes_with_content_length_framing() {
    let framed = encode_message(&json!({ "seq": 1, "type": "request", "command": "next" }));
    let text = String::from_utf8(framed).unwrap();
    let (header, body) = text.split_once("\r\n\r\n").expect("header/body split");
    assert!(header.starts_with("Content-Length: "));
    let declared: usize = header
        .trim_start_matches("Content-Length: ")
        .parse()
        .unwrap();
    assert_eq!(declared, body.len());
    assert!(body.contains("\"command\":\"next\""));
}

#[test]
fn normalizes_null_request_arguments_to_an_object() {
    assert_eq!(normalize_request_arguments(Value::Null), json!({}));
    assert_eq!(
        normalize_request_arguments(json!({ "threadId": 7 })),
        json!({ "threadId": 7 })
    );
}

#[test]
fn decodes_a_single_message() {
    let mut decoder = DapDecoder::default();
    decoder.push(&encode_message(
        &json!({ "type": "event", "event": "stopped" }),
    ));
    let message = decoder.next_message().expect("one message");
    assert_eq!(message["event"], "stopped");
    assert!(decoder.next_message().is_none());
}

#[test]
fn reassembles_a_partial_frame_across_pushes() {
    let framed = encode_message(&json!({ "type": "event", "event": "output" }));
    let (head, tail) = framed.split_at(framed.len() / 2);
    let mut decoder = DapDecoder::default();
    decoder.push(head);
    assert!(
        decoder.next_message().is_none(),
        "incomplete frame yields nothing"
    );
    decoder.push(tail);
    assert_eq!(
        decoder.next_message().expect("completed")["event"],
        "output"
    );
}

#[test]
fn splits_multiple_messages_in_one_chunk() {
    let mut buf = encode_message(&json!({ "type": "event", "event": "a" }));
    buf.extend(encode_message(&json!({ "type": "event", "event": "b" })));
    let mut decoder = DapDecoder::default();
    decoder.push(&buf);
    assert_eq!(decoder.next_message().unwrap()["event"], "a");
    assert_eq!(decoder.next_message().unwrap()["event"], "b");
    assert!(decoder.next_message().is_none());
}

#[test]
fn skips_a_frame_with_invalid_json_body() {
    let mut buf = b"Content-Length: 3\r\n\r\n{[}".to_vec();
    buf.extend(encode_message(
        &json!({ "type": "event", "event": "recovered" }),
    ));
    let mut decoder = DapDecoder::default();
    decoder.push(&buf);
    // The bad frame is dropped; the next valid one is returned.
    assert_eq!(decoder.next_message().unwrap()["event"], "recovered");
}

#[test]
fn classifies_dap_message_types() {
    assert_eq!(
        classify_message(&json!({ "type": "response", "request_seq": 7, "success": true })),
        InboundMessage::Response { request_seq: 7 },
    );
    assert_eq!(
        classify_message(&json!({ "type": "event", "event": "stopped" })),
        InboundMessage::Event {
            event: "stopped".into()
        },
    );
    assert_eq!(
        classify_message(&json!({ "type": "request", "command": "runInTerminal", "seq": 4 })),
        InboundMessage::ReverseRequest {
            command: "runInTerminal".into(),
            seq: 4
        },
    );
    assert_eq!(
        classify_message(&json!({ "type": "bogus" })),
        InboundMessage::Unknown
    );
}

#[test]
fn empty_registry_returns_none() {
    let registry = DebugAdapterRegistry::new();
    assert!(registry.get("java").is_none());
}

#[tokio::test]
async fn configured_adapter_resolves_stdio_and_managed_tcp_plans() {
    let adapter = ConfiguredDebugAdapter::new("python");
    let stdio = adapter
        .resolve(&json!({
            "adapterCommand": "debugpy-adapter",
            "adapterCwd": "/workspace",
            "arguments": { "program": "/workspace/main.py" },
            "mode": { "kind": "stdio", "args": ["--log-stderr"] },
        }))
        .await
        .unwrap();
    assert_eq!(
        stdio.transport,
        DapTransport::Stdio {
            command: "debugpy-adapter".into(),
            args: vec!["--log-stderr".into()],
            cwd: Some("/workspace".into()),
        }
    );
    assert_eq!(stdio.arguments["program"], "/workspace/main.py");

    let delve = ConfiguredDebugAdapter::new("delve")
        .resolve(&json!({
            "adapterCommand": "dlv",
            "mode": { "kind": "managedTcp", "args": ["dap", "--listen=127.0.0.1:${port}"] },
            "arguments": { "mode": "debug", "program": "." },
        }))
        .await
        .unwrap();
    assert!(matches!(delve.transport, DapTransport::ManagedTcp { .. }));
}

#[test]
fn extracts_structured_error_details_with_variable_substitution() {
    // ErrorResponse body.error wins over the terse top-level message.
    let response = json!({
        "type": "response", "success": false, "message": "launch failed",
        "body": { "error": {
            "format": "Failed to launch debuggee VM. Reason: {reason}",
            "variables": { "reason": "mainClass not found" },
        }},
    });
    assert_eq!(
        extract_error_message(&response),
        "Failed to launch debuggee VM. Reason: mainClass not found",
    );
    // Falls back to the flat message, then to a generic string.
    assert_eq!(
        extract_error_message(&json!({ "success": false, "message": "boom" })),
        "boom",
    );
    assert_eq!(
        extract_error_message(&json!({ "success": false })),
        "debug adapter request failed",
    );
}

#[test]
fn answers_reverse_requests_with_a_correlated_failure() {
    // Every reverse request must get a response or the adapter blocks. The
    // kernel implements none of them, so it declines by name.
    let response = reverse_response(&json!({
        "type": "request", "seq": 12, "command": "runInTerminal",
        "arguments": { "args": ["java"] },
    }));
    assert_eq!(response["type"], "response");
    assert_eq!(response["request_seq"], 12);
    assert_eq!(response["command"], "runInTerminal");
    assert_eq!(response["success"], json!(false));
    assert!(
        response["message"]
            .as_str()
            .unwrap()
            .contains("runInTerminal")
    );
    // A malformed reverse request still yields a well-formed response.
    let fallback = reverse_response(&json!({ "type": "request" }));
    assert_eq!(fallback["request_seq"], -1);
    assert_eq!(fallback["success"], json!(false));
}

#[test]
fn content_length_header_is_case_insensitive() {
    assert_eq!(parse_content_length(b"content-length: 42"), Some(42));
    assert_eq!(parse_content_length(b"Content-Length: 7\r\nX: y"), Some(7));
    assert_eq!(parse_content_length(b"X-Other: 1"), None);
}
