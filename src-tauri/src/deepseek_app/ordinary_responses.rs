use super::{opencode_stream::Turn, protocol::Reply, types::TaoEvent};
use serde_json::{Value, json};

pub fn body(messages: &[Value], model: &str) -> Result<Value, String> {
    let mut inputs = Vec::new();
    let mut instructions = Vec::new();
    for message in messages {
        if message["role"] == "system" {
            instructions.push(message["content"].as_str().unwrap_or_default());
            continue;
        }
        let mut content = Vec::new();
        for part in message["content"]
            .as_array()
            .ok_or("protocol: invalid chat content")?
        {
            match part["type"].as_str() {
                Some("text") => {
                    let kind = if message["role"] == "assistant" {
                        "output_text"
                    } else {
                        "input_text"
                    };
                    content.push(json!({"type":kind,"text":part["text"]}));
                }
                Some("image_url") => {
                    content.push(json!({"type":"input_image","image_url":part["image_url"]["url"]}))
                }
                _ => return Err("protocol: unsupported Responses content".into()),
            }
        }
        inputs.push(json!({"role":message["role"],"content":content}));
    }
    Ok(
        json!({"model":model,"input":inputs,"instructions":instructions.join("\n\n"),"stream":true,"store":false}),
    )
}

pub fn apply(value: Value, turn: &mut Turn, reply: &mut Reply) -> Result<Vec<TaoEvent>, String> {
    let frame = match value["type"].as_str() {
        Some("response.output_text.delta") => {
            json!({"choices":[{"delta":{"content":value["delta"]}}]})
        }
        Some("response.reasoning_summary_text.delta") => {
            json!({"choices":[{"delta":{"reasoning_content":value["delta"]}}]})
        }
        Some("response.completed" | "response.incomplete") => {
            let response = &value["response"];
            let reason = match response["incomplete_details"]["reason"].as_str() {
                Some("max_output_tokens") => "length",
                Some("content_filter") => "content_filter",
                None if value["type"] == "response.completed" => "stop",
                _ => return Err("stream: provider returned an incomplete response".into()),
            };
            reply.search_calls += response["output"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|item| item["type"] == "web_search_call")
                .count() as u64;
            turn.done = true;
            json!({"choices":[{"delta":{},"finish_reason":reason}], "usage":{"prompt_tokens":response["usage"]["input_tokens"],"completion_tokens":response["usage"]["output_tokens"]}})
        }
        Some("response.failed" | "error") => {
            return Err("stream: provider interrupted the response".into());
        }
        _ => return Ok(Vec::new()),
    };
    turn.apply(frame, reply)
}
