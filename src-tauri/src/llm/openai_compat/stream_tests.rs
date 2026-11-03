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
async fn every_ascii_split_retains_first_choice_model_and_terminal_behavior() {
    let input = concat!(
        ": heartbeat\n\n",
        "data: not-json\n\n",
        "data: {\"model\":\"effective\",\"choices\":[{\"delta\":{\"content\":\"one\"}},{\"delta\":{\"content\":\"ignored\"}}]}\n\n",
        "data: {\"choices\":[{\"delta\":{\"content\":\"\"},\"finish_reason\":\"length\"}],\"usage\":{\"completion_tokens\":1}}\n\n",
        "data: [DONE]\n\n",
        "data: {\"choices\":[{\"delta\":{\"content\":\"after terminal\"}}]}\n\n",
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
async fn soft_eof_ignores_partial_event_and_does_not_require_finish_reason() {
    let input = b"data: {\"model\":\"effective\",\"choices\":[{\"delta\":{\"content\":\"prefix\"}}]}\n\ndata: [DONE]";
    assert_eq!(
        decode(vec![Bytes::from_static(input)]).await,
        vec![json!({"type":"token","content":"prefix"}), end("effective")]
    );
    assert_eq!(decode(Vec::new()).await, vec![end("configured")]);
}

#[tokio::test]
async fn legacy_multiline_processes_each_data_line_and_crlf_stays_soft_eof() {
    let input = b"data: {\"choices\":[{\"delta\":{\"content\":\"first\"}}]}\ndata: {\"choices\":[{\"delta\":{\"content\":\"second\"}}]}\n\ndata: [DONE]\n\n";
    assert_eq!(
        decode(vec![Bytes::from_static(input)]).await,
        vec![
            json!({"type":"token","content":"first"}),
            json!({"type":"token","content":"second"}),
            end("configured")
        ]
    );
    let crlf = b"data: {\"choices\":[{\"delta\":{\"content\":\"not dispatched\"}}]}\r\n\r\ndata: [DONE]\r\n\r\n";
    assert_eq!(
        decode(vec![Bytes::from_static(crlf)]).await,
        vec![end("configured")]
    );
}

#[tokio::test]
async fn legacy_utf8_chunk_boundary_remains_lossy_but_whole_chunk_is_intact() {
    let input = "data: {\"choices\":[{\"delta\":{\"content\":\"你\"}}]}\n\ndata: [DONE]\n\n";
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
