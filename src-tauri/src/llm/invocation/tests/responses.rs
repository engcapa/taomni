use serde_json::{Value, json};

use super::super::decoder::Decoder;
use super::super::{InvocationProtocol as Protocol, InvocationStatus as Status};
use super::{decode_chunks, event, json_response, wire};

fn completed(text: &str) -> Value {
    json!({"status":"completed","model":"effective","output":[{"type":"message","content":[{"type":"output_text","text":text}]}],"usage":{"input_tokens":12,"output_tokens":4,"total_tokens":16,"input_tokens_details":{"cached_tokens":3},"output_tokens_details":{"reasoning_tokens":2}}})
}

#[test]
fn responses_deltas_done_items_and_terminal_do_not_duplicate_text() {
    let input = [
        wire("response.created", json!({"type":"response.created","response":{"model":"effective"}})),
        wire("response.output_item.added", json!({"type":"response.output_item.added","output_index":0,"item":{"type":"message","content":[]}})),
        wire("response.content_part.added", json!({"type":"response.content_part.added","output_index":0,"content_index":0,"part":{"type":"output_text","text":""}})),
        wire("response.output_text.delta", json!({"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"你好"})),
        wire("response.output_text.delta", json!({"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"🌍"})),
        wire("response.output_text.done", json!({"type":"response.output_text.done","output_index":0,"content_index":0,"text":"你好🌍"})),
        wire("response.content_part.done", json!({"type":"response.content_part.done","output_index":0,"content_index":0,"part":{"type":"output_text","text":"你好🌍"}})),
        wire("response.output_item.done", json!({"type":"response.output_item.done","output_index":0,"item":{"type":"message","content":[{"type":"output_text","text":"你好🌍"}]}})),
        wire("response.completed", json!({"type":"response.completed","response":completed("你好🌍")})),
    ].concat();
    for size in [1, 2, 3, 7, 19, input.len()] {
        let (text, receipt) =
            decode_chunks(Protocol::OpenaiResponses, input.as_bytes(), size).unwrap();
        assert_eq!(text, "你好🌍");
        assert_eq!(receipt.model, "effective");
        assert_eq!(receipt.status, Status::Complete);
        let usage = receipt.usage.unwrap();
        assert_eq!(usage.input_tokens, Some(12));
        assert_eq!(usage.output_tokens, Some(4));
        assert_eq!(usage.cached_input_tokens, Some(3));
        assert_eq!(usage.reasoning_tokens, Some(2));
    }
}

#[test]
fn multiple_output_and_content_indices_keep_separate_snapshots() {
    let output = vec![
        json!({"type":"reasoning","summary":[{"text":"hidden"}]}),
        json!({"type":"message","content":[{"type":"output_text","text":"A"},{"type":"output_text","text":"B"}]}),
        json!({"type":"message","content":[{"type":"output_text","text":"C"}]}),
    ];
    let mut decoder = Decoder::new(Protocol::OpenaiResponses, "m".into());
    let mut text = String::new();
    for (output_index, content_index, delta) in [(1, 0, "A"), (1, 1, "B"), (2, 0, "C")] {
        decoder.event(event("response.output_text.delta", json!({"type":"response.output_text.delta","output_index":output_index,"content_index":content_index,"delta":delta})), &mut |s| text.push_str(s)).unwrap();
    }
    decoder
        .event(
            event(
                "response.completed",
                json!({"response":{"status":"completed","output":output}}),
            ),
            &mut |s| text.push_str(s),
        )
        .unwrap();
    assert_eq!(text, "ABC");
    assert_eq!(decoder.finish().unwrap().status, Status::Complete);
}

#[test]
fn response_incomplete_is_truncated_or_refused_not_completed() {
    for (reason, expected) in [
        ("max_output_tokens", Status::Truncated),
        ("content_filter", Status::Refused),
    ] {
        let input = wire(
            "response.incomplete",
            json!({"response":{"status":"incomplete","incomplete_details":{"reason":reason},"output":[]}}),
        );
        let (_, receipt) = decode_chunks(Protocol::OpenaiResponses, input.as_bytes(), 1).unwrap();
        assert_eq!(receipt.status, expected);
    }
    assert!(
        json_response(
            Protocol::OpenaiResponses,
            json!({"status":"incomplete","incomplete_details":{"reason":"unknown"},"output":[]})
        )
        .is_err()
    );
}

#[test]
fn response_refusal_never_appears_as_visible_text() {
    let input = [
        wire("response.refusal.delta", json!({"delta":"hidden refusal"})),
        wire("response.completed", json!({"response":{"status":"completed","output":[{"type":"message","content":[{"type":"refusal","refusal":"hidden refusal"}]}]}})),
    ].concat();
    let (text, receipt) = decode_chunks(Protocol::OpenaiResponses, input.as_bytes(), 1).unwrap();
    assert!(text.is_empty());
    assert_eq!(receipt.status, Status::Refused);
}

#[test]
fn response_errors_eof_and_conflicting_types_are_failures() {
    for (kind, value) in [
        (
            "response.failed",
            json!({"response":{"status":"failed","error":{"message":"secret-never-print"}}}),
        ),
        ("error", json!({"message":"secret-never-print"})),
        (
            "response.completed",
            json!({"type":"response.incomplete","response":completed("x")}),
        ),
        (
            "response.completed",
            json!({"response":{"status":"in_progress","output":[]}}),
        ),
        (
            "response.completed",
            json!({"response":{"status":"completed","error":{"message":"secret-never-print"},"output":[]}}),
        ),
    ] {
        let input = wire(kind, value);
        let error = decode_chunks(Protocol::OpenaiResponses, input.as_bytes(), 1).unwrap_err();
        assert!(!error.contains("secret-never-print"));
    }
    let input = wire("response.output_text.delta", json!({"delta":"prefix"}));
    assert!(decode_chunks(Protocol::OpenaiResponses, input.as_bytes(), 1).is_err());
}

#[test]
fn responses_reject_tools_and_conflicting_text() {
    for value in [
        json!({"status":"completed","output":[{"type":"function_call","name":"tool"}]}),
        json!({"status":"completed","output":[{"type":"web_search_call"}]}),
    ] {
        assert!(
            json_response(Protocol::OpenaiResponses, value)
                .unwrap_err()
                .contains("tools")
        );
    }
    let mut decoder = Decoder::new(Protocol::OpenaiResponses, "m".into());
    decoder
        .event(
            event("response.output_text.delta", json!({"delta":"prefix"})),
            &mut |_| {},
        )
        .unwrap();
    assert!(
        decoder
            .event(
                event(
                    "response.completed",
                    json!({"response":completed("different")})
                ),
                &mut |_| {}
            )
            .is_err()
    );
}

#[test]
fn json_fallback_and_terminal_snapshot_only_text_are_supported() {
    let (text, receipt) = json_response(Protocol::OpenaiResponses, completed("only text")).unwrap();
    assert_eq!(text, "only text");
    assert_eq!(receipt.status, Status::Complete);
    let input = wire(
        "response.completed",
        json!({"response":completed("only text")}),
    );
    assert_eq!(
        decode_chunks(Protocol::OpenaiResponses, input.as_bytes(), 1)
            .unwrap()
            .0,
        "only text"
    );
}
