//! Adapt Tao's durable, provider-neutral blocks to Go's Chat Completions wire format.
use super::types::TaoRequest;
use crate::state::AppState;
use serde_json::{Value, json};

pub async fn body(
    canonical: &Value,
    request: &TaoRequest,
    state: &AppState,
) -> Result<Value, String> {
    if !matches!(
        request.reasoning_effort.as_str(),
        "low" | "medium" | "high" | "max"
    ) {
        return Err("protocol: invalid reasoning effort".into());
    }
    let mut messages = vec![json!({"role":"system","content":canonical["system"]})];
    for message in canonical["messages"]
        .as_array()
        .ok_or("protocol: messages missing")?
    {
        let mut content = Vec::new();
        let mut reasoning = String::new();
        for block in message["content"]
            .as_array()
            .ok_or("protocol: message blocks missing")?
        {
            match block["type"].as_str() {
                Some("text") => content.push(json!({"type":"text","text":block["text"]})),
                Some("thinking") => {
                    reasoning.push_str(block["thinking"].as_str().unwrap_or_default())
                }
                Some("image" | "document") => {
                    let id = block["source"]["file_id"]
                        .as_str()
                        .ok_or("protocol: attachment ID missing")?;
                    content
                        .push(super::inline_files::resolve(state, &request.thread_id, id).await?);
                }
                _ => (),
            }
        }
        if content.is_empty() {
            continue;
        }
        let mut wire = json!({"role":message["role"],"content":content});
        if !reasoning.is_empty() {
            wire["reasoning_content"] = reasoning.into();
        }
        messages.push(wire);
    }
    Ok(
        json!({"model":request.model,"messages":messages,"stream":true,"stream_options":{"include_usage":true},
        // Go counts reasoning against the same output allowance as the answer.
        // Max-effort engineering exhausted 8192 before emitting any file actions.
        "max_tokens":if request.thinking {65_536} else {8192},"reasoning_effort":request.reasoning_effort,"thinking":{"type":if request.thinking {"enabled"} else {"disabled"}},
        "tools":super::opencode_tools::descriptors(request)}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn saved_requests_keep_provider_and_max_while_old_requests_default_to_messages() {
        let old: TaoRequest = serde_json::from_value(
            json!({"threadId":"old","content":"hello","mode":"ask","model":"deepseek-flash"}),
        )
        .unwrap();
        assert_eq!(old.provider, "deepseek-app");
        let mut go = old.clone();
        go.provider = "opencode-go".into();
        go.model = "deepseek-v4.1-flash".into();
        go.reasoning_effort = "max".into();
        go.thinking = true;
        let serialized = serde_json::to_value(&go).unwrap();
        assert_eq!(serialized["reasoningEffort"], "max");
        assert_eq!(serialized["provider"], "opencode-go");
        assert!(
            super::super::request::body(&go, &[], super::super::request::Operation::Send, false)
                .is_ok()
        );
        let system = super::super::agent_prompt::system(&go);
        assert!(system.contains("问模式"));
        assert!(system.contains("PostgreSQL"));
        assert!(system.contains("AzureBlob"));
    }
}
