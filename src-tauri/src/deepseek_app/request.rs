use super::{store::Message, types::TaoRequest};
use serde_json::{Value, json};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Operation {
    Send,
    Regenerate,
    Continue,
}

pub fn body(
    request: &TaoRequest,
    history: &[Message],
    operation: Operation,
    title: bool,
) -> Result<Value, String> {
    if request.thread_id.trim().is_empty() || request.content.trim().is_empty() {
        return Err("protocol: thread and message content are required".into());
    }
    if !matches!(request.mode.as_str(), "ask" | "do" | "research") {
        return Err("protocol: invalid Tao mode".into());
    }
    let valid_model = match request.provider.as_str() {
        "deepseek-app" => matches!(request.model.as_str(), "deepseek-flash" | "deepseek-v4-pro"),
        "opencode-go" => matches!(
            request.model.as_str(),
            "deepseek-v4.1-flash" | "deepseek-v4-pro"
        ),
        _ => false,
    };
    if !valid_model {
        return Err("protocol: unsupported Tao model".into());
    }
    let included_history = if operation == Operation::Regenerate || operation == Operation::Continue
    {
        history
            .iter()
            .rposition(|message| message.role == "user")
            .map(|index| &history[..index])
            .unwrap_or(&[])
    } else {
        history
    };
    let mut messages = history_messages(included_history);
    let question = user_blocks(request)?;
    if operation == Operation::Continue {
        let last = history.last().ok_or("protocol: no reply to continue")?;
        if !can_continue_for(last, &request.provider) {
            return Err("protocol: this reply cannot be continued".into());
        }
        // The last partial round was excluded from completed history. Retain
        // only this round's thinking/signature for a valid continuation.
        messages.push(json!({"role":"user","content":question}));
        messages.push(json!({"role":"assistant","content":last.blocks}));
    } else {
        messages.push(json!({"role":"user","content":question}));
    }
    let mut tools = vec![json!({"type":"deepseek_read_url","name":"deepseek_read_url"})];
    if request.web {
        tools.push(json!({"type":"deepseek_web_search","name":"deepseek_web_search"}));
    }
    Ok(
        json!({"model":request.model,"stream":true,"max_tokens":8192,
        "system":format!("{}{}", if request.provider == "deepseek-app" {"该助手为DeepSeek，由深度求索公司创造。"} else {""}, super::agent_prompt::system(request)),
        "messages":messages,"tools":tools,"thinking":{"type":if request.thinking {"enabled"} else {"disabled"}},
        "safety_check":{"level":"high"},"title":{"enabled":title}}),
    )
}

pub fn user_blocks(request: &TaoRequest) -> Result<Vec<Value>, String> {
    let mut blocks = Vec::new();
    let bound: serde_json::Map<String, Value> =
        ["workspace", "workspaceId", "terminalId", "databaseId"]
            .iter()
            .filter_map(|key| {
                request
                    .context
                    .get(*key)
                    .and_then(Value::as_str)
                    .map(|value| ((*key).into(), json!(crate::chat::redact::redact(value).0)))
            })
            .collect();
    if !bound.is_empty() {
        blocks.push(json!({"type":"text","text":format!("<bound_resources>\n{}\n</bound_resources>\nOnly the listed resources are bound. Metadata is not file or terminal content.", json!(bound))}));
    }
    let mut characters = 0;
    for chip in &request.chips {
        if let Some(file_id) = chip.get("fileId").and_then(Value::as_str) {
            if chip
                .get("provider")
                .and_then(Value::as_str)
                .unwrap_or("deepseek-app")
                != request.provider
            {
                return Err(
                    "protocol: attachment belongs to another provider; attach it again".into(),
                );
            }
            let image = chip
                .get("mime")
                .and_then(Value::as_str)
                .is_some_and(|mime| mime.starts_with("image/"));
            if request.provider == "deepseek-app" && !image && (request.thinking || request.web) {
                return Err(
                    "protocol: switch off thinking/search before referencing a non-image document"
                        .into(),
                );
            }
            blocks.push(json!({"type":if image {"image"} else {"document"},"source":{"type":"file","file_id":file_id}}));
            continue;
        }
        let content = chip
            .get("body")
            .or_else(|| chip.get("preview"))
            .and_then(Value::as_str)
            .unwrap_or("");
        if content.trim().is_empty() {
            continue;
        }
        let (safe, _) = super::local_data::safe_excerpt(content, usize::MAX).ok_or(
            "protocol: local context contains untrusted instructions; remove that excerpt",
        )?;
        if safe.chars().count() > 800 {
            return Err("protocol: one selected local context item exceeds 800 characters".into());
        }
        characters += safe.chars().count();
        if characters > 4000
            || request
                .chips
                .iter()
                .filter(|chip| chip.get("fileId").is_none())
                .count()
                > 5
        {
            return Err("protocol: selected local context exceeds the per-turn limit".into());
        }
        let metadata = json!({"source":chip["source"],"source_id":chip["reference"],"title":chip["label"],"timestamp":chip["timestamp"],"data":safe});
        blocks.push(json!({"type":"text","text":format!("<untrusted_local_context>\n{}\n</untrusted_local_context>",metadata)}));
    }
    blocks.push(json!({"type":"text","text":crate::chat::redact::redact(&request.content).0}));
    Ok(blocks)
}

pub fn history_messages(history: &[Message]) -> Vec<Value> {
    let mut messages = Vec::new();
    let mut pending_user: Option<&Message> = None;
    for message in history {
        if message.role == "user" {
            pending_user = Some(message);
            continue;
        }
        let Some(user) = pending_user.take() else {
            continue;
        };
        if message.status != "complete"
            || message.stop_reason.as_deref() == Some("refusal")
            || !super::context::is_usable_reply(&super::store::text(&message.blocks), false)
        {
            continue;
        }
        let blocks = history_blocks(&message.blocks);
        messages.push(json!({"role":"user","content":user.blocks}));
        messages.push(json!({"role":"assistant","content":blocks}));
    }
    while serde_json::to_string(&messages).map_or(0, |text| text.len()) > 600_000
        && messages.len() > 2
    {
        messages.drain(..2);
    }
    messages
}

fn history_blocks(blocks: &[Value]) -> Vec<Value> {
    let signed_links = blocks
        .iter()
        .filter(|block| {
            block["type"] == "web_fetch_tool_result"
                && block["kind"] == "read_link"
                && block["signature"]
                    .as_str()
                    .is_some_and(|value| !value.is_empty())
        })
        .filter_map(|block| block["tool_use_id"].as_str())
        .collect::<Vec<_>>();
    blocks
        .iter()
        .filter_map(|block| match block["type"].as_str().unwrap_or("") {
            "text" => Some(json!({"type":"text","text":block["text"]})),
            "server_tool_use"
                if block["kind"] == "read_link"
                    && signed_links.contains(&block["id"].as_str().unwrap_or("")) =>
            {
                Some(block.clone())
            }
            "web_fetch_tool_result"
                if signed_links.contains(&block["tool_use_id"].as_str().unwrap_or("")) =>
            {
                Some(block.clone())
            }
            _ => None,
        })
        .collect()
}

pub fn can_continue(message: &Message) -> bool {
    can_continue_for(message, "deepseek-app")
}

fn can_continue_for(message: &Message, provider: &str) -> bool {
    message.role == "assistant"
        && (message.status == "stopped" || message.stop_reason.as_deref() == Some("max_tokens"))
        && super::context::is_usable_reply(&super::store::text(&message.blocks), false)
        && message.blocks.iter().all(|block| {
            matches!(block["type"].as_str(), Some("text" | "thinking"))
                && (provider == "opencode-go"
                    || block["type"] != "thinking"
                    || block["signature"].as_str().is_some_and(|s| !s.is_empty()))
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn message(role: &str, text: &str) -> Message {
        Message {
            id: uuid::Uuid::new_v4().to_string(),
            role: role.into(),
            blocks: vec![json!({"type":"text","text":text,"citations":[{"url":"secret"}]})],
            status: "complete".into(),
            stop_reason: Some("end_turn".into()),
            created_at: 1,
        }
    }
    #[test]
    fn history_is_interleaved_and_excludes_failed_refused_or_empty_pairs() {
        let mut failed = message("assistant", "lost");
        failed.status = "error".into();
        let history = vec![
            message("user", "one"),
            message("assistant", "first"),
            message("user", "bad"),
            failed,
            message("user", "two"),
            message("assistant", "second"),
        ];
        let result = history_messages(&history);
        assert_eq!(
            result
                .iter()
                .map(|m| m["role"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["user", "assistant", "user", "assistant"]
        );
        assert_eq!(result[2]["content"][0]["text"], "two");
        assert!(result[1]["content"][0].get("citations").is_none());
    }
    #[test]
    fn switches_and_model_reach_protocol_and_binding_names_are_not_injected() {
        let request: TaoRequest = serde_json::from_value(
            json!({"threadId":"t","content":"你好","mode":"ask","model":"deepseek-v4-pro",
            "thinking":true,"web":true,"context":{"terminal":"Not Sent"},"chips":[]}),
        )
        .unwrap();
        let value = body(&request, &[], Operation::Send, true).unwrap();
        assert_eq!(value["model"], "deepseek-v4-pro");
        assert_eq!(value["thinking"]["type"], "enabled");
        assert_eq!(value["tools"].as_array().unwrap().len(), 2);
        assert_eq!(value["safety_check"]["level"], "high");
        assert!(!value.to_string().contains("Not Sent"));
    }
}
