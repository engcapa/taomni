//! Stdio MCP server for Claude Code's `--permission-prompt-tool`.
//!
//! When CC spawns NewMob with `--mcp-server permissions`, this loop reads
//! NDJSON requests from stdin and writes NDJSON responses to stdout. CC
//! invokes the `permission_prompt` tool every time it wants to call any
//! other tool; our implementation runs the request through NewMob's
//! existing safety pipeline (`agent::safety::check_tool_call`) so the
//! shell-command blacklist (§5.3) catches `rm -rf /` even when CC drives
//! the call.
//!
//! The protocol is a minimal JSON-RPC subset matching MCP's tool surface:
//!   - `initialize` → ack with server info
//!   - `tools/list` → exposes `permission_prompt`
//!   - `tools/call` (name=permission_prompt) → returns `{behavior: allow|deny}`
//!
//! We intentionally avoid pulling in a full MCP SDK here — the wire shape
//! is tiny and stable, and shipping a 50-line stdio loop keeps NewMob's
//! release binary footprint flat. Once `rmcp` is in the dep tree this
//! module becomes a thin wrapper around it.

use serde::{Deserialize, Serialize};
use std::io::{self, BufRead, Write};

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

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) if !l.trim().is_empty() => l,
            Ok(_) => continue,
            Err(_) => break,
        };
        let response = match serde_json::from_str::<JsonRpcRequest>(&line) {
            Ok(req) => handle(req),
            Err(e) => JsonRpcResponse {
                jsonrpc: "2.0",
                id: None,
                result: None,
                error: Some(JsonRpcError { code: -32700, message: format!("parse error: {e}") }),
            },
        };
        if let Ok(text) = serde_json::to_string(&response) {
            writeln!(stdout_lock, "{}", text)?;
            stdout_lock.flush()?;
        }
    }
    Ok(())
}

fn handle(req: JsonRpcRequest) -> JsonRpcResponse {
    match req.method.as_str() {
        "initialize" => JsonRpcResponse {
            jsonrpc: "2.0",
            id: req.id,
            result: Some(serde_json::json!({
                "protocolVersion": "2024-11-05",
                "serverInfo": { "name": "newmob-permissions", "version": env!("CARGO_PKG_VERSION") },
                "capabilities": { "tools": {} }
            })),
            error: None,
        },
        "tools/list" => JsonRpcResponse {
            jsonrpc: "2.0",
            id: req.id,
            result: Some(serde_json::json!({
                "tools": [{
                    "name": "permission_prompt",
                    "description": "Approve or deny a tool call from Claude Code based on NewMob's safety rules (blacklist + per-session disable).",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "tool_name":  { "type": "string" },
                            "tool_input": { "type": "object" }
                        },
                        "required": ["tool_name", "tool_input"]
                    }
                }]
            })),
            error: None,
        },
        "tools/call" => {
            let name = req.params.get("name").and_then(|v| v.as_str()).unwrap_or("");
            if name != "permission_prompt" {
                return JsonRpcResponse {
                    jsonrpc: "2.0",
                    id: req.id,
                    result: None,
                    error: Some(JsonRpcError { code: -32602, message: format!("unknown tool: {name}") }),
                };
            }
            let args = req.params.get("arguments").cloned().unwrap_or(serde_json::Value::Null);
            let tool_name = args.get("tool_name").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let tool_input = args.get("tool_input").cloned().unwrap_or(serde_json::Value::Object(Default::default()));

            let call = crate::agent::tools::ToolCall { tool: tool_name.clone(), args: tool_input.clone() };
            let decision = match crate::agent::safety::check_tool_call(&call) {
                Ok(()) => serde_json::json!({
                    "behavior": "allow",
                    "updatedInput": tool_input,
                }),
                Err(reason) => serde_json::json!({
                    "behavior": "deny",
                    "message": reason,
                }),
            };
            JsonRpcResponse {
                jsonrpc: "2.0",
                id: req.id,
                result: Some(serde_json::json!({
                    "content": [{
                        "type": "text",
                        "text": decision.to_string()
                    }]
                })),
                error: None,
            }
        }
        other => JsonRpcResponse {
            jsonrpc: "2.0",
            id: req.id,
            result: None,
            error: Some(JsonRpcError { code: -32601, message: format!("method not found: {other}") }),
        },
    }
}
