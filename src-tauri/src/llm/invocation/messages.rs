use std::collections::HashMap;

use serde_json::Value;

use super::chat::check_error;
use super::receipt::{ReceiptBuilder, tool_required};
use super::{InvocationProtocol, InvocationStatus};

#[derive(Clone, Copy)]
enum Block {
    Text,
    Hidden,
}

#[derive(Default)]
pub(super) struct MessagesDecoder {
    started: bool,
    blocks: HashMap<u64, Block>,
}

impl MessagesDecoder {
    pub fn event(
        &mut self,
        kind: &str,
        value: &Value,
        receipt: &mut ReceiptBuilder,
        on_text: &mut impl FnMut(&str),
    ) -> Result<bool, String> {
        if kind == "error" {
            return Err("Messages invocation stream failed".into());
        }
        check_error(value)?;
        if kind == "ping" {
            return Ok(false);
        }
        if kind == "message_start" {
            if self.started {
                return Err("Duplicate Messages message_start".into());
            }
            let message = value
                .get("message")
                .ok_or("Messages start has no message")?;
            check_error(message)?;
            if message
                .get("content")
                .and_then(Value::as_array)
                .is_some_and(|c| !c.is_empty())
            {
                return Err("Messages stream must start with empty content".into());
            }
            self.started = true;
            receipt.model(message);
            update_usage(message, receipt);
            return Ok(false);
        }
        if !self.started {
            return Err("Messages event arrived before message_start".into());
        }
        match kind {
            "content_block_start" => {
                if receipt.stopped() {
                    return Err("Messages content arrived after stop_reason".into());
                }
                let index = block_index(value)?;
                let block = value
                    .get("content_block")
                    .ok_or("Messages start has no content block")?;
                let kind = block_kind(block)?;
                if self.blocks.insert(index, kind).is_some() {
                    return Err("Duplicate Messages content block".into());
                }
                if matches!(kind, Block::Text) {
                    emit_text(block, "text", on_text)?;
                }
            }
            "content_block_delta" => {
                let index = block_index(value)?;
                let block = self
                    .blocks
                    .get(&index)
                    .ok_or("Messages delta has no open content block")?;
                let delta = value.get("delta").ok_or("Messages event has no delta")?;
                match (block, delta.get("type").and_then(Value::as_str)) {
                    (Block::Text, Some("text_delta")) => emit_text(delta, "text", on_text)?,
                    (Block::Hidden, Some("thinking_delta" | "signature_delta")) => {}
                    (_, Some("input_json_delta")) => return Err(tool_required()),
                    _ => return Err("Unsupported Messages content delta".into()),
                }
            }
            "content_block_stop" => {
                if self.blocks.remove(&block_index(value)?).is_none() {
                    return Err("Messages stop has no open content block".into());
                }
            }
            "message_delta" => {
                update_usage(value, receipt);
                if let Some(reason) = value.pointer("/delta/stop_reason").and_then(Value::as_str) {
                    if !self.blocks.is_empty() {
                        return Err(
                            "Messages stop_reason arrived before content blocks closed".into()
                        );
                    }
                    stop(reason, receipt)?;
                }
            }
            "message_stop" => {
                if !self.blocks.is_empty() || !receipt.stopped() {
                    return Err(
                        "Messages message_stop has unfinished content or no stop_reason".into(),
                    );
                }
                return Ok(true);
            }
            _ => {} // Unknown metadata never becomes visible output.
        }
        Ok(false)
    }
}

pub(super) fn json(
    value: &Value,
    receipt: &mut ReceiptBuilder,
    on_text: &mut impl FnMut(&str),
) -> Result<(), String> {
    check_error(value)?;
    receipt.model(value);
    update_usage(value, receipt);
    let reason = value
        .get("stop_reason")
        .and_then(Value::as_str)
        .ok_or("Messages JSON response has no stop_reason")?;
    stop(reason, receipt)?;
    let content = value
        .get("content")
        .and_then(Value::as_array)
        .ok_or("Messages JSON response has no content")?;
    for block in content {
        block_kind(block)?;
    }
    for block in content {
        if matches!(block_kind(block)?, Block::Text) {
            emit_text(block, "text", on_text)?;
        }
    }
    Ok(())
}

fn stop(reason: &str, receipt: &mut ReceiptBuilder) -> Result<(), String> {
    let status = match reason {
        "end_turn" | "stop_sequence" => InvocationStatus::Complete,
        "max_tokens" | "model_context_window_exceeded" => InvocationStatus::Truncated,
        "refusal" => InvocationStatus::Refused,
        "tool_use" | "pause_turn" => return Err(tool_required()),
        _ => return Err("Unrecognized Messages stop_reason".into()),
    };
    receipt.stop(status, reason)
}

fn block_kind(block: &Value) -> Result<Block, String> {
    match block.get("type").and_then(Value::as_str) {
        Some("text") => Ok(Block::Text),
        Some("thinking" | "redacted_thinking") => Ok(Block::Hidden),
        Some("tool_use" | "server_tool_use") => Err(tool_required()),
        _ => Err("Unsupported Messages content block".into()),
    }
}

fn block_index(value: &Value) -> Result<u64, String> {
    value
        .get("index")
        .and_then(Value::as_u64)
        .ok_or_else(|| "Messages content event has no block index".into())
}

fn emit_text(value: &Value, key: &str, on_text: &mut impl FnMut(&str)) -> Result<(), String> {
    let text = value
        .get(key)
        .and_then(Value::as_str)
        .ok_or("Messages text block or delta has no text")?;
    if !text.is_empty() {
        on_text(text);
    }
    Ok(())
}

fn update_usage(value: &Value, receipt: &mut ReceiptBuilder) {
    if let Some(usage) = value.get("usage") {
        receipt.usage(usage, InvocationProtocol::AnthropicMessages);
    }
}
