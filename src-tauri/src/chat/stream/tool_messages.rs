use crate::llm::ChatContentPart;
use crate::llm::ChatMessage as LlmMessage;
use crate::llm::ChatTool;
use crate::llm::ChatToolCall;
use futures::StreamExt;
use serde_json::Value;

pub(in crate::chat) fn llm_tools_from_mcp(tools: Vec<rmcp::model::Tool>) -> Vec<ChatTool> {
    tools
        .into_iter()
        .map(|tool| ChatTool {
            name: tool.name.to_string(),
            description: tool.description.map(|description| description.to_string()),
            input_schema: serde_json::Value::Object(tool.input_schema.as_ref().clone()),
        })
        .collect()
}

pub(in crate::chat) fn assistant_tool_message(
    content: &str,
    tool_calls: &[ChatToolCall],
) -> LlmMessage {
    let mut parts = Vec::new();
    if !content.is_empty() {
        parts.push(ChatContentPart::Text {
            text: content.to_string(),
        });
    }
    parts.extend(tool_calls.iter().map(|call| ChatContentPart::ToolUse {
        id: call.id.clone(),
        name: call.name.clone(),
        arguments: call.arguments.clone(),
    }));
    LlmMessage {
        role: "assistant".into(),
        content: crate::llm::ChatContent::Parts(parts),
    }
}
