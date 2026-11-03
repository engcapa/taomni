use std::collections::HashMap;

use serde_json::Value;

use super::chat::check_error;
use super::receipt::{ReceiptBuilder, tool_required};
use super::{InvocationProtocol, InvocationStatus};

#[derive(Default)]
pub(super) struct ResponsesDecoder {
    text: HashMap<(u64, u64), String>,
}

impl ResponsesDecoder {
    pub fn event(
        &mut self,
        kind: &str,
        value: &Value,
        receipt: &mut ReceiptBuilder,
        on_text: &mut impl FnMut(&str),
    ) -> Result<bool, String> {
        check_error(value)?;
        match kind {
            "error" | "response.failed" => return Err("Responses invocation failed".into()),
            "response.created" | "response.in_progress" => {
                if let Some(response) = value.get("response") {
                    receipt.model(response);
                }
            }
            "response.output_text.delta" => {
                let delta = value
                    .get("delta")
                    .and_then(Value::as_str)
                    .ok_or("Responses text delta is missing text")?;
                self.text.entry(indices(value)).or_default().push_str(delta);
                if !delta.is_empty() {
                    on_text(delta);
                }
            }
            "response.output_text.done" => {
                let text = value
                    .get("text")
                    .and_then(Value::as_str)
                    .ok_or("Responses final text is missing")?;
                self.snapshot(indices(value), text, on_text)?;
            }
            "response.refusal.delta" | "response.refusal.done" => receipt.refused = true,
            "response.content_part.added" | "response.content_part.done" => {
                let part = value
                    .get("part")
                    .ok_or("Responses event has no content part")?;
                self.part(indices(value), part, receipt, on_text)?;
            }
            "response.output_item.added" | "response.output_item.done" => {
                let item = value
                    .get("item")
                    .ok_or("Responses event has no output item")?;
                self.item(index(value, "output_index"), item, receipt, on_text)?;
            }
            "response.completed" | "response.incomplete" => {
                let response = value
                    .get("response")
                    .ok_or("Responses terminal has no response")?;
                let expected = if kind == "response.completed" {
                    "completed"
                } else {
                    "incomplete"
                };
                if response.get("status").and_then(Value::as_str) != Some(expected) {
                    return Err("Conflicting Responses terminal status".into());
                }
                self.final_response(response, receipt, on_text)?;
                return Ok(true);
            }
            _ if kind.contains("function_call") || kind.contains("tool_call") => {
                return Err(tool_required());
            }
            _ => {} // Forward-compatible metadata/reasoning events are not visible text.
        }
        Ok(false)
    }

    pub fn final_response(
        &mut self,
        value: &Value,
        receipt: &mut ReceiptBuilder,
        on_text: &mut impl FnMut(&str),
    ) -> Result<(), String> {
        check_error(value)?;
        receipt.model(value);
        if let Some(usage) = value.get("usage") {
            receipt.usage(usage, InvocationProtocol::OpenaiResponses);
        }
        let (status, reason) = match value.get("status").and_then(Value::as_str) {
            Some("completed") => (InvocationStatus::Complete, "completed"),
            Some("incomplete") => match value
                .pointer("/incomplete_details/reason")
                .and_then(Value::as_str)
            {
                Some("max_output_tokens") => (InvocationStatus::Truncated, "max_output_tokens"),
                Some("content_filter" | "refusal") => (InvocationStatus::Refused, "content_filter"),
                _ => return Err("Responses invocation incomplete for an unsupported reason".into()),
            },
            Some("failed" | "cancelled") => {
                return Err("Responses invocation failed or was cancelled".into());
            }
            _ => return Err("Responses JSON has no terminal status".into()),
        };
        let output = value
            .get("output")
            .and_then(Value::as_array)
            .ok_or("Responses terminal has no output items")?;
        // Detect tool requirements before emitting any final-only text.
        for item in output {
            check_item(item)?;
        }
        for (output_index, item) in output.iter().enumerate() {
            self.item(output_index as u64, item, receipt, on_text)?;
        }
        receipt.stop(status, reason)
    }

    fn item(
        &mut self,
        output_index: u64,
        item: &Value,
        receipt: &mut ReceiptBuilder,
        on_text: &mut impl FnMut(&str),
    ) -> Result<(), String> {
        check_item(item)?;
        if item.get("type").and_then(Value::as_str) != Some("message") {
            return Ok(());
        }
        if let Some(parts) = item.get("content").and_then(Value::as_array) {
            for (content_index, part) in parts.iter().enumerate() {
                self.part((output_index, content_index as u64), part, receipt, on_text)?;
            }
        }
        Ok(())
    }

    fn part(
        &mut self,
        key: (u64, u64),
        part: &Value,
        receipt: &mut ReceiptBuilder,
        on_text: &mut impl FnMut(&str),
    ) -> Result<(), String> {
        match part.get("type").and_then(Value::as_str) {
            Some("output_text") => {
                let text = part
                    .get("text")
                    .and_then(Value::as_str)
                    .ok_or("Responses output_text part has no text")?;
                self.snapshot(key, text, on_text)
            }
            Some("refusal") => {
                receipt.refused = true;
                Ok(())
            }
            _ => Err("Unsupported Responses content part".into()),
        }
    }

    fn snapshot(
        &mut self,
        key: (u64, u64),
        text: &str,
        on_text: &mut impl FnMut(&str),
    ) -> Result<(), String> {
        let emitted = self.text.entry(key).or_default();
        let suffix = text
            .strip_prefix(emitted.as_str())
            .ok_or("Conflicting Responses text snapshots")?;
        if !suffix.is_empty() {
            on_text(suffix);
        }
        *emitted = text.to_owned();
        Ok(())
    }
}

fn check_item(item: &Value) -> Result<(), String> {
    match item.get("type").and_then(Value::as_str) {
        Some("message" | "reasoning") => Ok(()),
        Some(_) => Err(tool_required()),
        None => Err("Responses output item has no type".into()),
    }
}

fn index(value: &Value, key: &str) -> u64 {
    value.get(key).and_then(Value::as_u64).unwrap_or(0)
}

fn indices(value: &Value) -> (u64, u64) {
    (index(value, "output_index"), index(value, "content_index"))
}
