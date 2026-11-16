//! Chat SSE accumulation: usage-only final frames, fragmented tool arguments,
//! reasoning and actual text all survive without changing the legacy Llm trait.
use super::{protocol::Reply, types::TaoEvent};
use serde_json::{Value, json};
use std::collections::BTreeMap;

#[derive(Default)]
pub struct Turn {
    pub calls: BTreeMap<usize, Value>,
    pub finished: bool,
    pub done: bool,
    pub text: String,
    pub thinking: String,
    text_index: Option<usize>,
    thinking_index: Option<usize>,
    baseline_input: u64,
    baseline_output: u64,
}

impl Turn {
    pub fn new(reply: &Reply) -> Self {
        Self {
            baseline_input: reply.input_tokens,
            baseline_output: reply.output_tokens,
            ..Self::default()
        }
    }

    pub fn apply(&mut self, value: Value, reply: &mut Reply) -> Result<Vec<TaoEvent>, String> {
        if value["type"] == "done" {
            self.done = true;
            return Ok(vec![]);
        }
        if value.get("error").is_some() {
            return Err("stream: OpenCode interrupted the response".into());
        }
        let mut events = Vec::new();
        if let Some(usage) = value.get("usage").filter(|v| v.is_object()) {
            let input = self.baseline_input + usage["prompt_tokens"].as_u64().unwrap_or(0);
            let output = self.baseline_output + usage["completion_tokens"].as_u64().unwrap_or(0);
            events.extend(reply.apply(json!({"type":"message_delta","usage":{"input_tokens":input,"output_tokens":output}})));
        }
        let Some(choice) = value["choices"].as_array().and_then(|v| v.first()) else {
            return Ok(events);
        };
        let delta = &choice["delta"];
        for (field, thinking) in [("reasoning_content", true), ("content", false)] {
            if let Some(text) = delta[field].as_str().filter(|t| !t.is_empty()) {
                let slot = if thinking {
                    &mut self.thinking_index
                } else {
                    &mut self.text_index
                };
                let index = if let Some(index) = *slot {
                    index
                } else {
                    let index = reply.blocks.len();
                    *slot = Some(index);
                    let block = if thinking {
                        json!({"type":"thinking","thinking":""})
                    } else {
                        json!({"type":"text","text":""})
                    };
                    events.extend(reply.apply(
                        json!({"type":"content_block_start","index":index,"content_block":block}),
                    ));
                    index
                };
                let fragment = if thinking {
                    self.thinking.push_str(text);
                    json!({"type":"thinking_delta","thinking":text})
                } else {
                    self.text.push_str(text);
                    json!({"type":"text_delta","text":text})
                };
                events.extend(
                    reply.apply(
                        json!({"type":"content_block_delta","index":index,"delta":fragment}),
                    ),
                );
            }
        }
        if let Some(calls) = delta["tool_calls"].as_array() {
            for call in calls {
                let index = call["index"].as_u64().unwrap_or(0) as usize;
                if index > 128 {
                    return Err("protocol: too many tools in one response".into());
                }
                let pending = self.calls.entry(index).or_insert_with(
                    || json!({"id":"","type":"function","function":{"name":"","arguments":""}}),
                );
                for (pointer, value) in [
                    ("/id", &call["id"]),
                    ("/function/name", &call["function"]["name"]),
                    ("/function/arguments", &call["function"]["arguments"]),
                ] {
                    if let Some(fragment) = value.as_str() {
                        let field = pending.pointer_mut(pointer).unwrap();
                        let text = field.as_str().unwrap_or("").to_string() + fragment;
                        if text.len() > 256_000 {
                            return Err("protocol: tool arguments exceed the safe size".into());
                        }
                        *field = text.into();
                    }
                }
            }
        }
        if let Some(reason) = choice["finish_reason"].as_str() {
            self.finished = true;
            for index in [self.thinking_index, self.text_index].into_iter().flatten() {
                events.extend(reply.apply(json!({"type":"content_block_stop","index":index})));
            }
            let reason = match reason {
                "length" => "max_tokens",
                "content_filter" => "refusal",
                "tool_calls" => "tool_use",
                _ => "end_turn",
            };
            events.extend(
                reply.apply(json!({"type":"message_delta","delta":{"stop_reason":reason}})),
            );
        }
        Ok(events)
    }

    pub fn assistant(&self) -> Value {
        let mut value = json!({"role":"assistant","content":if self.text.is_empty() {Value::Null} else {json!(self.text)},"tool_calls":self.calls.values().collect::<Vec<_>>()});
        if !self.thinking.is_empty() {
            value["reasoning_content"] = json!(self.thinking);
        }
        value
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fragmented_tools_reasoning_and_usage_only_tail_remain_ordered() {
        let mut reply = Reply::default();
        reply.input_tokens = 10;
        reply.output_tokens = 20;
        let mut turn = Turn::new(&reply);
        for value in [
            json!({"choices":[{"delta":{"reasoning_content":"plan"},"finish_reason":null}]}),
            json!({"choices":[{"delta":{"content":"explanation"},"finish_reason":null}]}),
            json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"search_local_records","arguments":"{\"query\":"}}]}}]}),
            json!({"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"deploy\"}"}}]},"finish_reason":"tool_calls"}]}),
            json!({"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":34}}),
            json!({"type":"done"}),
        ] {
            turn.apply(value, &mut reply).unwrap();
        }
        assert!(turn.finished && turn.done);
        assert_eq!(reply.blocks[0]["thinking"], "plan");
        assert_eq!(reply.blocks[1]["text"], "explanation");
        assert_eq!(reply.input_tokens, 22);
        assert_eq!(reply.output_tokens, 54);
        assert_eq!(
            turn.calls[&0]["function"]["arguments"],
            "{\"query\":\"deploy\"}"
        );
        assert_eq!(turn.assistant()["reasoning_content"], "plan");
        assert!(!reply.stopped); // A tool boundary is not the end of a Tao turn.
    }
}
