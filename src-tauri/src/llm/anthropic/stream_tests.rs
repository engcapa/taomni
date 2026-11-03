use bytes::Bytes;
use futures::StreamExt;
use serde_json::{Value, json};

use crate::llm::ChatStreamEvent;

async fn decode(chunks: Vec<Bytes>) -> Vec<Value> {
    let stream = futures::stream::iter(chunks.into_iter().map(Ok::<_, reqwest::Error>));
    super::super::stream::decode(stream, "configured".into())
        .map(|event| serde_json::to_value(event.unwrap()).unwrap())
        .collect()
        .await
}

fn end(model: &str) -> Value {
    json!({"type":"end","model":model})
}

#[tokio::test]
async fn every_ascii_split_retains_text_model_ignored_metadata_and_stop() {
    let input = concat!(
        "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"model\":\"effective\"}}\n\n",
        "event: arbitrary-name\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"one\"}}\n\n",
        "data: not-json\n\n",
        "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"hidden\"}}\n\n",
        "data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":10}}\n\n",
        "data: {\"type\":\"error\",\"error\":{\"message\":\"legacy ignored\"}}\n\n",
        "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
        "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"after terminal\"}}\n\n",
    );
    let expected = vec![json!({"type":"token","content":"one"}), end("effective")];
    for split in 0..=input.len() {
        let actual = decode(vec![
            Bytes::copy_from_slice(&input.as_bytes()[..split]),
            Bytes::copy_from_slice(&input.as_bytes()[split..]),
        ])
        .await;
        assert_eq!(actual, expected, "split {split}");
    }
}

#[tokio::test]
async fn soft_eof_ignores_partial_stop_without_requiring_message_start() {
    let input = b"data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"prefix\"}}\n\ndata: {\"type\":\"message_stop\"}";
    assert_eq!(
        decode(vec![Bytes::from_static(input)]).await,
        vec![
            json!({"type":"token","content":"prefix"}),
            end("configured")
        ]
    );
    assert_eq!(decode(Vec::new()).await, vec![end("configured")]);
}

#[tokio::test]
async fn legacy_multiline_uses_last_data_line_and_crlf_stays_soft_eof() {
    let input = b"data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"ignored\"}}\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"last\"}}\n\ndata: {\"type\":\"message_stop\"}\n\n";
    assert_eq!(
        decode(vec![Bytes::from_static(input)]).await,
        vec![json!({"type":"token","content":"last"}), end("configured")]
    );
    let crlf = b"data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"not dispatched\"}}\r\n\r\ndata: {\"type\":\"message_stop\"}\r\n\r\n";
    assert_eq!(
        decode(vec![Bytes::from_static(crlf)]).await,
        vec![end("configured")]
    );
}

#[tokio::test]
async fn legacy_utf8_chunk_boundary_remains_lossy_but_whole_chunk_is_intact() {
    let input = "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"你\"}}\n\ndata: {\"type\":\"message_stop\"}\n\n";
    assert_eq!(
        decode(vec![Bytes::copy_from_slice(input.as_bytes())]).await,
        vec![json!({"type":"token","content":"你"}), end("configured")]
    );
    let split = input.find('你').unwrap() + 1;
    assert_eq!(
        decode(vec![
            Bytes::copy_from_slice(&input.as_bytes()[..split]),
            Bytes::copy_from_slice(&input.as_bytes()[split..])
        ])
        .await,
        vec![json!({"type":"token","content":"���"}), end("configured")]
    );
}

#[tokio::test]
async fn transport_error_is_an_event_without_a_synthetic_end() {
    let error = reqwest::Client::new().get("not a URL").build().unwrap_err();
    let expected = format!("stream: {error}");
    let stream = futures::stream::iter(vec![Err::<Bytes, _>(error)]);
    let mut stream = super::super::stream::decode(stream, "configured".into());
    match stream.next().await.unwrap().unwrap() {
        ChatStreamEvent::Error { message } => assert_eq!(message, expected),
        event => panic!("expected Error, got {event:?}"),
    }
    assert!(stream.next().await.is_none());
}
