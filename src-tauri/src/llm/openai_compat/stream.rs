use futures::{Stream, StreamExt, stream::BoxStream};

use super::super::{ChatStreamEvent, LlmResult};
use super::wire_types::StreamChunk;

/// Legacy chat streaming codec, extracted without semantic changes. In
/// particular soft EOF, per-chunk lossy decoding, and omitted usage are retained.
/// New one-shot invocation semantics live in the independent invocation module.
pub(super) fn decode<S>(bytes: S, model: String) -> BoxStream<'static, LlmResult<ChatStreamEvent>>
where
    S: Stream<Item = Result<bytes::Bytes, reqwest::Error>> + Send + 'static,
{
    // SSE: each event is `data: <json>\n\n`. We accumulate bytes, split on
    // double-newline, and parse `delta.content` from each JSON payload.
    // The terminal event is `data: [DONE]`.
    let stream = async_stream::stream! {
        let mut buffer = String::new();
        let mut bytes = Box::pin(bytes);
        let mut model_id: Option<String> = Some(model.clone());

        while let Some(chunk) = bytes.next().await {
            let chunk = match chunk {
                Ok(b) => b,
                Err(e) => {
                    yield Ok(ChatStreamEvent::Error { message: format!("stream: {e}") });
                    return;
                }
            };
            buffer.push_str(&String::from_utf8_lossy(&chunk));

            // Process complete events ending in \n\n.
            while let Some(idx) = buffer.find("\n\n") {
                let event = buffer[..idx].to_string();
                buffer.drain(..idx + 2);

                for line in event.lines() {
                    let Some(payload) = line.strip_prefix("data:") else { continue; };
                    let payload = payload.trim();
                    if payload == "[DONE]" {
                        yield Ok(ChatStreamEvent::End { model: model_id.take(), usage: None });
                        return;
                    }
                    let parsed: Result<StreamChunk, _> = serde_json::from_str(payload);
                    if let Ok(chunk) = parsed {
                        if let Some(choice) = chunk.choices.into_iter().next() {
                            if let Some(content) = choice.delta.content {
                                if !content.is_empty() {
                                    yield Ok(ChatStreamEvent::Token { content });
                                }
                            }
                        }
                        if let Some(m) = chunk.model {
                            model_id = Some(m);
                        }
                    }
                }
            }
        }

        // Stream closed without [DONE] — emit a soft end.
        yield Ok(ChatStreamEvent::End { model: model_id.take(), usage: None });
    };
    Box::pin(stream)
}
