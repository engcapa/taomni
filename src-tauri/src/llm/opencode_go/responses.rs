use crate::llm::{ChatContent, ChatContentPart, ChatRequest, ChatResponse, ChatStreamEvent, ChatTool, ChatToolCall, LlmResult, TokenUsage};
use serde_json::{Value, json};

pub fn request_body(model: &str, req: &ChatRequest, tools: &[ChatTool], stream: bool) -> Value {
    let mut instructions = Vec::new();
    let mut input = Vec::new();
    for message in &req.messages {
        if message.role == "system" { instructions.push(message.content.as_text_lossy()); continue; }
        let role = if message.role == "assistant" { "assistant" } else { "user" };
        let text_type = if role == "assistant" { "output_text" } else { "input_text" };
        let parts = match &message.content {
            ChatContent::Text(text) => vec![ChatContentPart::Text { text: text.clone() }],
            ChatContent::Parts(parts) => parts.clone(),
        };
        let mut content = Vec::new();
        for part in parts {
            match part {
                ChatContentPart::Text { text } => content.push(json!({"type":text_type,"text":text})),
                ChatContentPart::Image { mime_type, data_base64 } => content.push(json!({"type":"input_image","image_url":format!("data:{mime_type};base64,{data_base64}")})),
                ChatContentPart::ToolUse { id, name, arguments } => {
                    if !content.is_empty() { input.push(json!({"role":role,"content":std::mem::take(&mut content)})); }
                    input.push(json!({"type":"function_call","call_id":id,"name":name,"arguments":arguments.to_string()}));
                }
                ChatContentPart::ToolResult { tool_call_id, content: output, .. } => input.push(json!({"type":"function_call_output","call_id":tool_call_id,"output":output})),
            }
        }
        if !content.is_empty() { input.push(json!({"role":role,"content":content})); }
    }
    let mut body = json!({"model":model,"input":input,"stream":stream});
    if !instructions.is_empty() { body["instructions"] = json!(instructions.join("\n\n")); }
    if let Some(tokens) = req.max_tokens { body["max_output_tokens"] = json!(tokens); }
    if let Some(temperature) = req.temperature { body["temperature"] = json!(temperature); }
    if !tools.is_empty() {
        body["tools"] = json!(tools.iter().map(|t| json!({"type":"function","name":t.name,"description":t.description,"parameters":t.input_schema,"strict":false})).collect::<Vec<_>>());
    }
    body
}

pub fn usage(value: &Value) -> Option<TokenUsage> {
    let u = value.get("usage")?;
    Some(TokenUsage { prompt_tokens: u["input_tokens"].as_u64().unwrap_or(0) as u32,
        completion_tokens: u["output_tokens"].as_u64().unwrap_or(0) as u32,
        total_tokens: u["total_tokens"].as_u64().unwrap_or_else(|| u["input_tokens"].as_u64().unwrap_or(0) + u["output_tokens"].as_u64().unwrap_or(0)) as u32 })
}

pub fn parse(value: &Value) -> LlmResult<ChatResponse> {
    let mut content = String::new();
    let mut tool_calls = Vec::new();
    for item in value["output"].as_array().into_iter().flatten() {
        match item["type"].as_str() {
            Some("message") => for part in item["content"].as_array().into_iter().flatten() {
                if part["type"] == "output_text" { content.push_str(part["text"].as_str().unwrap_or_default()); }
            },
            Some("function_call") => tool_calls.push(ChatToolCall {
                id: item["call_id"].as_str().unwrap_or_default().into(),
                name: item["name"].as_str().unwrap_or_default().into(),
                arguments: serde_json::from_str(item["arguments"].as_str().unwrap_or("{}"))?,
            }),
            _ => {}
        }
    }
    Ok(ChatResponse { content, tool_calls, model: value["model"].as_str().map(String::from), usage: usage(value) })
}

pub fn event(value: &Value) -> Option<ChatStreamEvent> {
    match value["type"].as_str()? {
        "response.output_text.delta" => Some(ChatStreamEvent::Token { content: value["delta"].as_str().unwrap_or_default().into() }),
        "response.completed" => Some(ChatStreamEvent::End { model: value["response"]["model"].as_str().map(String::from), usage: usage(&value["response"]) }),
        "response.failed" | "response.incomplete" | "error" => Some(ChatStreamEvent::Error { message: value.to_string() }),
        other => { tracing::debug!(event = other, "ignored Responses event"); None }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::ChatMessage;
    #[test]
    fn complete_history_images_tools_and_usage() {
        let req = ChatRequest { messages: vec![ChatMessage::system("code"), ChatMessage::user_parts(vec![ChatContentPart::Image { mime_type:"image/png".into(),data_base64:"AA==".into() }]), ChatMessage::assistant_tool_calls(vec![ChatToolCall { id:"c".into(),name:"read".into(),arguments:json!({"path":"x"}) }]), ChatMessage::tool_result("c","ok")], max_tokens:Some(123), ..Default::default() };
        let body = request_body("grok", &req, &[ChatTool { name:"read".into(),description:None,input_schema:json!({"type":"object"}) }], false);
        assert_eq!(body["instructions"], "code");
        assert_eq!(body["max_output_tokens"], 123);
        assert_eq!(body["input"][0]["content"][0]["image_url"], "data:image/png;base64,AA==");
        assert_eq!(body["input"][1]["type"], "function_call");
        assert_eq!(body["input"][2]["type"], "function_call_output");
        assert_eq!(body["tools"][0]["strict"], false);
        assert!(body.get("previous_response_id").is_none());
        let response = parse(&json!({"model":"grok","output":[{"type":"message","content":[{"type":"output_text","text":"a"}]},{"type":"function_call","call_id":"c","name":"read","arguments":"{}"}],"usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5}})).unwrap();
        assert_eq!(response.content, "a");
        assert_eq!(response.tool_calls.len(), 1);
        assert_eq!(response.usage.unwrap().total_tokens, 5);
    }
    #[test]
    fn stream_terminal_and_unknown_events() {
        assert!(matches!(event(&json!({"type":"response.output_text.delta","delta":"hi"})), Some(ChatStreamEvent::Token { .. })));
        assert!(matches!(event(&json!({"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":2}}})), Some(ChatStreamEvent::End { .. })));
        for name in ["response.failed","response.incomplete","error"] { assert!(matches!(event(&json!({"type":name})), Some(ChatStreamEvent::Error { .. }))); }
        assert!(event(&json!({"type":"response.function_call_arguments.delta"})).is_none());
        assert!(event(&json!({"type":"future.event"})).is_none());
    }
}
