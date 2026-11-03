use serde_json::json;

use super::super::decoder::Decoder;
use super::super::sse::Event;
use super::super::{InvocationProtocol as Protocol, InvocationStatus as Status};
use super::{decode_chunks, event, json_response};

#[test]
fn chat_utf8_multiline_and_late_cumulative_usage_survive_all_chunk_sizes() {
    let input = concat!(
        ": heartbeat\r\n\r\n",
        "data: {\r\ndata: \"model\":\"effective-model\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"你好🌍\"},\"finish_reason\":null}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":1}}\r\n\r\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2,\"total_tokens\":5,\"prompt_tokens_details\":{\"cached_tokens\":1},\"completion_tokens_details\":{\"reasoning_tokens\":1}}}\n\n",
        "data: [DONE]\n\n",
    );
    for size in 1..=input.len() {
        let (text, receipt) = decode_chunks(Protocol::OpenaiChat, input.as_bytes(), size).unwrap();
        assert_eq!(text, "你好🌍");
        assert_eq!(receipt.model, "effective-model");
        assert_eq!(receipt.status, Status::Complete);
        assert_eq!(receipt.stop_reason, "stop");
        let usage = receipt.usage.unwrap();
        assert_eq!(usage.input_tokens, Some(3));
        assert_eq!(usage.output_tokens, Some(2));
        assert_eq!(usage.total_tokens, Some(5));
        assert_eq!(usage.cached_input_tokens, Some(1));
        assert_eq!(usage.reasoning_tokens, Some(1));
    }
}

#[test]
fn chat_length_and_content_filter_are_not_complete() {
    for (reason, expected) in [
        ("length", Status::Truncated),
        ("content_filter", Status::Refused),
    ] {
        let input = format!(
            "data: {}\n\ndata: [DONE]\n\n",
            json!({"choices":[{"index":0,"delta":{"content":"prefix"},"finish_reason":reason}]})
        );
        let (text, receipt) = decode_chunks(Protocol::OpenaiChat, input.as_bytes(), 1).unwrap();
        assert_eq!(text, "prefix");
        assert_eq!(receipt.status, expected);
        assert_eq!(receipt.stop_reason, reason);
        assert_eq!(receipt.usage, None);
    }
}

#[test]
fn refusal_is_metadata_not_visible_text() {
    let input = format!(
        "data: {}\n\ndata: [DONE]\n\n",
        json!({"choices":[{"delta":{"refusal":"hidden refusal","reasoning_content":"secret reasoning"},"finish_reason":"stop"}]})
    );
    let (text, receipt) = decode_chunks(Protocol::OpenaiChat, input.as_bytes(), 1).unwrap();
    assert!(text.is_empty());
    assert_eq!(receipt.status, Status::Refused);
    assert_eq!(receipt.stop_reason, "refusal");
}

#[test]
fn eof_and_done_without_finish_reason_are_errors() {
    for input in [
        "",
        "data: {\"choices\":[{\"delta\":{\"content\":\"prefix\"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n",
        "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]",
    ] {
        assert!(
            decode_chunks(Protocol::OpenaiChat, input.as_bytes(), 1).is_err(),
            "{input}"
        );
    }
}

#[test]
fn chat_rejects_tools_unknown_stop_reasons_and_multiple_choices() {
    for value in [
        json!({"choices":[{"delta":{"tool_calls":[{"index":0}]}}]}),
        json!({"choices":[{"delta":{"function_call":{"name":"x"}}}]}),
        json!({"choices":[{"delta":{},"finish_reason":"tool_calls"}]}),
        json!({"choices":[{"delta":{},"finish_reason":"unknown"}]}),
        json!({"choices":[{"index":1,"delta":{"content":"wrong choice"}}]}),
        json!({"choices":[{"index":0,"delta":{}},{"index":1,"delta":{}}]}),
    ] {
        let mut decoder = Decoder::new(Protocol::OpenaiChat, "m".into());
        assert!(decoder.event(event("", value), &mut |_| {}).is_err());
    }
}

#[test]
fn provider_errors_never_echo_keys_or_untrusted_bodies() {
    let mut decoder = Decoder::new(Protocol::OpenaiChat, "m".into());
    let error = decoder
        .event(
            event("", json!({"error":{"message":"secret-never-print"}})),
            &mut |_| {},
        )
        .unwrap_err();
    assert!(!error.contains("secret-never-print"));
    let error = decoder
        .event(
            Event {
                kind: "".into(),
                data: "secret-never-print not json".into(),
            },
            &mut |_| {},
        )
        .unwrap_err();
    assert!(!error.contains("secret-never-print"));
}

#[test]
fn json_fallback_requires_stop_and_extracts_only_visible_content() {
    let (text, receipt) = json_response(Protocol::OpenaiChat, json!({
        "model":"json-model", "choices":[{"index":0,"message":{"content":"visible","reasoning_content":"hidden"},"finish_reason":"length"}],
        "usage":{"prompt_tokens":10,"completion_tokens":0,"total_tokens":10}
    })).unwrap();
    assert_eq!(text, "visible");
    assert_eq!(receipt.status, Status::Truncated);
    assert_eq!(receipt.model, "json-model");
    assert_eq!(receipt.usage.unwrap().output_tokens, Some(0));
    assert!(
        json_response(
            Protocol::OpenaiChat,
            json!({"choices":[{"message":{"content":"prefix"}}]})
        )
        .is_err()
    );
    assert!(
        json_response(
            Protocol::OpenaiChat,
            json!({"choices":[{"message":{"tool_calls":[{}]},"finish_reason":"tool_calls"}]})
        )
        .is_err()
    );
}

#[test]
fn text_after_stop_and_conflicting_stop_are_errors() {
    let mut decoder = Decoder::new(Protocol::OpenaiChat, "m".into());
    decoder
        .event(
            event("", json!({"choices":[{"delta":{},"finish_reason":"stop"}]})),
            &mut |_| {},
        )
        .unwrap();
    assert!(
        decoder
            .event(
                event("", json!({"choices":[{"delta":{"content":"late"}}]})),
                &mut |_| {}
            )
            .is_err()
    );
    assert!(
        decoder
            .event(
                event(
                    "",
                    json!({"choices":[{"delta":{},"finish_reason":"length"}]})
                ),
                &mut |_| {}
            )
            .is_err()
    );
}
