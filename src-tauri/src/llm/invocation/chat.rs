use serde_json::Value;

use super::receipt::{ReceiptBuilder, has_tools, tool_required};
use super::{InvocationProtocol, InvocationStatus};

#[derive(Default)]
pub(super) struct ChatDecoder;

impl ChatDecoder {
    pub fn event(
        &mut self,
        data: &str,
        receipt: &mut ReceiptBuilder,
        on_text: &mut impl FnMut(&str),
    ) -> Result<bool, String> {
        if data.trim() == "[DONE]" {
            if !receipt.stopped() {
                return Err("Chat stream ended without finish_reason".into());
            }
            return Ok(true);
        }
        let value: Value =
            serde_json::from_str(data).map_err(|_| "Invalid JSON in Chat invocation stream")?;
        check_error(&value)?;
        receipt.model(&value);
        if let Some(usage) = value.get("usage") {
            receipt.usage(usage, InvocationProtocol::OpenaiChat);
        }
        let choices = value
            .get("choices")
            .and_then(Value::as_array)
            .ok_or("Chat stream event has no choices")?;
        for choice in choices {
            check_choice(choice, choices.len())?;
            let delta = choice.get("delta").unwrap_or(&Value::Null);
            if has_tools(delta) {
                return Err(tool_required());
            }
            if delta.get("refusal").is_some_and(|v| !v.is_null()) {
                receipt.refused = true;
            }
            if let Some(content) = delta.get("content") {
                if receipt.stopped() && content.as_str().is_some_and(|s| !s.is_empty()) {
                    return Err("Chat text arrived after finish_reason".into());
                }
                visible_content(content, on_text)?;
            }
            if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
                stop(reason, receipt)?;
            }
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
    if let Some(usage) = value.get("usage") {
        receipt.usage(usage, InvocationProtocol::OpenaiChat);
    }
    let choices = value
        .get("choices")
        .and_then(Value::as_array)
        .ok_or("Chat JSON response has no choices")?;
    if choices.len() != 1 {
        return Err("One-shot invocation requires exactly one Chat choice".into());
    }
    let choice = &choices[0];
    check_choice(choice, choices.len())?;
    let message = choice
        .get("message")
        .ok_or("Chat response has no message")?;
    if has_tools(message) {
        return Err(tool_required());
    }
    receipt.refused = message.get("refusal").is_some_and(|v| !v.is_null());
    let reason = choice
        .get("finish_reason")
        .and_then(Value::as_str)
        .ok_or("Chat JSON response has no finish_reason")?;
    stop(reason, receipt)?;
    if let Some(content) = message.get("content") {
        visible_content(content, on_text)?;
    }
    Ok(())
}

fn stop(reason: &str, receipt: &mut ReceiptBuilder) -> Result<(), String> {
    let status = match reason {
        "stop" => InvocationStatus::Complete,
        "length" => InvocationStatus::Truncated,
        "content_filter" | "refusal" => InvocationStatus::Refused,
        "tool_calls" | "function_call" => return Err(tool_required()),
        _ => return Err("Unrecognized Chat finish_reason".into()),
    };
    receipt.stop(status, reason)
}

fn check_choice(choice: &Value, count: usize) -> Result<(), String> {
    if count > 1 || choice.get("index").and_then(Value::as_u64).unwrap_or(0) != 0 {
        return Err("One-shot invocation received multiple Chat choices".into());
    }
    Ok(())
}

fn visible_content(content: &Value, on_text: &mut impl FnMut(&str)) -> Result<(), String> {
    match content {
        Value::Null => Ok(()),
        Value::String(text) => {
            if !text.is_empty() {
                on_text(text);
            }
            Ok(())
        }
        _ => Err("Unsupported Chat text content shape".into()),
    }
}

pub(super) fn check_error(value: &Value) -> Result<(), String> {
    if value.get("error").is_some_and(|v| !v.is_null()) {
        Err("Provider returned an invocation error".into())
    } else {
        Ok(())
    }
}
