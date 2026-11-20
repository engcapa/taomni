//! Messages SSE decoding and lossless native block accumulation.
use super::types::TaoEvent;
use serde_json::{Value, json};

#[derive(Default)]
pub struct SseDecoder {
    buffer: Vec<u8>,
}

impl SseDecoder {
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<Value>, String> {
        self.buffer.extend_from_slice(bytes);
        if self.buffer.len() > 8 * 1024 * 1024 {
            return Err("protocol: SSE frame exceeds safe size".into());
        }
        let mut frames = Vec::new();
        while let Some((index, delimiter)) = boundary(&self.buffer) {
            let data: Vec<u8> = self.buffer.drain(..index + delimiter).take(index).collect();
            let text =
                std::str::from_utf8(&data).map_err(|_| "protocol: invalid UTF-8 SSE frame")?;
            let payload = text
                .lines()
                .filter_map(|line| line.strip_prefix("data:").map(|line| line.trim_start()))
                .collect::<Vec<_>>()
                .join("\n");
            if payload.is_empty() {
                continue;
            }
            if payload == "[DONE]" {
                frames.push(json!({"type":"done"}));
                continue;
            }
            // Keepalive/malformed non-JSON frames are ignored just like chat-demo.
            if let Ok(value) = serde_json::from_str(&payload) {
                frames.push(value);
            }
        }
        Ok(frames)
    }
}

fn boundary(bytes: &[u8]) -> Option<(usize, usize)> {
    bytes
        .windows(2)
        .position(|w| w == b"\n\n")
        .map(|i| (i, 2))
        .into_iter()
        .chain(
            bytes
                .windows(4)
                .position(|w| w == b"\r\n\r\n")
                .map(|i| (i, 4)),
        )
        .min_by_key(|(i, _)| *i)
}

#[derive(Default)]
pub struct Reply {
    pub blocks: Vec<Value>,
    pub stop_reason: Option<String>,
    pub title: Option<String>,
    pub stopped: bool,
    pub errored: bool,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub search_calls: u64,
    pub fetch_calls: u64,
}

impl Reply {
    pub fn apply(&mut self, frame: Value) -> Vec<TaoEvent> {
        let index = frame["index"].as_u64().unwrap_or(0) as usize;
        match frame["type"].as_str().unwrap_or("") {
            "message_start" => {
                self.usage(&frame["message"]["usage"]);
                vec![
                    TaoEvent::new("message_start")
                        .with("messageId", frame["message"]["id"].clone())
                        .with("model", frame["message"]["model"].clone())
                        .with("usage", self.usage_value()),
                ]
            }
            "content_block_start" => {
                if index > 4096 {
                    self.errored = true;
                    return vec![error("protocol", "Too many response blocks")];
                }
                while self.blocks.len() <= index {
                    self.blocks.push(Value::Null);
                }
                let block = frame["content_block"].clone();
                if block["type"] == "server_tool_use" {
                    if matches!(
                        block["name"].as_str(),
                        Some("deepseek_web_search" | "web_search")
                    ) {
                        self.search_calls += 1;
                    }
                    if block["name"] == "deepseek_read_url" {
                        self.fetch_calls += 1;
                    }
                }
                self.blocks[index] = block.clone();
                vec![
                    TaoEvent::new("block_start")
                        .with("index", index)
                        .with("block", ui_block(&block, index))
                        .with("rawBlock", block),
                ]
            }
            "content_block_delta" => {
                let delta = &frame["delta"];
                let Some(block) = self.blocks.get_mut(index) else {
                    return Vec::new();
                };
                let key = match delta["type"].as_str().unwrap_or("") {
                    "text_delta" => "text",
                    "thinking_delta" => "thinking",
                    "signature_delta" => "signature",
                    "input_json_delta" => "partial_json",
                    "citations_delta" => "citations",
                    _ => "",
                };
                if key == "citations" {
                    let citations = delta.get("citations").cloned().unwrap_or_else(|| json!([]));
                    let target = block
                        .as_object_mut()
                        .map(|o| o.entry("citations").or_insert_with(|| json!([])));
                    if let Some(Value::Array(items)) = target {
                        if let Value::Array(next) = citations {
                            items.extend(next);
                        }
                    }
                } else if !key.is_empty() {
                    let source_key = if key == "partial_json" {
                        "partial_json"
                    } else {
                        key
                    };
                    let content = delta[source_key].as_str().unwrap_or("");
                    let old = block[key].as_str().unwrap_or("").to_string();
                    block[key] = Value::String(old + content);
                }
                let content = delta["text"]
                    .as_str()
                    .or_else(|| delta["thinking"].as_str())
                    .unwrap_or("");
                vec![
                    TaoEvent::new("block_delta")
                        .with("index", index)
                        .with("delta", json!({"text":content,"sources": sources(block)}))
                        .with("rawDelta", delta.clone()),
                ]
            }
            "content_block_stop" => {
                if let Some(block) = self.blocks.get_mut(index) {
                    if let Some(raw) = block["partial_json"].as_str() {
                        if let Ok(input) = serde_json::from_str::<Value>(raw) {
                            block["input"] = input;
                        }
                    }
                }
                vec![TaoEvent::new("block_stop").with("index", index)]
            }
            "message_delta" => {
                self.usage(&frame["usage"]);
                if let Some(reason) = frame["delta"]["stop_reason"].as_str() {
                    self.stop_reason = Some(reason.into());
                }
                self.title = frame["delta"]["title"]
                    .as_str()
                    .map(str::to_owned)
                    .or(self.title.take());
                if self.stop_reason.as_deref() == Some("refusal") {
                    for block in &mut self.blocks {
                        if block["type"] == "text" || block["type"] == "thinking" {
                            *block = Value::Null;
                        }
                    }
                }
                vec![
                    TaoEvent::new("message_delta")
                        .with("stopReason", json!(self.stop_reason))
                        .with("title", json!(self.title))
                        .with("usage", self.usage_value())
                        .with("stopDetails", frame["delta"]["stop_details"].clone()),
                ]
            }
            "message_stop" => {
                self.stopped = true;
                vec![TaoEvent::new("message_stop")]
            }
            "error" => {
                self.errored = true;
                vec![error(
                    "stream",
                    frame["error"]["message"]
                        .as_str()
                        .unwrap_or("Provider stream error"),
                )]
            }
            _ => Vec::new(),
        }
    }

    fn usage(&mut self, usage: &Value) {
        if let Some(value) = usage["input_tokens"].as_u64() {
            self.input_tokens = value;
        }
        if let Some(value) = usage["output_tokens"].as_u64() {
            self.output_tokens = value;
        }
    }

    pub fn usage_value(&self) -> Value {
        json!({"inputTokens":self.input_tokens,"outputTokens":self.output_tokens,
        "searchCalls":self.search_calls,"fetchCalls":self.fetch_calls})
    }
}

pub fn error(category: &str, message: &str) -> TaoEvent {
    TaoEvent::new("error")
        .with("category", category)
        .with("message", message)
}

pub fn ui_block(block: &Value, index: usize) -> Value {
    let kind = match block["type"].as_str().unwrap_or("") {
        "thinking" => "thinking",
        "server_tool_use" => "search",
        "web_search_tool_result" | "web_fetch_tool_result" | "local_context_result" => "sources",
        _ => "text",
    };
    json!({"id":format!("block-{index}"),"type":kind,"text": block["text"].as_str().or_else(||block["thinking"].as_str()).unwrap_or(""),
        "status":"complete","query":block["input"]["query"],"sources":sources(block),"raw":block})
}

pub fn sources(block: &Value) -> Vec<Value> {
    if block["type"] == "local_context_result" {
        return block["content"].as_array().cloned().unwrap_or_default();
    }
    let values = block.get("citations").or_else(|| block.get("content"));
    values
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let url = item.get("url").and_then(Value::as_str)?;
                    Some(
                        json!({"id":url,"url":url,"title":item["title"].as_str().unwrap_or(url),
            "summary":item["snippet"].as_str().or_else(||item["cited_text"].as_str())}),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn split_utf8_and_crlf_frames_are_decoded_without_losing_blocks() {
        let raw = "event: message_start\r\ndata: {\"type\":\"message_start\",\"message\":{\"model\":\"pro\"}}\r\n\r\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"你好\"}}\n\n";
        let mut decoder = SseDecoder::default();
        let mut frames = Vec::new();
        for byte in raw.as_bytes() {
            frames.extend(decoder.push(&[*byte]).unwrap());
        }
        assert_eq!(frames.len(), 2);
        let mut reply = Reply::default();
        for frame in frames {
            reply.apply(frame);
        }
        assert_eq!(reply.blocks[0]["text"], "你好");
    }
    #[test]
    fn signature_citations_usage_and_refusal_remain_protocol_native() {
        let mut reply = Reply::default();
        reply.apply(json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"reason"}}));
        reply.apply(json!({"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"signed"}}));
        assert_eq!(reply.blocks[0]["signature"], "signed");
        let events = reply.apply(json!({"type":"message_delta","delta":{"stop_reason":"refusal"},"usage":{"output_tokens":40}}));
        assert_eq!(events[0].payload["stopReason"], "refusal");
        assert!(reply.blocks[0].is_null());
        assert_eq!(reply.output_tokens, 40);
    }
}
