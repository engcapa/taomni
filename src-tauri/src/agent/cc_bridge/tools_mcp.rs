//! Stdio MCP server that reverse-exposes Taomni tools to Claude Code via
//! `--mcp-config`. CC spawns Taomni with `--mcp-server tools`, reads the
//! tools list, and can invoke them as if they were native CC tools.
//!
//! Only the subset of Taomni tools that don't need an AppHandle/DB are
//! reachable from this stdio server, because each invocation is a fresh
//! subprocess with no Tauri state. That covers the four most useful tools
//! for CC's "explain + remediate" workflow:
//!
//!   - `explain_error`   — pass-through, lets CC pull a Taomni explanation
//!   - `web_search`      — runs through the same SearXNG/BYOK path
//!   - `web_fetch`       — same SSRF defenses as the in-app path
//!   - `redact_text`     — surface Taomni's redactor as a CC tool
//!
//! Stateful tools (`run_in_terminal`, `sftp_upload`, `read_terminal_tail`,
//! …) stay confined to the in-app path where AppHandle is available.

use serde::{Deserialize, Serialize};
use std::io::{self, BufRead, Write};
use std::sync::Arc;

#[derive(Debug, Deserialize)]
struct JsonRpcRequest {
    #[allow(dead_code)]
    jsonrpc: Option<String>,
    id: Option<serde_json::Value>,
    method: String,
    #[serde(default)]
    params: serde_json::Value,
}

#[derive(Debug, Serialize)]
struct JsonRpcResponse {
    jsonrpc: &'static str,
    id: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<JsonRpcError>,
}

#[derive(Debug, Serialize)]
struct JsonRpcError {
    code: i32,
    message: String,
}

pub fn run_stdio() -> io::Result<()> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut stdout_lock = stdout.lock();

    let runtime = tokio::runtime::Runtime::new()?;

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) if !l.trim().is_empty() => l,
            Ok(_) => continue,
            Err(_) => break,
        };
        let response = match serde_json::from_str::<JsonRpcRequest>(&line) {
            Ok(req) => runtime.block_on(handle(req)),
            Err(e) => JsonRpcResponse {
                jsonrpc: "2.0",
                id: None,
                result: None,
                error: Some(JsonRpcError {
                    code: -32700,
                    message: format!("parse error: {e}"),
                }),
            },
        };
        if let Ok(text) = serde_json::to_string(&response) {
            writeln!(stdout_lock, "{}", text)?;
            stdout_lock.flush()?;
        }
    }
    Ok(())
}

async fn handle(req: JsonRpcRequest) -> JsonRpcResponse {
    match req.method.as_str() {
        "initialize" => JsonRpcResponse {
            jsonrpc: "2.0",
            id: req.id,
            result: Some(serde_json::json!({
                "protocolVersion": "2024-11-05",
                "serverInfo": { "name": "taomni-tools", "version": env!("CARGO_PKG_VERSION") },
                "capabilities": { "tools": {} }
            })),
            error: None,
        },
        "tools/list" => JsonRpcResponse {
            jsonrpc: "2.0",
            id: req.id,
            result: Some(serde_json::json!({ "tools": tools_list() })),
            error: None,
        },
        "tools/call" => {
            let name = req
                .params
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let arguments = req
                .params
                .get("arguments")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            match dispatch(&name, arguments).await {
                Ok(text) => JsonRpcResponse {
                    jsonrpc: "2.0",
                    id: req.id,
                    result: Some(serde_json::json!({
                        "content": [{ "type": "text", "text": text }]
                    })),
                    error: None,
                },
                Err(message) => JsonRpcResponse {
                    jsonrpc: "2.0",
                    id: req.id,
                    result: None,
                    error: Some(JsonRpcError {
                        code: -32000,
                        message,
                    }),
                },
            }
        }
        other => JsonRpcResponse {
            jsonrpc: "2.0",
            id: req.id,
            result: None,
            error: Some(JsonRpcError {
                code: -32601,
                message: format!("method not found: {other}"),
            }),
        },
    }
}

fn tools_list() -> Vec<serde_json::Value> {
    vec![
        serde_json::json!({
            "name": "explain_error",
            "description": "Explain a terminal error message. Returns a short Chinese-language explanation.",
            "inputSchema": {
                "type": "object",
                "properties": { "text": { "type": "string" } },
                "required": ["text"]
            }
        }),
        serde_json::json!({
            "name": "web_search",
            "description": "Search the web through Taomni's configured provider. Returns a JSON array of {title,url,snippet}.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query":      { "type": "string" },
                    "freshness":  { "type": "string", "enum": ["day","week","month","year"] },
                    "max_results":{ "type": "integer" }
                },
                "required": ["query"]
            }
        }),
        serde_json::json!({
            "name": "web_fetch",
            "description": "Fetch a URL's readable content. Only HTTPS public URLs are accepted.",
            "inputSchema": {
                "type": "object",
                "properties": { "url": { "type": "string" } },
                "required": ["url"]
            }
        }),
        serde_json::json!({
            "name": "redact_text",
            "description": "Redact sensitive patterns (passwords, tokens, Bearer headers) from a text snippet.",
            "inputSchema": {
                "type": "object",
                "properties": { "text": { "type": "string" } },
                "required": ["text"]
            }
        }),
    ]
}

async fn dispatch(name: &str, args: serde_json::Value) -> Result<String, String> {
    use crate::agent::tools::{ToolCall, ToolRegistry};

    let mut registry = ToolRegistry::new();
    registry.register(Box::new(crate::agent::tools::terminal::ExplainErrorTool));
    registry.register(Box::new(
        crate::agent::tools::web_search::WebSearchTool::new(Arc::new(
            crate::agent::search::searxng::SearXngProvider::new(
                crate::agent::search::instances::PUBLIC_INSTANCES[0],
            ),
        )),
    ));
    registry.register(Box::new(crate::agent::tools::web_fetch::WebFetchTool::new()));

    if name == "redact_text" {
        let text = args.get("text").and_then(|v| v.as_str()).unwrap_or("");
        let (cleaned, hits) = crate::chat::redact::redact(text);
        return Ok(serde_json::json!({
            "redacted_text": cleaned,
            "patterns_matched": hits,
        })
        .to_string());
    }

    let call = ToolCall {
        tool: name.into(),
        args,
    };
    crate::agent::safety::check_tool_call(&call)?;
    let result = registry.execute(&call).await;
    if result.ok {
        Ok(result.output)
    } else {
        Err(result.output)
    }
}
