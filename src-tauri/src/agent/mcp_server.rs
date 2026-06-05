//! Local MCP-compatible JSON-RPC bridge (§7.4 / §15).
//!
//! Exposes Taomni's agent tool registry over a 127.0.0.1 HTTP listener with
//! token-based auth so an external MCP client (Claude Desktop, Goose, Cursor,
//! …) can drive `list_sessions`, `run_in_terminal`, etc.
//!
//! This is a **minimal** bridge — it speaks a subset of MCP-style JSON-RPC
//! (method=`tools/list` and `tools/call`) without pulling in the full `rmcp`
//! crate. Once we adopt rmcp the wire surface stays stable; only the
//! transport changes. Default state: disabled. Random port + random token.
//!
//! Security:
//! - Listener is bound to `127.0.0.1` exclusively (never `0.0.0.0`).
//! - Every request must carry `Authorization: Bearer <token>` matching the
//!   per-session token; otherwise we return 401 without leaking any state.
//! - Tool calls go through the same `agent::safety` middleware as the UI
//!   path, so blacklisted commands and disabled-write sessions stay blocked.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

#[derive(Debug, Clone, Serialize)]
pub struct McpServerInfo {
    pub running: bool,
    /// Loopback URL to paste into external MCP clients.
    pub url: Option<String>,
    /// Bearer token required by the listener. Returned only after the user
    /// explicitly starts the server.
    pub token: Option<String>,
}

struct McpServer {
    addr: String,
    token: String,
    stop_flag: Arc<AtomicBool>,
}

static SERVER: OnceLock<Mutex<Option<McpServer>>> = OnceLock::new();

fn slot() -> &'static Mutex<Option<McpServer>> {
    SERVER.get_or_init(|| Mutex::new(None))
}

/// Start the local MCP bridge if it isn't already running.
#[tauri::command]
pub async fn mcp_server_start() -> Result<McpServerInfo, String> {
    {
        let guard = slot().lock().unwrap();
        if let Some(s) = guard.as_ref() {
            return Ok(McpServerInfo {
                running: true,
                url: Some(format!("http://{}", s.addr)),
                token: Some(s.token.clone()),
            });
        }
    }

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Failed to bind MCP listener: {e}"))?;
    let addr = listener
        .local_addr()
        .map_err(|e| e.to_string())?
        .to_string();
    let token = generate_token();
    let stop_flag = Arc::new(AtomicBool::new(false));

    {
        let mut guard = slot().lock().unwrap();
        *guard = Some(McpServer {
            addr: addr.clone(),
            token: token.clone(),
            stop_flag: stop_flag.clone(),
        });
    }

    let token_clone = token.clone();
    tokio::spawn(async move {
        loop {
            if stop_flag.load(Ordering::SeqCst) {
                break;
            }
            let accept = tokio::time::timeout(Duration::from_secs(1), listener.accept()).await;
            let Ok(Ok((stream, _peer))) = accept else {
                continue;
            };
            let token = token_clone.clone();
            tokio::spawn(handle_connection(stream, token));
        }
    });

    Ok(McpServerInfo {
        running: true,
        url: Some(format!("http://{}", addr)),
        token: Some(token),
    })
}

/// Stop the listener if it's running.
#[tauri::command]
pub async fn mcp_server_stop() -> Result<(), String> {
    let info = {
        let mut guard = slot().lock().unwrap();
        guard.take()
    };
    if let Some(s) = info {
        s.stop_flag.store(true, Ordering::SeqCst);
    }
    Ok(())
}

/// Status query for the settings UI.
#[tauri::command]
pub async fn mcp_server_status() -> Result<McpServerInfo, String> {
    let guard = slot().lock().unwrap();
    Ok(match guard.as_ref() {
        Some(s) => McpServerInfo {
            running: true,
            url: Some(format!("http://{}", s.addr)),
            token: Some(s.token.clone()),
        },
        None => McpServerInfo {
            running: false,
            url: None,
            token: None,
        },
    })
}

fn generate_token() -> String {
    let mut buf = [0u8; 24];
    rand::fill(&mut buf);
    buf.iter().map(|b| format!("{:02x}", b)).collect()
}

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

async fn handle_connection(mut stream: tokio::net::TcpStream, token: String) {
    // Parse a minimal HTTP/1.1 POST. We only handle exactly one request per
    // connection; that's sufficient for an MCP-style call/response pattern.
    let (read, mut write) = stream.split();
    let mut reader = BufReader::new(read);

    let mut req_line = String::new();
    if reader.read_line(&mut req_line).await.is_err() {
        return;
    }

    let mut headers: Vec<(String, String)> = Vec::new();
    let mut content_length: usize = 0;
    let mut auth_ok = false;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).await.is_err() {
            return;
        }
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            break;
        }
        if let Some((k, v)) = trimmed.split_once(':') {
            let k = k.trim().to_lowercase();
            let v = v.trim().to_string();
            if k == "content-length" {
                content_length = v.parse().unwrap_or(0);
            }
            if k == "authorization" && v == format!("Bearer {}", token) {
                auth_ok = true;
            }
            headers.push((k, v));
        }
    }

    if !auth_ok {
        let _ = write
            .write_all(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n")
            .await;
        return;
    }

    let mut body = vec![0u8; content_length];
    if reader.read_exact(&mut body).await.is_err() {
        return;
    }

    let response_body = match serde_json::from_slice::<JsonRpcRequest>(&body) {
        Ok(req) => handle_jsonrpc(req).await,
        Err(e) => serde_json::to_string(&JsonRpcResponse {
            jsonrpc: "2.0",
            id: None,
            result: None,
            error: Some(JsonRpcError {
                code: -32700,
                message: format!("parse error: {e}"),
            }),
        })
        .unwrap_or_default(),
    };

    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
        response_body.len(),
        response_body,
    );
    let _ = write.write_all(response.as_bytes()).await;
}

async fn handle_jsonrpc(req: JsonRpcRequest) -> String {
    let response = match req.method.as_str() {
        "tools/list" => {
            let tools = enumerate_tools();
            JsonRpcResponse {
                jsonrpc: "2.0",
                id: req.id,
                result: Some(serde_json::json!({ "tools": tools })),
                error: None,
            }
        }
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
            match call_tool(&name, arguments).await {
                Ok(result) => JsonRpcResponse {
                    jsonrpc: "2.0",
                    id: req.id,
                    result: Some(result),
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
        _ => JsonRpcResponse {
            jsonrpc: "2.0",
            id: req.id,
            result: None,
            error: Some(JsonRpcError {
                code: -32601,
                message: format!("method not found: {}", req.method),
            }),
        },
    };
    serde_json::to_string(&response).unwrap_or_default()
}

fn enumerate_tools() -> Vec<serde_json::Value> {
    // Tool descriptions are kept in lock-step with §7.1 in the plan. The
    // structured shape is MCP-style (name + description + inputSchema-ish).
    [
        ("list_sessions", "列出所有已保存的 SSH 会话"),
        ("switch_tab", "切换到指定标签"),
        (
            "run_in_terminal",
            "在指定会话的终端中执行命令（默认 dry_run）",
        ),
        (
            "read_terminal_tail",
            "读取当前活跃终端最近 N 行（需 user_invoked=true）",
        ),
        ("sftp_upload", "在 SFTP 会话中上传本地文件"),
        ("search_history", "搜索命令历史并预填命令面板"),
        ("open_session_editor", "在新建会话编辑器中预填字段"),
        ("explain_error", "解释一段终端输出（错误信息）"),
        ("save_as_runbook", "把一组刚执行过的命令打包成 Runbook"),
        ("web_search", "在网络上搜索信息（需用户确认）"),
        ("web_fetch", "抓取一个 URL 的可读内容（仅 https 公网）"),
    ]
    .iter()
    .map(|(name, description)| {
        serde_json::json!({
            "name": name,
            "description": description,
        })
    })
    .collect()
}

async fn call_tool(name: &str, args: serde_json::Value) -> Result<serde_json::Value, String> {
    use crate::agent::tools::{ToolCall, ToolRegistry};

    // Tools that need an AppHandle / DB are not safe to call without a live
    // app context. The MCP bridge only enables stateless tools (web_search /
    // web_fetch / explain_error) for now; richer tool binding requires
    // capturing an AppHandle in the server state — out of scope for the
    // minimal v0 bridge.
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

    let call = ToolCall {
        tool: name.into(),
        args,
    };
    crate::agent::safety::check_tool_call(&call)?;
    let result = registry.execute(&call).await;
    if result.ok {
        Ok(serde_json::json!({
            "content": [{ "type": "text", "text": result.output }]
        }))
    } else {
        Err(result.output)
    }
}
