use crate::llm::{ChatContent, ChatContentPart, ChatRequest, ChatResponse, ChatTool, ChatToolCall, LlmResult, TokenUsage};
use serde_json::{Value, json};
use std::collections::HashMap;

pub fn request_body(req: &ChatRequest, tools: &[ChatTool]) -> Value {
    let mut system = Vec::new();
    let mut contents = Vec::new();
    let mut calls = HashMap::new();
    for message in &req.messages {
        if message.role == "system" { system.push(json!({"text":message.content.as_text_lossy()})); continue; }
        let parts = match &message.content {
            ChatContent::Text(text) => vec![ChatContentPart::Text { text: text.clone() }],
            ChatContent::Parts(parts) => parts.clone(),
        };
        let parts = parts.into_iter().map(|p| match p {
            ChatContentPart::Text { text } => json!({"text":text}),
            ChatContentPart::Image { mime_type, data_base64 } => json!({"inlineData":{"mimeType":mime_type,"data":data_base64}}),
            ChatContentPart::ToolUse { id, name, arguments } => {
                calls.insert(id.clone(), name.clone());
                json!({"functionCall":{"id":id,"name":name,"args":arguments}})
            }
            ChatContentPart::ToolResult { tool_call_id, content, is_error } => json!({"functionResponse":{"id":tool_call_id,"name":calls.get(&tool_call_id).unwrap_or(&tool_call_id),"response":if is_error {json!({"error":content})} else {json!({"output":content})}}}),
        }).collect::<Vec<_>>();
        contents.push(json!({"role":if message.role == "assistant" {"model"} else {"user"},"parts":parts}));
    }
    let mut body = json!({"contents":contents,"generationConfig":{}});
    if !system.is_empty() { body["systemInstruction"] = json!({"parts":system}); }
    if let Some(tokens) = req.max_tokens { body["generationConfig"]["maxOutputTokens"] = json!(tokens); }
    if let Some(temp) = req.temperature { body["generationConfig"]["temperature"] = json!(temp); }
    if !tools.is_empty() {
        body["tools"] = json!([{"functionDeclarations":tools.iter().map(|t| json!({"name":t.name,"description":t.description,"parameters":t.input_schema})).collect::<Vec<_>>()}]);
    }
    body
}

pub fn parse(value: &Value) -> LlmResult<ChatResponse> {
    let mut content = String::new();
    let mut tool_calls = Vec::new();
    for (index, part) in value["candidates"][0]["content"]["parts"].as_array().into_iter().flatten().enumerate() {
        if let Some(text) = part["text"].as_str() { content.push_str(text); }
        if let Some(call) = part.get("functionCall") {
            tool_calls.push(ChatToolCall { id: call["id"].as_str().map(String::from).unwrap_or_else(|| format!("google-call-{index}")),
                name:call["name"].as_str().unwrap_or_default().into(),arguments:call["args"].clone() });
        }
    }
    let usage = value.get("usageMetadata").map(|u| TokenUsage {
        prompt_tokens:u["promptTokenCount"].as_u64().unwrap_or(0) as u32,
        completion_tokens:u["candidatesTokenCount"].as_u64().unwrap_or(0) as u32,
        total_tokens:u["totalTokenCount"].as_u64().unwrap_or(0) as u32,
    });
    Ok(ChatResponse { content, tool_calls, model:value["modelVersion"].as_str().map(String::from), usage })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::ChatMessage;
    #[test]
    fn roles_images_call_result_and_usage() {
        let req = ChatRequest { messages:vec![ChatMessage::system("code"), ChatMessage::user_parts(vec![ChatContentPart::Image { mime_type:"image/png".into(),data_base64:"AA==".into() }]), ChatMessage::assistant_tool_calls(vec![ChatToolCall { id:"c".into(),name:"read".into(),arguments:json!({}) }]),ChatMessage::tool_result("c","ok")], max_tokens:Some(12), ..Default::default() };
        let body = request_body(&req, &[ChatTool { name:"read".into(),description:None,input_schema:json!({"type":"object"}) }]);
        assert_eq!(body["systemInstruction"]["parts"][0]["text"], "code");
        assert_eq!(body["contents"][0]["parts"][0]["inlineData"]["mimeType"], "image/png");
        assert_eq!(body["contents"][1]["role"], "model");
        assert_eq!(body["contents"][2]["parts"][0]["functionResponse"]["name"], "read");
        assert_eq!(body["generationConfig"]["maxOutputTokens"], 12);
        assert_eq!(body["tools"][0]["functionDeclarations"][0]["name"], "read");
        let response = parse(&json!({"candidates":[{"content":{"parts":[{"text":"hi"},{"functionCall":{"name":"read","args":{}}}]}}],"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":3,"totalTokenCount":5}})).unwrap();
        assert_eq!(response.content, "hi");
        assert_eq!(response.tool_calls[0].id, "google-call-1");
        assert_eq!(response.usage.unwrap().total_tokens, 5);
    }
}
