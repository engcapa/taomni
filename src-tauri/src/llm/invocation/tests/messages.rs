use serde_json::{Value, json};

use super::super::decoder::Decoder;
use super::super::{InvocationProtocol as Protocol, InvocationStatus as Status};
use super::{decode_chunks, event, json_response, wire};

fn start() -> Value {
    json!({"type":"message_start","message":{"model":"effective","content":[],"usage":{"input_tokens":12,"output_tokens":1,"cache_read_input_tokens":3,"cache_creation_input_tokens":2}}})
}

fn stream(reason: &str) -> String {
    [
        wire("message_start", start()),
        wire("ping", json!({"type":"ping"})),
        wire(
            "content_block_start",
            json!({"index":0,"content_block":{"type":"thinking","thinking":""}}),
        ),
        wire(
            "content_block_delta",
            json!({"index":0,"delta":{"type":"thinking_delta","thinking":"hidden reasoning"}}),
        ),
        wire(
            "content_block_delta",
            json!({"index":0,"delta":{"type":"signature_delta","signature":"hidden signature"}}),
        ),
        wire("content_block_stop", json!({"index":0})),
        wire(
            "content_block_start",
            json!({"index":1,"content_block":{"type":"text","text":"你"}}),
        ),
        wire(
            "content_block_delta",
            json!({"index":1,"delta":{"type":"text_delta","text":"好🌍"}}),
        ),
        wire("content_block_stop", json!({"index":1})),
        wire(
            "message_delta",
            json!({"delta":{"stop_reason":null},"usage":{"output_tokens":3}}),
        ),
        wire(
            "message_delta",
            json!({"delta":{"stop_reason":reason},"usage":{"output_tokens":4}}),
        ),
        wire("message_stop", json!({"type":"message_stop"})),
    ]
    .concat()
}

#[test]
fn message_lifecycle_utf8_visible_text_and_usage_are_cumulative() {
    let input = stream("end_turn");
    for size in [1, 2, 3, 7, 19, input.len()] {
        let (text, receipt) =
            decode_chunks(Protocol::AnthropicMessages, input.as_bytes(), size).unwrap();
        assert_eq!(text, "你好🌍");
        assert_eq!(receipt.model, "effective");
        assert_eq!(receipt.status, Status::Complete);
        let usage = receipt.usage.unwrap();
        assert_eq!(usage.input_tokens, Some(12));
        assert_eq!(usage.output_tokens, Some(4));
        assert_eq!(usage.cached_input_tokens, Some(3));
        assert_eq!(usage.cache_write_tokens, Some(2));
        assert_eq!(usage.total_tokens, None);
    }
}

#[test]
fn message_max_tokens_context_limit_and_refusal_are_distinct() {
    for (reason, status) in [
        ("max_tokens", Status::Truncated),
        ("model_context_window_exceeded", Status::Truncated),
        ("refusal", Status::Refused),
        ("stop_sequence", Status::Complete),
    ] {
        let (text, receipt) =
            decode_chunks(Protocol::AnthropicMessages, stream(reason).as_bytes(), 1).unwrap();
        assert_eq!(text, "你好🌍");
        assert_eq!(receipt.status, status);
        assert_eq!(receipt.stop_reason, reason);
    }
}

#[test]
fn message_requires_start_closed_blocks_reason_and_message_stop() {
    for input in [
        "".to_owned(),
        wire("message_stop", json!({})),
        wire("message_start", start()),
        [
            wire("message_start", start()),
            wire("message_stop", json!({})),
        ]
        .concat(),
        [
            wire("message_start", start()),
            wire("message_delta", json!({"delta":{"stop_reason":"end_turn"}})),
        ]
        .concat(),
        [
            wire("message_start", start()),
            wire(
                "content_block_delta",
                json!({"index":0,"delta":{"type":"text_delta","text":"orphan"}}),
            ),
        ]
        .concat(),
        [
            wire("message_start", start()),
            wire(
                "content_block_start",
                json!({"index":0,"content_block":{"type":"text","text":""}}),
            ),
            wire("message_delta", json!({"delta":{"stop_reason":"end_turn"}})),
        ]
        .concat(),
    ] {
        assert!(decode_chunks(Protocol::AnthropicMessages, input.as_bytes(), 1).is_err());
    }
}

#[test]
fn messages_stream_errors_are_redacted_and_do_not_complete() {
    let input = [
        wire("message_start", start()),
        wire(
            "error",
            json!({"type":"error","error":{"message":"secret-never-print"}}),
        ),
    ]
    .concat();
    let error = decode_chunks(Protocol::AnthropicMessages, input.as_bytes(), 1).unwrap_err();
    assert!(!error.contains("secret-never-print"));
}

#[test]
fn message_tools_pause_and_unrecognized_stops_are_rejected() {
    for reason in ["tool_use", "pause_turn", "unknown"] {
        assert!(decode_chunks(Protocol::AnthropicMessages, stream(reason).as_bytes(), 1).is_err());
    }
    for kind in ["tool_use", "server_tool_use"] {
        let input = [
            wire("message_start", start()),
            wire(
                "content_block_start",
                json!({"index":0,"content_block":{"type":kind}}),
            ),
        ]
        .concat();
        assert!(
            decode_chunks(Protocol::AnthropicMessages, input.as_bytes(), 1)
                .unwrap_err()
                .contains("tools")
        );
    }
}

#[test]
fn messages_json_fallback_omits_thinking_and_preserves_truncation_and_missing_usage() {
    let (text, receipt) = json_response(Protocol::AnthropicMessages, json!({
        "model":"json-model","stop_reason":"max_tokens",
        "content":[{"type":"thinking","thinking":"hidden"},{"type":"redacted_thinking","data":"hidden"},{"type":"text","text":"visible"}]
    })).unwrap();
    assert_eq!(text, "visible");
    assert_eq!(receipt.status, Status::Truncated);
    assert_eq!(receipt.usage, None);
    assert!(json_response(Protocol::AnthropicMessages, json!({"content":[]})).is_err());
    assert!(
        json_response(
            Protocol::AnthropicMessages,
            json!({"stop_reason":"tool_use","content":[{"type":"tool_use"}]})
        )
        .is_err()
    );
}

#[test]
fn wrong_delta_block_pair_and_duplicate_start_are_rejected() {
    let mut decoder = Decoder::new(Protocol::AnthropicMessages, "m".into());
    decoder
        .event(event("message_start", start()), &mut |_| {})
        .unwrap();
    assert!(
        decoder
            .event(event("message_start", start()), &mut |_| {})
            .is_err()
    );
    decoder
        .event(
            event(
                "content_block_start",
                json!({"index":0,"content_block":{"type":"thinking"}}),
            ),
            &mut |_| {},
        )
        .unwrap();
    assert!(
        decoder
            .event(
                event(
                    "content_block_delta",
                    json!({"index":0,"delta":{"type":"text_delta","text":"hidden leak"}})
                ),
                &mut |_| {}
            )
            .is_err()
    );
}
