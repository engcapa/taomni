pub mod sessions;
pub mod sftp_runbook;
pub mod terminal;
pub mod history;
pub mod rig_native;
pub mod web_search;
pub mod web_fetch;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// A tool call parsed from LLM output.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub tool: String,
    pub args: serde_json::Value,
}

/// The result of executing a tool.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolResult {
    pub tool: String,
    pub ok: bool,
    pub output: String,
}

impl ToolResult {
    pub fn ok(tool: impl Into<String>, output: impl Into<String>) -> Self {
        Self { tool: tool.into(), ok: true, output: output.into() }
    }
    pub fn err(tool: impl Into<String>, msg: impl Into<String>) -> Self {
        Self { tool: tool.into(), ok: false, output: msg.into() }
    }
}

/// Tool descriptor for the LLM system prompt.
#[derive(Debug, Clone)]
pub struct ToolDescriptor {
    pub name: &'static str,
    pub description: &'static str,
    pub params: &'static str,
}

/// A boxed async tool handler.
#[async_trait]
pub trait Tool: Send + Sync {
    fn descriptor(&self) -> ToolDescriptor;
    async fn execute(&self, args: &serde_json::Value) -> ToolResult;
    /// Returns a human-readable preview of what this tool would do (for dry-run display).
    fn dry_run_preview(&self, args: &serde_json::Value) -> Option<String> {
        let _ = args;
        None
    }
}

/// Registry of all available tools.
pub struct ToolRegistry {
    tools: HashMap<String, Box<dyn Tool>>,
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self { tools: HashMap::new() }
    }

    pub fn register(&mut self, tool: Box<dyn Tool>) {
        self.tools.insert(tool.descriptor().name.to_string(), tool);
    }

    pub fn describe_all(&self) -> String {
        self.tools.values()
            .map(|t| {
                let d = t.descriptor();
                format!("- {} ({}): {}", d.name, d.params, d.description)
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    pub fn dry_run_preview(&self, call: &ToolCall) -> Option<String> {
        self.tools.get(&call.tool)?.dry_run_preview(&call.args)
    }

    pub async fn execute(&self, call: &ToolCall) -> ToolResult {
        match self.tools.get(&call.tool) {
            Some(tool) => tool.execute(&call.args).await,
            None => ToolResult::err(&call.tool, format!("Unknown tool: {}", call.tool)),
        }
    }
}
