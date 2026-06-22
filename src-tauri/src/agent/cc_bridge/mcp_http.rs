//! In-app rmcp Streamable-HTTP MCP server that Claude Code connects to (D1).
//!
//! Replaces the stdio `--mcp-server` bridges for the CC path: instead of CC
//! re-invoking the Taomni binary over stdio, CC's `.mcp.json` points a
//! `type:"http"` entry at this loopback server (Bearer-gated), so the tool
//! handlers run *inside* the live app and can touch `AppState` directly.
//!
//! Execution model (D2 hybrid):
//!   - read-only tools (`list_sessions`, `search_history`) run synchronously
//!     against `AppState.db` — no second connection, no round-trip.
//!   - side-effect tools (`run_in_terminal`, `sftp_upload`, `switch_tab`,
//!     `open_session_editor`, `save_as_runbook`) and `read_terminal_tail`
//!     (whose data lives in the frontend) emit an `agent-cc-tool` event and
//!     block on a oneshot until the frontend performs the effect and calls
//!     `cc_resolve_tool_call`.
//!   - `permission_prompt` (CC's `--permission-prompt-tool`) runs the safety
//!     pipeline + grading, and for write tools blocks on a human decision
//!     delivered by `cc_resolve_permission` (HITL, Phase 2).
//!
//! Security:
//!   - Bound to `127.0.0.1:random`; every request needs `Authorization:
//!     Bearer <token>` matching a minted per-thread token (401 otherwise).
//!   - Each token carries a scope `{thread_id, allowed_session_id, trust}`; a
//!     tool call naming a `session_id` outside that scope is rejected, so one
//!     thread's CC can never drive another thread's SSH session.

use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use axum::body::Body;
use axum::extract::Request;
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::Response;
use rmcp::handler::server::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, Content, ServerCapabilities, ServerInfo};
use rmcp::service::{RequestContext, RoleServer};
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::StreamableHttpService;
use rmcp::{tool, tool_handler, tool_router, ErrorData, ServerHandler};
use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

use crate::agent::tools::ToolCall;
use crate::state::{AppState, CcPermissionDecision, CcToolOutcome};

/// How long `permission_prompt` waits for a human decision before defaulting
/// to deny.
const PERMISSION_TIMEOUT_SECS: u64 = 300;
/// How long a side-effect tool waits for the frontend to perform the effect.
const TOOL_TIMEOUT_SECS: u64 = 600;

/// Trust tier inferred for a CC thread (D3). Local working dirs are lenient;
/// remote SSH sessions are strict. Surfaced to the UI; the safety pipeline
/// itself stays conservative regardless.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrustLevel {
    Lenient,
    Strict,
}

impl TrustLevel {
    fn as_str(self) -> &'static str {
        match self {
            TrustLevel::Lenient => "lenient",
            TrustLevel::Strict => "strict",
        }
    }
}

/// Authorization scope bound to a single minted token (one per CC thread).
#[derive(Clone)]
pub struct TokenScope {
    pub thread_id: String,
    pub allowed_session_id: Option<String>,
    pub trust: TrustLevel,
    /// When true, read-only `Bash`/`run_in_terminal` commands still require a
    /// confirmation (3.6 noise-reduction disabled by config). Snapshotted from
    /// `CcBridgeConfig.confirm_readonly` at provision time.
    pub confirm_readonly: bool,
    /// Tools the user pre-approved for the rest of this session via the
    /// ActionCard's "allow for session" choice.
    pub session_approved: Arc<Mutex<HashSet<String>>>,
}

type TokenMap = Arc<Mutex<HashMap<String, TokenScope>>>;

struct RunningServer {
    addr: SocketAddr,
    tokens: TokenMap,
}

static SERVER: OnceLock<Mutex<Option<RunningServer>>> = OnceLock::new();

fn slot() -> &'static Mutex<Option<RunningServer>> {
    SERVER.get_or_init(|| Mutex::new(None))
}

/// Loopback MCP endpoint URL for an address (the `/mcp` nest path).
pub fn server_url(addr: SocketAddr) -> String {
    format!("http://{addr}/mcp")
}

fn generate_token() -> String {
    let mut buf = [0u8; 24];
    rand::fill(&mut buf);
    buf.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Start the in-app CC MCP server if it isn't running yet; returns its address.
/// Idempotent — repeated calls return the existing listener.
pub async fn ensure_started(app: &AppHandle) -> Result<SocketAddr, String> {
    {
        let guard = slot().lock().unwrap();
        if let Some(s) = guard.as_ref() {
            return Ok(s.addr);
        }
    }

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Failed to bind CC MCP listener: {e}"))?;
    let addr = listener.local_addr().map_err(|e| e.to_string())?;
    let tokens: TokenMap = Arc::new(Mutex::new(HashMap::new()));

    let handler_app = app.clone();
    let handler_tokens = tokens.clone();
    let service = StreamableHttpService::new(
        move || Ok(CcHandler::new(handler_app.clone(), handler_tokens.clone())),
        Arc::new(LocalSessionManager::default()),
        Default::default(),
    );

    let auth_tokens = tokens.clone();
    let router = axum::Router::new()
        .nest_service("/mcp", service)
        .layer(axum::middleware::from_fn(move |req: Request, next: Next| {
            let toks = auth_tokens.clone();
            async move { auth_mw(toks, req, next).await }
        }));

    {
        let mut guard = slot().lock().unwrap();
        // Lost a race: another caller bound + stored first. Drop our listener.
        if let Some(s) = guard.as_ref() {
            return Ok(s.addr);
        }
        *guard = Some(RunningServer {
            addr,
            tokens: tokens.clone(),
        });
    }

    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, router).await {
            tracing::error!("CC MCP server exited: {e}");
        }
    });

    Ok(addr)
}

/// Mint a token scoped to one CC thread. The server must already be started.
pub fn mint_token(
    thread_id: String,
    allowed_session_id: Option<String>,
    trust: TrustLevel,
    confirm_readonly: bool,
) -> Result<(SocketAddr, String), String> {
    let guard = slot().lock().unwrap();
    let server = guard.as_ref().ok_or("CC MCP server not started")?;
    let token = generate_token();
    server.tokens.lock().unwrap().insert(
        token.clone(),
        TokenScope {
            thread_id,
            allowed_session_id,
            trust,
            confirm_readonly,
            session_approved: Arc::new(Mutex::new(HashSet::new())),
        },
    );
    Ok((server.addr, token))
}

/// Revoke a token (e.g. when its CC process stops). Idempotent.
pub fn revoke_token(token: &str) {
    if let Some(s) = slot().lock().unwrap().as_ref() {
        s.tokens.lock().unwrap().remove(token);
    }
}

/// Ensure the server is up and mint a scoped token for one CC thread. Trust is
/// inferred (D3): a thread linked to a remote SSH session is strict and scoped
/// to that session; an unlinked (local-workspace) thread is lenient. Returns
/// the `(server_url, token)` to inject into the thread's `.mcp.json`.
pub async fn provision_for_thread(
    app: &AppHandle,
    thread_id: &str,
    linked_session_id: Option<String>,
    confirm_readonly: bool,
) -> Result<(String, String), String> {
    ensure_started(app).await?;
    let trust = if linked_session_id.is_some() {
        TrustLevel::Strict
    } else {
        TrustLevel::Lenient
    };
    let (addr, token) = mint_token(thread_id.to_string(), linked_session_id, trust, confirm_readonly)?;
    Ok((server_url(addr), token))
}

/// Reject any request without a recognised Bearer token (401). Per-call scope
/// checks happen later, in the handler.
async fn auth_mw(tokens: TokenMap, req: Request, next: Next) -> Response {
    let ok = req
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|t| tokens.lock().unwrap().contains_key(t))
        .unwrap_or(false);
    if ok {
        next.run(req).await
    } else {
        Response::builder()
            .status(StatusCode::UNAUTHORIZED)
            .body(Body::empty())
            .unwrap()
    }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct CcHandler {
    app: AppHandle,
    tokens: TokenMap,
    tool_router: ToolRouter<Self>,
}

/// Build the CC permission-prompt `allow` reply CC expects from its
/// `--permission-prompt-tool`: `{behavior:"allow", updatedInput:{...}}`.
fn allow_json(input: &serde_json::Value) -> String {
    serde_json::json!({ "behavior": "allow", "updatedInput": input }).to_string()
}

/// Build the CC permission-prompt `deny` reply: `{behavior:"deny", message}`.
fn deny_json(message: impl Into<String>) -> String {
    serde_json::json!({ "behavior": "deny", "message": message.into() }).to_string()
}

fn allow_result(input: &serde_json::Value) -> CallToolResult {
    CallToolResult::success(vec![Content::text(allow_json(input))])
}

fn deny_result(message: impl Into<String>) -> CallToolResult {
    CallToolResult::success(vec![Content::text(deny_json(message))])
}

/// CC names MCP tools as `mcp__<server>__<tool>` when it asks the
/// `--permission-prompt-tool` for a decision. Strip that prefix so the call is
/// graded against Taomni's bare tool vocabulary (`run_in_terminal`, …) — the
/// same names `is_write_tool` / `check_tool_call` recognize. CC's own built-in
/// tools (`Bash`, `Edit`, …) arrive unprefixed and pass through unchanged.
fn normalize_tool_name(name: &str) -> &str {
    name.strip_prefix("mcp__")
        .and_then(|rest| rest.split_once("__"))
        .map(|(_server, tool)| tool)
        .unwrap_or(name)
}

/// Enforce that any `session_id` named in a tool call is the one this token is
/// bound to. Tokens with no bound session may not touch a session at all.
fn enforce_session_scope(scope: &TokenScope, args: &serde_json::Value) -> Result<(), String> {
    if let Some(sid) = args.get("session_id").and_then(|v| v.as_str()) {
        match scope.allowed_session_id.as_deref() {
            Some(allowed) if allowed == sid => Ok(()),
            _ => Err(format!(
                "session '{sid}' is out of scope for this thread"
            )),
        }
    } else {
        Ok(())
    }
}

impl CcHandler {
    fn new(app: AppHandle, tokens: TokenMap) -> Self {
        Self {
            app,
            tokens,
            tool_router: Self::tool_router(),
        }
    }

    /// Resolve the calling token's scope from the request's Bearer header.
    fn scope(&self, ctx: &RequestContext<RoleServer>) -> Result<TokenScope, ErrorData> {
        let parts = ctx
            .extensions
            .get::<axum::http::request::Parts>()
            .ok_or_else(|| ErrorData::internal_error("missing http request parts", None))?;
        let token = parts
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .ok_or_else(|| ErrorData::invalid_params("missing bearer token", None))?;
        self.tokens
            .lock()
            .unwrap()
            .get(token)
            .cloned()
            .ok_or_else(|| ErrorData::invalid_params("unknown token", None))
    }

    fn app_state(&self) -> tauri::State<'_, AppState> {
        self.app.state::<AppState>()
    }

    /// Emit an `agent-cc-tool` event and block until the frontend performs the
    /// effect and calls `cc_resolve_tool_call` (or we time out).
    async fn dispatch_side_effect(
        &self,
        scope: &TokenScope,
        tool: &str,
        args: serde_json::Value,
    ) -> Result<CallToolResult, ErrorData> {
        let call_id = Uuid::new_v4().to_string();
        let (tx, rx) = tokio::sync::oneshot::channel::<CcToolOutcome>();
        {
            let state = self.app_state();
            state
                .cc_pending_tool_calls
                .lock()
                .unwrap()
                .insert(call_id.clone(), tx);
        }
        let _ = self.app.emit(
            "agent-cc-tool",
            serde_json::json!({
                "callId": call_id,
                "threadId": scope.thread_id,
                "tool": tool,
                "args": args,
            }),
        );

        match tokio::time::timeout(Duration::from_secs(TOOL_TIMEOUT_SECS), rx).await {
            Ok(Ok(outcome)) if outcome.ok => {
                Ok(CallToolResult::success(vec![Content::text(outcome.output)]))
            }
            Ok(Ok(outcome)) => Err(ErrorData::internal_error(outcome.output, None)),
            _ => {
                // Timed out or sender dropped — clean up the registry slot.
                let state = self.app_state();
                state.cc_pending_tool_calls.lock().unwrap().remove(&call_id);
                Err(ErrorData::internal_error(
                    "tool call timed out or was cancelled".to_string(),
                    None,
                ))
            }
        }
    }

    /// Emit `agent-cc-permission` and block until a human decision arrives via
    /// `cc_resolve_permission` (defaults to deny on timeout).
    async fn await_permission(
        &self,
        scope: &TokenScope,
        tool: &str,
        input: &serde_json::Value,
    ) -> CcPermissionDecision {
        let call_id = Uuid::new_v4().to_string();
        let (tx, rx) = tokio::sync::oneshot::channel::<CcPermissionDecision>();
        {
            let state = self.app_state();
            state
                .cc_pending_permissions
                .lock()
                .unwrap()
                .insert(call_id.clone(), tx);
        }
        let _ = self.app.emit(
            "agent-cc-permission",
            serde_json::json!({
                "callId": call_id,
                "threadId": scope.thread_id,
                "tool": tool,
                "args": input,
                "trust": scope.trust.as_str(),
            }),
        );

        match tokio::time::timeout(Duration::from_secs(PERMISSION_TIMEOUT_SECS), rx).await {
            Ok(Ok(decision)) => decision,
            _ => {
                let state = self.app_state();
                state.cc_pending_permissions.lock().unwrap().remove(&call_id);
                CcPermissionDecision::Deny
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Tool parameter schemas
// ---------------------------------------------------------------------------

#[derive(Deserialize, schemars::JsonSchema, Default)]
struct ListSessionsParams {
    /// Optional case-insensitive filter over session name / host.
    #[serde(default)]
    query: Option<String>,
}

#[derive(Deserialize, schemars::JsonSchema)]
struct SearchHistoryParams {
    /// Substring to search command history for.
    query: String,
}

#[derive(Deserialize, schemars::JsonSchema, serde::Serialize)]
struct ReadTerminalTailParams {
    session_id: Option<String>,
    #[serde(default)]
    lines: Option<u32>,
    /// Must be true — only available when the user explicitly triggered a read.
    user_invoked: bool,
}

#[derive(Deserialize, schemars::JsonSchema, serde::Serialize)]
struct RunInTerminalParams {
    session_id: Option<String>,
    command: String,
}

#[derive(Deserialize, schemars::JsonSchema, serde::Serialize)]
struct SwitchTabParams {
    /// Session id, name, or host fragment to switch to.
    query: String,
}

#[derive(Deserialize, schemars::JsonSchema, serde::Serialize)]
struct OpenSessionEditorParams {
    name: Option<String>,
    host: Option<String>,
    username: Option<String>,
}

#[derive(Deserialize, schemars::JsonSchema, serde::Serialize)]
struct SftpUploadParams {
    session_id: String,
    local_path: String,
    remote_path: String,
}

#[derive(Deserialize, schemars::JsonSchema, serde::Serialize)]
struct SaveAsRunbookParams {
    name: String,
    commands: Vec<String>,
}

#[derive(Deserialize, schemars::JsonSchema)]
struct PermissionParams {
    tool_name: String,
    // Claude Code's permission-prompt protocol sends the requested tool's input
    // under `input`. Accept `tool_input` as an alias for forward/back-compat.
    // Without this the field silently defaulted to `Null`, so we emitted
    // `args: null` to the UI and handed CC back `updatedInput: null`.
    #[serde(default, alias = "input")]
    tool_input: serde_json::Value,
}

fn as_value<T: serde::Serialize>(p: &T) -> serde_json::Value {
    serde_json::to_value(p).unwrap_or(serde_json::Value::Null)
}

/// CC usually omits `session_id` — it doesn't know the thread's bound session.
/// Fill it from the token scope so the effect targets the linked terminal and
/// the session-scope check passes. No-op when the arg is already present or the
/// thread is global (no bound session).
fn fill_session_id(args: &mut serde_json::Value, scope: &TokenScope) {
    let present = args.get("session_id").and_then(|v| v.as_str()).is_some();
    if present {
        return;
    }
    if let (Some(sid), Some(obj)) = (scope.allowed_session_id.clone(), args.as_object_mut()) {
        obj.insert("session_id".into(), serde_json::Value::String(sid));
    }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

#[tool_router]
impl CcHandler {
    #[tool(name = "list_sessions", description = "列出所有已保存的 SSH/终端会话（可按名称/主机过滤）")]
    async fn list_sessions(
        &self,
        Parameters(p): Parameters<ListSessionsParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.scope(&ctx)?;
        let q = p.query.unwrap_or_default().to_lowercase();
        let state = self.app_state();
        let db = state
            .db
            .lock()
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        let sessions = crate::session::db::list_sessions(&db, None)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        let lines: Vec<String> = sessions
            .iter()
            .filter(|s| {
                q.is_empty()
                    || s.name.to_lowercase().contains(&q)
                    || s.host.to_lowercase().contains(&q)
            })
            .map(|s| {
                format!(
                    "{}: {} ({}@{}:{})",
                    s.id,
                    s.name,
                    s.username.as_deref().unwrap_or(""),
                    s.host,
                    s.port
                )
            })
            .collect();
        Ok(CallToolResult::success(vec![Content::text(
            lines.join("\n"),
        )]))
    }

    #[tool(name = "search_history", description = "搜索命令历史记录并返回匹配的命令列表")]
    async fn search_history(
        &self,
        Parameters(p): Parameters<SearchHistoryParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.scope(&ctx)?;
        let state = self.app_state();
        let db = state
            .db
            .lock()
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        let results = crate::history::db_search(&db, &p.query, 20)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        Ok(CallToolResult::success(vec![Content::text(
            results.join("\n"),
        )]))
    }

    #[tool(name = "read_terminal_tail", description = "读取当前活跃终端最近 N 行输出（需 user_invoked=true）")]
    async fn read_terminal_tail(
        &self,
        Parameters(p): Parameters<ReadTerminalTailParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let mut args = as_value(&p);
        fill_session_id(&mut args, &scope);
        enforce_session_scope(&scope, &args).map_err(|e| ErrorData::invalid_params(e, None))?;
        self.dispatch_side_effect(&scope, "read_terminal_tail", args).await
    }

    #[tool(name = "run_in_terminal", description = "在指定会话的终端中执行命令（危险动作，需用户确认）")]
    async fn run_in_terminal(
        &self,
        Parameters(p): Parameters<RunInTerminalParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let mut args = as_value(&p);
        fill_session_id(&mut args, &scope);
        enforce_session_scope(&scope, &args).map_err(|e| ErrorData::invalid_params(e, None))?;
        // Defense in depth: re-run the blacklist even though permission_prompt
        // already did (CC may have an allowlist that skips the prompt).
        let call = ToolCall {
            tool: "run_in_terminal".into(),
            args: args.clone(),
        };
        crate::agent::safety::check_tool_call(&call)
            .map_err(|e| ErrorData::invalid_params(e, None))?;
        self.dispatch_side_effect(&scope, "run_in_terminal", args).await
    }

    #[tool(name = "switch_tab", description = "切换到指定会话/标签")]
    async fn switch_tab(
        &self,
        Parameters(p): Parameters<SwitchTabParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        self.dispatch_side_effect(&scope, "switch_tab", as_value(&p)).await
    }

    #[tool(name = "open_session_editor", description = "打开新会话编辑器，可预填 name/host/username")]
    async fn open_session_editor(
        &self,
        Parameters(p): Parameters<OpenSessionEditorParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        self.dispatch_side_effect(&scope, "open_session_editor", as_value(&p)).await
    }

    #[tool(name = "sftp_upload", description = "在 SFTP 会话中上传本地文件（危险动作，需用户确认）")]
    async fn sftp_upload(
        &self,
        Parameters(p): Parameters<SftpUploadParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let args = as_value(&p);
        enforce_session_scope(&scope, &args).map_err(|e| ErrorData::invalid_params(e, None))?;
        self.dispatch_side_effect(&scope, "sftp_upload", args).await
    }

    #[tool(name = "save_as_runbook", description = "把一组命令打包成 Runbook（写动作，需用户确认）")]
    async fn save_as_runbook(
        &self,
        Parameters(p): Parameters<SaveAsRunbookParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        self.dispatch_side_effect(&scope, "save_as_runbook", as_value(&p)).await
    }

    #[tool(
        name = "permission_prompt",
        description = "Approve or deny a Claude Code tool call per Taomni's safety rules + human-in-the-loop confirmation."
    )]
    async fn permission_prompt(
        &self,
        Parameters(p): Parameters<PermissionParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;

        // CC sends MCP tools as `mcp__taomni__<tool>`; grade the bare name.
        let tool_name = normalize_tool_name(&p.tool_name).to_string();

        // 1. Session/thread scope.
        if let Err(reason) = enforce_session_scope(&scope, &p.tool_input) {
            return Ok(deny_result(reason));
        }
        // 2. Blacklist / sensitive-path deny-list.
        let call = ToolCall {
            tool: tool_name.clone(),
            args: p.tool_input.clone(),
        };
        if let Err(reason) = crate::agent::safety::check_tool_call(&call) {
            return Ok(deny_result(reason));
        }
        // 3. Per-session "AI 写动作禁用".
        {
            let state = self.app_state();
            if let Err(reason) = crate::agent::safety::check_session_disable(&state, &call) {
                return Ok(deny_result(reason));
            }
        }
        // 4. Grading: writes need a human unless already approved for session.
        let already = scope
            .session_approved
            .lock()
            .unwrap()
            .contains(&tool_name);
        // 3.6 — a confidently read-only shell command waives the card (unless
        // the user forced confirm-all via config). Anything not provably
        // read-only stays Mutating (the safe default) and still confirms. The
        // blacklist + sensitive-path checks above already ran, so this only
        // ever waives *confirmation*, never safety.
        let is_readonly = !scope.confirm_readonly
            && matches!(tool_name.as_str(), "Bash" | "run_in_terminal")
            && p.tool_input
                .get("command")
                .and_then(|v| v.as_str())
                .map(|cmd| {
                    crate::agent::cmd_classify::classify(cmd)
                        == crate::agent::cmd_classify::CommandClass::ReadOnly
                })
                .unwrap_or(false);
        let needs_confirm =
            crate::agent::safety::requires_confirmation(&tool_name) && !already && !is_readonly;
        if !needs_confirm {
            return Ok(allow_result(&p.tool_input));
        }
        // 5. Human-in-the-loop.
        match self.await_permission(&scope, &tool_name, &p.tool_input).await {
            CcPermissionDecision::Allow => Ok(allow_result(&p.tool_input)),
            CcPermissionDecision::AllowSession => {
                scope
                    .session_approved
                    .lock()
                    .unwrap()
                    .insert(tool_name.clone());
                Ok(allow_result(&p.tool_input))
            }
            CcPermissionDecision::Deny => Ok(deny_result("denied by user")),
        }
    }
}

#[tool_handler]
impl ServerHandler for CcHandler {
    fn get_info(&self) -> ServerInfo {
        let mut info = ServerInfo::default();
        info.capabilities = ServerCapabilities::builder().enable_tools().build();
        info.instructions = Some(
            "Taomni in-app tools. Side-effect tools route through human confirmation.".into(),
        );
        info
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scope(thread: &str, allowed: Option<&str>) -> TokenScope {
        TokenScope {
            thread_id: thread.into(),
            allowed_session_id: allowed.map(|s| s.to_string()),
            trust: TrustLevel::Strict,
            confirm_readonly: false,
            session_approved: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    #[test]
    fn no_session_id_always_in_scope() {
        let s = scope("t1", Some("sess-a"));
        assert!(enforce_session_scope(&s, &json!({ "command": "ls" })).is_ok());
    }

    #[test]
    fn matching_session_id_allowed() {
        let s = scope("t1", Some("sess-a"));
        assert!(enforce_session_scope(&s, &json!({ "session_id": "sess-a" })).is_ok());
    }

    #[test]
    fn foreign_session_id_rejected() {
        let s = scope("t1", Some("sess-a"));
        assert!(enforce_session_scope(&s, &json!({ "session_id": "sess-b" })).is_err());
    }

    #[test]
    fn local_token_cannot_name_any_session() {
        // A thread bound to no session (local working dir) must not touch one.
        let s = scope("t1", None);
        assert!(enforce_session_scope(&s, &json!({ "session_id": "sess-a" })).is_err());
    }

    #[test]
    fn allow_result_carries_updated_input() {
        let input = json!({ "command": "ls -la" });
        let parsed: serde_json::Value = serde_json::from_str(&allow_json(&input)).unwrap();
        assert_eq!(parsed["behavior"], "allow");
        assert_eq!(parsed["updatedInput"]["command"], "ls -la");
    }

    #[test]
    fn deny_result_carries_message() {
        let parsed: serde_json::Value =
            serde_json::from_str(&deny_json("blocked: rm -rf /")).unwrap();
        assert_eq!(parsed["behavior"], "deny");
        assert_eq!(parsed["message"], "blocked: rm -rf /");
    }

    #[test]
    fn normalize_strips_mcp_prefix() {
        // CC sends our tools prefixed; grading must see the bare name so
        // `requires_confirmation` recognizes the write tool and fires a card.
        assert_eq!(
            normalize_tool_name("mcp__taomni__run_in_terminal"),
            "run_in_terminal"
        );
        assert!(crate::agent::safety::requires_confirmation(normalize_tool_name(
            "mcp__taomni__run_in_terminal"
        )));
    }

    #[test]
    fn normalize_leaves_builtin_tools_untouched() {
        assert_eq!(normalize_tool_name("Bash"), "Bash");
        assert_eq!(normalize_tool_name("Edit"), "Edit");
    }

    #[test]
    fn permission_params_reads_cc_input_field() {
        // CC's permission-prompt protocol sends the requested tool's args under
        // `input`. If we only accept `tool_input` the field defaults to Null and
        // we emit `args: null` (crashing the UI card) + hand CC `updatedInput: null`.
        let p: PermissionParams = serde_json::from_value(json!({
            "tool_name": "mcp__taomni__run_in_terminal",
            "input": { "command": "uname -a" }
        }))
        .unwrap();
        assert_eq!(p.tool_input["command"], "uname -a");
    }

    #[test]
    fn permission_params_still_reads_tool_input_alias() {
        let p: PermissionParams = serde_json::from_value(json!({
            "tool_name": "Bash",
            "tool_input": { "command": "ls" }
        }))
        .unwrap();
        assert_eq!(p.tool_input["command"], "ls");
    }

    #[test]
    fn fill_session_id_uses_bound_session_when_omitted() {
        let s = scope("t1", Some("sess-a"));
        let mut args = json!({ "command": "uname -a" });
        fill_session_id(&mut args, &s);
        assert_eq!(args["session_id"], "sess-a");
        // And the scope check now passes for the injected id.
        assert!(enforce_session_scope(&s, &args).is_ok());
    }

    #[test]
    fn fill_session_id_respects_explicit_arg() {
        let s = scope("t1", Some("sess-a"));
        let mut args = json!({ "session_id": "sess-a", "command": "ls" });
        fill_session_id(&mut args, &s);
        assert_eq!(args["session_id"], "sess-a");
    }

    #[test]
    fn fill_session_id_noop_for_global_thread() {
        let s = scope("t1", None);
        let mut args = json!({ "command": "ls" });
        fill_session_id(&mut args, &s);
        assert!(args.get("session_id").is_none());
    }

    // Exercises the Bearer auth boundary over a real loopback HTTP round-trip,
    // using the same `auth_mw` the server mounts — without needing CC or a
    // Tauri AppState. Covers the "401 when no/invalid token" requirement.
    #[tokio::test]
    async fn auth_middleware_gates_on_bearer() {
        use axum::routing::get;

        let tokens: TokenMap = Arc::new(Mutex::new(HashMap::new()));
        tokens.lock().unwrap().insert(
            "good-token".to_string(),
            scope("t1", None),
        );

        let mw_tokens = tokens.clone();
        let app = axum::Router::new()
            .route("/x", get(|| async { "ok" }))
            .layer(axum::middleware::from_fn(
                move |req: Request, next: Next| {
                    let toks = mw_tokens.clone();
                    async move { auth_mw(toks, req, next).await }
                },
            ));

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let base = format!("http://{addr}/x");
        let client = reqwest::Client::new();

        let no_token = client.get(&base).send().await.unwrap();
        assert_eq!(no_token.status(), 401, "missing token must be 401");

        let bad = client
            .get(&base)
            .header("Authorization", "Bearer wrong")
            .send()
            .await
            .unwrap();
        assert_eq!(bad.status(), 401, "unknown token must be 401");

        let good = client
            .get(&base)
            .header("Authorization", "Bearer good-token")
            .send()
            .await
            .unwrap();
        assert_eq!(good.status(), 200, "valid token must pass");
    }
}

