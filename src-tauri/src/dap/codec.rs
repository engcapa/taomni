use serde_json::Value;

/// Encode a DAP message (JSON body) with the `Content-Length` header framing.
pub fn encode_message(message: &Value) -> Vec<u8> {
    let body = serde_json::to_vec(message).unwrap_or_default();
    let mut framed = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
    framed.extend_from_slice(&body);
    framed
}

/// Incremental decoder for a DAP byte stream. Feed bytes with [`Self::push`], then
/// drain complete messages with [`Self::next_message`] — handles partial reads and
/// multiple messages coalesced in one chunk (same framing as LSP).
#[derive(Default)]
pub struct DapDecoder {
    pub(super) buffer: Vec<u8>,
}

impl DapDecoder {
    pub fn push(&mut self, chunk: &[u8]) {
        self.buffer.extend_from_slice(chunk);
    }

    /// Pop the next fully-received message, or `None` if more bytes are needed.
    /// Skips a frame whose body is not valid JSON (returns the next good one).
    pub fn next_message(&mut self) -> Option<Value> {
        loop {
            let header_end = find_subsequence(&self.buffer, b"\r\n\r\n")?;
            let header = &self.buffer[..header_end];
            let content_length = parse_content_length(header);
            let Some(len) = content_length else {
                // Malformed header (no Content-Length): drop it and resync.
                self.buffer.drain(..header_end + 4);
                continue;
            };
            let body_start = header_end + 4;
            if self.buffer.len() < body_start + len {
                return None; // Body not fully arrived yet.
            }
            let body: Vec<u8> = self.buffer[body_start..body_start + len].to_vec();
            self.buffer.drain(..body_start + len);
            match serde_json::from_slice::<Value>(&body) {
                Ok(value) => return Some(value),
                Err(_) => continue, // Skip the bad frame, try the next.
            }
        }
    }
}
pub(super) fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// Parse the `Content-Length` value from a raw header block (case-insensitive key).
pub(super) fn parse_content_length(header: &[u8]) -> Option<usize> {
    let text = std::str::from_utf8(header).ok()?;
    for line in text.split("\r\n") {
        if let Some((key, value)) = line.split_once(':') {
            if key.trim().eq_ignore_ascii_case("Content-Length") {
                return value.trim().parse::<usize>().ok();
            }
        }
    }
    None
}

/// Classification of an inbound DAP message from the adapter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InboundMessage {
    /// A response to a request we sent (carries `request_seq`).
    Response { request_seq: i64 },
    /// An adapter-initiated event (`stopped`, `output`, `terminated`, …).
    Event { event: String },
    /// A reverse request from the adapter (`runInTerminal`, `startDebugging`).
    ReverseRequest { command: String, seq: i64 },
    /// Anything that does not match a known DAP `type`.
    Unknown,
}

/// Classify an inbound message by its DAP `type` field (pure — unit-tested).
pub fn classify_message(message: &Value) -> InboundMessage {
    match message.get("type").and_then(Value::as_str) {
        Some("response") => InboundMessage::Response {
            request_seq: message
                .get("request_seq")
                .and_then(Value::as_i64)
                .unwrap_or(-1),
        },
        Some("event") => InboundMessage::Event {
            event: message
                .get("event")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        },
        Some("request") => InboundMessage::ReverseRequest {
            command: message
                .get("command")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            seq: message.get("seq").and_then(Value::as_i64).unwrap_or(-1),
        },
        _ => InboundMessage::Unknown,
    }
}

/// Extract the most useful error text from a failed DAP response. The spec's
/// `ErrorResponse` carries a structured `body.error` message with a `format`
/// template and `{key}` placeholders resolved from `variables`; the flat
/// top-level `message` is often just a terse summary (java-debug puts the real
/// reason — "Failed to launch debuggee VM. Reason: …" — in `body.error`).
pub fn extract_error_message(message: &Value) -> String {
    if let Some(error) = message.pointer("/body/error") {
        if let Some(format) = error.get("format").and_then(Value::as_str) {
            let mut text = format.to_string();
            if let Some(variables) = error.get("variables").and_then(Value::as_object) {
                for (key, value) in variables {
                    if let Some(value) = value.as_str() {
                        text = text.replace(&format!("{{{key}}}"), value);
                    }
                }
            }
            if !text.trim().is_empty() {
                return text;
            }
        }
    }
    message
        .get("message")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("debug adapter request failed")
        .to_string()
}
