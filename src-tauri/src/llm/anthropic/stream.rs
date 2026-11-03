use futures::{Stream, StreamExt, stream::BoxStream};
use serde_json::Value;

use super::super::{ChatStreamEvent, LlmResult};

/// Legacy Messages streaming codec, extracted without semantic changes. Keep
/// its soft EOF, ignored usage/error metadata, and per-chunk lossy UTF-8 separate
/// from the stricter independent invocation contract.
pub(super) fn decode<S>(bytes: S, model: String) -> BoxStream<'static, LlmResult<ChatStreamEvent>>
where
    S: Stream<Item = Result<bytes::Bytes, reqwest::Error>> + Send + 'static,
{
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

            // Anthropic SSE format: "event: <name>\ndata: <json>\n\n".
            while let Some(idx) = buffer.find("\n\n") {
                let event = buffer[..idx].to_string();
                buffer.drain(..idx + 2);

                let mut data_payload: Option<String> = None;
                for line in event.lines() {
                    if let Some(payload) = line.strip_prefix("data:") {
                        data_payload = Some(payload.trim().to_string());
                    }
                }
                let Some(payload) = data_payload else { continue; };
                let Ok(json) = serde_json::from_str::<Value>(&payload) else { continue; };

                match json.get("type").and_then(|t| t.as_str()) {
                    Some("content_block_delta") => {
                        if let Some(delta) = json.get("delta") {
                            if delta.get("type").and_then(|t| t.as_str()) == Some("text_delta") {
                                if let Some(text) = delta.get("text").and_then(|t| t.as_str()) {
                                    if !text.is_empty() {
                                        yield Ok(ChatStreamEvent::Token { content: text.to_string() });
                                    }
                                }
                            }
                        }
                    }
                    Some("message_start") => {
                        if let Some(m) = json.pointer("/message/model").and_then(|m| m.as_str()) {
                            model_id = Some(m.to_string());
                        }
                    }
                    Some("message_delta") => {
                        // usage updates land here in `usage`, but only at end of stream
                        // we capture usage on message_stop below if present.
                    }
                    Some("message_stop") => {
                        yield Ok(ChatStreamEvent::End { model: model_id.take(), usage: None });
                        return;
                    }
                    _ => {}
                }
            }
        }

        yield Ok(ChatStreamEvent::End { model: model_id.take(), usage: None });
    };
    Box::pin(stream)
}
