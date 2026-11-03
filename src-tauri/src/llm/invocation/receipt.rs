use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::InvocationProtocol;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InvocationStatus {
    Complete,
    Truncated,
    Refused,
}

/// Provider-reported cumulative counts, never sums of streaming snapshots.
/// Missing counts remain None; reasoning can already be included in output.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct InvocationUsage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
    pub cached_input_tokens: Option<u64>,
    pub cache_write_tokens: Option<u64>,
    pub reasoning_tokens: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InvocationReceipt {
    pub model: String,
    pub stop_reason: String,
    pub status: InvocationStatus,
    pub usage: Option<InvocationUsage>,
}

pub(super) struct ReceiptBuilder {
    model: String,
    stop: Option<(InvocationStatus, String)>,
    usage: Option<InvocationUsage>,
    pub refused: bool,
}

impl ReceiptBuilder {
    pub fn new(model: String) -> Self {
        Self {
            model,
            stop: None,
            usage: None,
            refused: false,
        }
    }

    pub fn model(&mut self, value: &Value) {
        if let Some(model) = value.get("model").and_then(Value::as_str)
            && !model.is_empty()
        {
            self.model = model.to_owned();
        }
    }

    pub fn stopped(&self) -> bool {
        self.stop.is_some()
    }

    pub fn stop(&mut self, status: InvocationStatus, reason: &str) -> Result<(), String> {
        if let Some((previous_status, previous_reason)) = &self.stop
            && (*previous_status != status || previous_reason != reason)
        {
            return Err("Conflicting invocation stop reasons".into());
        }
        self.stop = Some((status, reason.to_owned()));
        Ok(())
    }

    pub fn usage(&mut self, value: &Value, protocol: InvocationProtocol) {
        let mut next = InvocationUsage::default();
        match protocol {
            InvocationProtocol::OpenaiChat => {
                next.input_tokens = count(value, "/prompt_tokens");
                next.output_tokens = count(value, "/completion_tokens");
                next.cached_input_tokens = count(value, "/prompt_tokens_details/cached_tokens");
                next.reasoning_tokens = count(value, "/completion_tokens_details/reasoning_tokens");
            }
            InvocationProtocol::OpenaiResponses => {
                next.input_tokens = count(value, "/input_tokens");
                next.output_tokens = count(value, "/output_tokens");
                next.cached_input_tokens = count(value, "/input_tokens_details/cached_tokens");
                next.reasoning_tokens = count(value, "/output_tokens_details/reasoning_tokens");
            }
            InvocationProtocol::AnthropicMessages => {
                next.input_tokens = count(value, "/input_tokens");
                next.output_tokens = count(value, "/output_tokens");
                next.cached_input_tokens = count(value, "/cache_read_input_tokens");
                next.cache_write_tokens = count(value, "/cache_creation_input_tokens");
            }
        }
        next.total_tokens = count(value, "/total_tokens");
        if next == InvocationUsage::default() {
            return;
        }
        let usage = self.usage.get_or_insert_with(InvocationUsage::default);
        macro_rules! merge {
            ($($field:ident),+ $(,)?) => { $(
                if next.$field.is_some() {
                    usage.$field = next.$field;
                }
            )+ };
        }
        merge!(
            input_tokens,
            output_tokens,
            total_tokens,
            cached_input_tokens,
            cache_write_tokens,
            reasoning_tokens,
        );
    }

    pub fn finish(self) -> Result<InvocationReceipt, String> {
        let (mut status, mut stop_reason) = self
            .stop
            .ok_or("Invocation stream ended without an explicit terminal reason")?;
        if self.refused {
            status = InvocationStatus::Refused;
            stop_reason = "refusal".into();
        }
        Ok(InvocationReceipt {
            model: self.model,
            stop_reason,
            status,
            usage: self.usage,
        })
    }
}

fn count(value: &Value, path: &str) -> Option<u64> {
    value.pointer(path).and_then(Value::as_u64)
}

pub(super) fn tool_required() -> String {
    "Invocation requires tools; one-shot invocations cannot execute a tool loop".into()
}

pub(super) fn has_tools(value: &Value) -> bool {
    value.get("function_call").is_some_and(|v| !v.is_null())
        || value
            .get("tool_calls")
            .is_some_and(|v| !v.is_null() && v.as_array().is_none_or(|v| !v.is_empty()))
}
