//! Demonstration of rig-core's `#[rig_tool]` procedural macro path.
//!
//! Plan §7.0 calls for `#[derive(Tool)]` to drive automatic JSON-schema
//! generation for at least one of the agent tools. rig-core 0.37 exposes
//! that capability via `rig_derive::rig_tool` (re-exported as
//! `rig_core::tool_macro`) — an attribute macro on free functions, which is
//! semantically the struct-derive shape the plan asks for.
//!
//! We wrap `redact_text` here both because it's stateless (no AppState
//! capture needed) and because exposing a redactor as an LLM tool gives the
//! agent a useful primitive: when it's about to send terminal output to a
//! third-party service it can self-redact first. The macro generates a
//! `RedactTextTool` struct that implements `rig_core::tool::Tool`, plus the
//! JSON schema for arguments — exactly what plan §7.1 promises.

use rig_core::tool_macro;
use rig_core::tool::Tool as RigTool;

#[tool_macro(
    description = "Redact common sensitive patterns (passwords, tokens, Bearer headers, etc.) from a piece of text. Returns the cleaned text plus a count of how many patterns were replaced.",
    params(
        text = "The original text to redact"
    )
)]
pub async fn redact_text(text: String) -> Result<serde_json::Value, rig_core::tool::ToolError> {
    let (cleaned, hits) = crate::chat::redact::redact(&text);
    Ok(serde_json::json!({
        "redacted_text": cleaned,
        "patterns_matched": hits,
    }))
}

/// Returns the rig-style tool name + a stable identifier the rest of the
/// codebase can use to discover the tool. `RedactText` is the PascalCase
/// struct emitted by the macro (function name `redact_text` → `RedactText`).
pub fn descriptor() -> (String, &'static str) {
    let tool = RedactText::default();
    (RigTool::name(&tool), "redact-text")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn macro_generated_tool_runs() {
        let tool = RedactText::default();
        let args = RedactTextParameters { text: "password=hunter2 hello".into() };
        let out = RigTool::call(&tool, args).await.unwrap();
        let txt = out.get("redacted_text").and_then(|v| v.as_str()).unwrap();
        assert!(txt.contains("[REDACTED]"));
        assert!(txt.contains("hello"));
    }
}
