//! `taomni_control` MCP flavor: app-control tools shared by every Claude Code
//! and Codex thread. Domain tools stay split by Shell/SQL/Redis; this surface is
//! for Taomni sessions, groups, tabs, and high-level UI commands.

use std::time::Duration;

use rmcp::handler::server::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, Content, ServerCapabilities, ServerInfo};
use rmcp::service::{RequestContext, RoleServer};
use rmcp::{tool, tool_handler, tool_router, ErrorData, ServerHandler};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

use crate::agent::tools::ToolCall;
use crate::session::models::{AuthMethod, SessionConfig, SessionGroup, SessionType};
use crate::state::{AppState, CcToolOutcome};

use super::mcp_http::{
    decide_permission, enforce_inline_permission, normalize_tool_name, scope_from_ctx,
    PermissionParams, TokenMap, TokenScope, TOOL_TIMEOUT_SECS,
};

#[derive(Clone)]
pub struct ControlHandler {
    app: AppHandle,
    tokens: TokenMap,
    tool_router: ToolRouter<Self>,
}

impl ControlHandler {
    pub fn new(app: AppHandle, tokens: TokenMap) -> Self {
        Self {
            app,
            tokens,
            tool_router: Self::tool_router(),
        }
    }

    fn scope(&self, ctx: &RequestContext<RoleServer>) -> Result<TokenScope, ErrorData> {
        scope_from_ctx(&self.tokens, ctx)
    }

    fn app_state(&self) -> tauri::State<'_, AppState> {
        self.app.state::<AppState>()
    }

    fn emit_sessions_changed(&self) {
        let _ = self
            .app
            .emit("taomni-sessions-changed", serde_json::json!({}));
    }

    async fn require_write(
        &self,
        scope: &TokenScope,
        tool: &str,
        args: &Value,
    ) -> Result<(), ErrorData> {
        let call = ToolCall {
            tool: tool.to_string(),
            args: args.clone(),
        };
        crate::agent::safety::check_tool_call(&call)
            .map_err(|e| ErrorData::invalid_params(e, None))?;
        enforce_inline_permission(&self.app, scope, tool, args, false).await
    }

    async fn dispatch_control_side_effect(
        &self,
        scope: &TokenScope,
        tool: &str,
        args: Value,
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
            "agent-cc-control-tool",
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
                let state = self.app_state();
                state.cc_pending_tool_calls.lock().unwrap().remove(&call_id);
                Err(ErrorData::internal_error(
                    "control tool call timed out or was cancelled".to_string(),
                    None,
                ))
            }
        }
    }
}

#[derive(Deserialize, schemars::JsonSchema, Default)]
struct SessionListParams {
    #[serde(default)]
    query: Option<String>,
    #[serde(default)]
    session_type: Option<String>,
    #[serde(default)]
    group_path: Option<String>,
}

#[derive(Deserialize, Serialize, schemars::JsonSchema)]
struct SessionIdParams {
    session_id: String,
}

#[derive(Deserialize, Serialize, schemars::JsonSchema)]
struct SessionCreateParams {
    #[serde(default)]
    id: Option<String>,
    name: String,
    session_type: String,
    #[serde(default)]
    group_path: Option<String>,
    #[serde(default)]
    host: Option<String>,
    #[serde(default)]
    port: Option<u16>,
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    auth: Option<SessionAuthParams>,
    #[serde(default)]
    options: Option<Value>,
}

#[derive(Deserialize, Serialize, schemars::JsonSchema)]
struct SessionUpdateParams {
    session_id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    session_type: Option<String>,
    #[serde(default)]
    group_path: Option<String>,
    #[serde(default)]
    host: Option<String>,
    #[serde(default)]
    port: Option<u16>,
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    auth: Option<SessionAuthParams>,
    #[serde(default)]
    options: Option<Value>,
}

#[derive(Deserialize, schemars::JsonSchema, Serialize)]
struct SessionAuthParams {
    /// none | agent | private_key | password_ref. Plaintext passwords are not accepted.
    method: String,
    #[serde(default)]
    private_key_path: Option<String>,
    #[serde(default)]
    password_ref: Option<String>,
}

#[derive(Deserialize, Serialize, schemars::JsonSchema)]
struct SessionDuplicateParams {
    session_id: String,
    #[serde(default)]
    name: Option<String>,
}

#[derive(Deserialize, Serialize, schemars::JsonSchema)]
struct SessionMoveGroupParams {
    session_id: String,
    #[serde(default)]
    group_path: Option<String>,
}

#[derive(Deserialize, Serialize, schemars::JsonSchema)]
struct GroupPathParams {
    path: String,
}

#[derive(Deserialize, Serialize, schemars::JsonSchema)]
struct GroupRenameParams {
    old_path: String,
    new_path: String,
}

#[derive(Deserialize, Serialize, schemars::JsonSchema)]
struct GroupDeleteParams {
    path: String,
    /// false clears affected sessions' group_path; true deletes affected sessions too.
    #[serde(default)]
    delete_sessions: bool,
}

#[derive(Deserialize, schemars::JsonSchema, Serialize)]
struct SessionOpenParams {
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    query: Option<String>,
}

#[derive(Deserialize, schemars::JsonSchema, Serialize)]
struct SessionOpenEditorParams {
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    session_type: Option<String>,
    #[serde(default)]
    group_path: Option<String>,
}

#[derive(Deserialize, schemars::JsonSchema, Serialize)]
struct QuickConnectParams {
    input: String,
}

#[derive(Deserialize, schemars::JsonSchema, Serialize, Default)]
struct EmptyParams {}

#[derive(Deserialize, schemars::JsonSchema, Serialize)]
struct TabIdParams {
    tab_id: String,
}

#[derive(Deserialize, schemars::JsonSchema, Serialize)]
struct TabRenameParams {
    tab_id: String,
    title: String,
}

#[derive(Deserialize, schemars::JsonSchema, Serialize)]
struct TabMoveParams {
    tab_id: String,
    to_index: usize,
}

#[derive(Deserialize, schemars::JsonSchema, Serialize)]
struct OpenLocalTerminalParams {
    #[serde(default)]
    title: Option<String>,
}

#[derive(Deserialize, schemars::JsonSchema, Serialize)]
struct OpenFileBrowserParams {
    path: String,
    #[serde(default)]
    title: Option<String>,
}

fn text(value: impl Into<String>) -> CallToolResult {
    CallToolResult::success(vec![Content::text(value.into())])
}

fn json_text<T: Serialize>(value: &T) -> Result<CallToolResult, ErrorData> {
    serde_json::to_string_pretty(value)
        .map(text)
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))
}

fn now_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn parse_session_type(s: &str) -> Result<SessionType, String> {
    let canonical = [
        "SSH",
        "Telnet",
        "RDP",
        "VNC",
        "FTP",
        "SFTP",
        "Serial",
        "LocalShell",
        "File",
        "MySQL",
        "PostgreSQL",
        "SQLServer",
        "ClickHouse",
        "Presto",
        "Redis",
        "HBaseShell",
        "Proxy",
        "S3",
        "AzureBlob",
    ];
    if canonical.iter().any(|v| v.eq_ignore_ascii_case(s)) {
        Ok(SessionType::from_str(s))
    } else {
        Err(format!("unknown session_type '{s}'"))
    }
}

fn normalize_group_path(path: Option<&str>) -> Option<String> {
    let raw = path?.trim();
    if raw.is_empty() {
        return None;
    }
    let parts: Vec<String> = raw
        .replace('\\', "/")
        .split('/')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string)
        .collect();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(" / "))
    }
}

fn parent_group_path(path: &str) -> Option<String> {
    let parts: Vec<&str> = path.split(" / ").collect();
    if parts.len() <= 1 {
        None
    } else {
        Some(parts[..parts.len() - 1].join(" / "))
    }
}

fn leaf_group_name(path: &str) -> String {
    path.split(" / ").last().unwrap_or(path).to_string()
}

fn ancestor_group_paths(path: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = Vec::new();
    for part in path.split(" / ") {
        current.push(part);
        out.push(current.join(" / "));
    }
    out
}

fn path_contains(parent: &str, child: &str) -> bool {
    child == parent || child.starts_with(&format!("{parent} / "))
}

fn replace_group_prefix(path: Option<&str>, old_path: &str, new_path: &str) -> Option<String> {
    let current = normalize_group_path(path)?;
    if current == old_path {
        Some(new_path.to_string())
    } else {
        current
            .strip_prefix(&format!("{old_path} / "))
            .map(|rest| format!("{new_path} / {rest}"))
    }
}

fn group_for_path(path: &str) -> SessionGroup {
    SessionGroup {
        id: path.to_string(),
        name: leaf_group_name(path),
        parent_id: parent_group_path(path),
        sort_order: 0,
        icon: None,
    }
}

fn ensure_group_path(db: &rusqlite::Connection, path: Option<&str>) -> Result<(), String> {
    let Some(path) = normalize_group_path(path) else {
        return Ok(());
    };
    for ancestor in ancestor_group_paths(&path) {
        crate::session::db::save_group(db, &group_for_path(&ancestor))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn validate_secret_free_options(value: &Value) -> Result<(), String> {
    fn walk(value: &Value, key_hint: Option<&str>) -> Result<(), String> {
        match value {
            Value::Object(map) => {
                for (k, v) in map {
                    walk(v, Some(k))?;
                }
            }
            Value::Array(items) => {
                for item in items {
                    walk(item, key_hint)?;
                }
            }
            Value::String(s) => {
                let key = key_hint.unwrap_or("");
                if is_secretish_key(key) && !s.is_empty() && !s.starts_with("vault:") {
                    return Err(format!(
                        "plaintext secret rejected in options key '{}'; use a vault:<id> reference",
                        key_hint.unwrap_or("<unknown>")
                    ));
                }
            }
            _ => {}
        }
        Ok(())
    }
    walk(value, None)
}

fn is_secretish_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    key.contains("password") || key.contains("passphrase") || key == "pass"
}

fn is_quick_connect_local_alias(alias: &str) -> bool {
    matches!(
        alias.to_ascii_lowercase().as_str(),
        "shell" | "local" | "bash" | "sh"
    )
}

fn quick_connect_target(input: &str) -> Option<(&str, bool)> {
    let raw = input.trim();
    if raw.is_empty() {
        return None;
    }

    if let Some((scheme, _)) = raw.split_once("://") {
        if scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
        {
            return Some((raw, is_quick_connect_local_alias(scheme)));
        }
    }

    let mut parts = raw.splitn(2, char::is_whitespace);
    let first = parts.next().unwrap_or_default();
    let rest = parts.next().map(str::trim).unwrap_or("");
    if matches!(
        first.to_ascii_lowercase().as_str(),
        "ssh"
            | "sftp"
            | "ftp"
            | "telnet"
            | "rdp"
            | "vnc"
            | "serial"
            | "shell"
            | "local"
            | "bash"
            | "sh"
    ) {
        return Some((rest, is_quick_connect_local_alias(first)));
    }

    Some((raw, false))
}

fn validate_quick_connect_secret_free(input: &str) -> Result<(), String> {
    let Some((target, is_local)) = quick_connect_target(input) else {
        return Ok(());
    };
    if is_local {
        return Ok(());
    }

    if let Ok(url) = url::Url::parse(target) {
        if url.password().is_some() {
            return Err("quick_connect URLs must not include plaintext passwords".into());
        }
        for (key, value) in url.query_pairs() {
            if is_secretish_key(&key) && !value.is_empty() && !value.starts_with("vault:") {
                return Err(format!(
                    "quick_connect query parameter '{}' looks like a plaintext secret; open the session editor or use the vault UI",
                    key
                ));
            }
        }
    }

    if let Some((userinfo, _host)) = target.rsplit_once('@') {
        let userinfo = userinfo
            .rsplit_once("://")
            .map(|(_, after_scheme)| after_scheme)
            .unwrap_or(userinfo);
        if userinfo.contains(':') {
            return Err(
                "quick_connect userinfo must not include plaintext passwords; use user@host only"
                    .into(),
            );
        }
    }

    Ok(())
}

fn redact_secret_options(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut out = Map::new();
            for (k, v) in map {
                if is_secretish_key(k) {
                    out.insert(k.clone(), Value::String("<redacted>".into()));
                } else {
                    out.insert(k.clone(), redact_secret_options(v));
                }
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(redact_secret_options).collect()),
        _ => value.clone(),
    }
}

fn parse_options(value: Option<Value>) -> Result<Map<String, Value>, String> {
    let Some(value) = value else {
        return Ok(Map::new());
    };
    validate_secret_free_options(&value)?;
    match value {
        Value::Object(map) => Ok(map),
        _ => Err("options must be a JSON object".into()),
    }
}

fn merge_options_json(existing: &str, patch: Option<Value>) -> Result<String, String> {
    let mut base =
        match serde_json::from_str::<Value>(existing).unwrap_or(Value::Object(Map::new())) {
            Value::Object(map) => map,
            _ => Map::new(),
        };
    for (k, v) in parse_options(patch)? {
        base.insert(k, v);
    }
    Ok(Value::Object(base).to_string())
}

fn apply_auth(
    auth: Option<&SessionAuthParams>,
    options: &mut Map<String, Value>,
    current: Option<AuthMethod>,
) -> Result<AuthMethod, String> {
    let Some(auth) = auth else {
        return Ok(current.unwrap_or(AuthMethod::None));
    };
    match auth.method.trim().to_ascii_lowercase().as_str() {
        "none" => {
            options.remove("passwordRef");
            Ok(AuthMethod::None)
        }
        "agent" => {
            options.remove("passwordRef");
            Ok(AuthMethod::Agent)
        }
        "private_key" | "privatekey" => {
            options.remove("passwordRef");
            let path = auth
                .private_key_path
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or("private_key auth requires private_key_path")?;
            Ok(AuthMethod::PrivateKey {
                key_path: path.to_string(),
            })
        }
        "password_ref" | "passwordref" => {
            let reference = auth
                .password_ref
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or("password_ref auth requires password_ref")?;
            if !reference.starts_with("vault:") {
                return Err("password_ref must be a vault:<id> reference".into());
            }
            options.insert("passwordRef".into(), Value::String(reference.to_string()));
            Ok(AuthMethod::Password)
        }
        "password" => Err("plaintext Password auth is not accepted; use password_ref".into()),
        other => Err(format!("unknown auth method '{other}'")),
    }
}

fn session_to_safe_value(session: &SessionConfig) -> Value {
    let raw_options = serde_json::from_str::<Value>(&session.options_json).unwrap_or(Value::Null);
    serde_json::json!({
        "id": session.id,
        "name": session.name,
        "session_type": session.session_type.as_str(),
        "group_path": session.group_path,
        "host": session.host,
        "port": session.port,
        "username": session.username,
        "auth_method": session.auth_method.as_str(),
        "options": redact_secret_options(&raw_options),
        "created_at": session.created_at,
        "updated_at": session.updated_at,
        "last_connected_at": session.last_connected_at,
        "sort_order": session.sort_order,
    })
}

fn resolve_session_query(
    sessions: &[SessionConfig],
    p: &SessionOpenParams,
) -> Result<String, String> {
    if let Some(id) = p
        .session_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return Ok(id.to_string());
    }
    let q = p
        .query
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or("session_open requires session_id or query")?
        .to_lowercase();
    let matches: Vec<&SessionConfig> = sessions
        .iter()
        .filter(|s| {
            s.id.to_lowercase() == q
                || s.name.to_lowercase().contains(&q)
                || s.host.to_lowercase().contains(&q)
        })
        .collect();
    match matches.as_slice() {
        [one] => Ok(one.id.clone()),
        [] => Err(format!("no session matched '{q}'")),
        many => Err(format!(
            "query '{q}' matched multiple sessions: {}",
            many.iter()
                .map(|s| format!("{} ({})", s.name, s.id))
                .collect::<Vec<_>>()
                .join(", ")
        )),
    }
}

#[tool_router]
impl ControlHandler {
    #[tool(
        name = "session_list",
        description = "列出 Taomni 已保存 session，可按名称/主机/类型/分组过滤。"
    )]
    async fn session_list(
        &self,
        Parameters(p): Parameters<SessionListParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.scope(&ctx)?;
        let state = self.app_state();
        let db = state
            .db
            .lock()
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        let sessions = crate::session::db::list_sessions(&db, None)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        let query = p.query.unwrap_or_default().to_lowercase();
        let session_type = p.session_type.map(|s| s.to_lowercase());
        let group_path = normalize_group_path(p.group_path.as_deref());
        let values: Vec<Value> = sessions
            .iter()
            .filter(|s| {
                (query.is_empty()
                    || s.name.to_lowercase().contains(&query)
                    || s.host.to_lowercase().contains(&query)
                    || s.id.to_lowercase().contains(&query))
                    && session_type
                        .as_deref()
                        .map(|t| s.session_type.as_str().to_lowercase() == t)
                        .unwrap_or(true)
                    && group_path
                        .as_deref()
                        .map(|g| {
                            normalize_group_path(s.group_path.as_deref()).as_deref() == Some(g)
                        })
                        .unwrap_or(true)
            })
            .map(session_to_safe_value)
            .collect();
        json_text(&values)
    }

    #[tool(
        name = "session_get",
        description = "读取一个已保存 session 的配置摘要（secret 字段会被隐藏）。"
    )]
    async fn session_get(
        &self,
        Parameters(p): Parameters<SessionIdParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.scope(&ctx)?;
        let state = self.app_state();
        let db = state
            .db
            .lock()
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        let session = crate::session::db::get_session(&db, &p.session_id)
            .map_err(|e| ErrorData::invalid_params(e.to_string(), None))?;
        json_text(&session_to_safe_value(&session))
    }

    #[tool(
        name = "session_create",
        description = "新建 Taomni session。禁止传明文密码；密码只能用 auth.method=password_ref + vault:<id>。"
    )]
    async fn session_create(
        &self,
        Parameters(p): Parameters<SessionCreateParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let args = serde_json::to_value(&p).unwrap_or(Value::Null);
        self.require_write(&scope, "session_create", &args).await?;
        let session_type =
            parse_session_type(&p.session_type).map_err(|e| ErrorData::invalid_params(e, None))?;
        let mut options =
            parse_options(p.options).map_err(|e| ErrorData::invalid_params(e, None))?;
        let auth = apply_auth(p.auth.as_ref(), &mut options, None)
            .map_err(|e| ErrorData::invalid_params(e, None))?;
        let now = now_seconds();
        let group_path = normalize_group_path(p.group_path.as_deref());
        let session = SessionConfig {
            id: p.id.unwrap_or_else(|| Uuid::new_v4().to_string()),
            name: p.name,
            session_type: session_type.clone(),
            group_path,
            host: p.host.unwrap_or_default(),
            port: p.port.unwrap_or_else(|| session_type.default_port()),
            username: p.username,
            auth_method: auth,
            options_json: Value::Object(options).to_string(),
            created_at: now,
            updated_at: now,
            last_connected_at: None,
            sort_order: 0,
        };
        {
            let state = self.app_state();
            let db = state
                .db
                .lock()
                .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
            ensure_group_path(&db, session.group_path.as_deref())
                .map_err(|e| ErrorData::internal_error(e, None))?;
            crate::session::db::save_session(&db, &session)
                .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        }
        self.emit_sessions_changed();
        json_text(&session_to_safe_value(&session))
    }

    #[tool(
        name = "session_update",
        description = "更新已保存 session。禁止写入明文密码；使用 password_ref/vault。"
    )]
    async fn session_update(
        &self,
        Parameters(p): Parameters<SessionUpdateParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let args = serde_json::to_value(&p).unwrap_or(Value::Null);
        self.require_write(&scope, "session_update", &args).await?;
        let state = self.app_state();
        let db = state
            .db
            .lock()
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        let mut session = crate::session::db::get_session(&db, &p.session_id)
            .map_err(|e| ErrorData::invalid_params(e.to_string(), None))?;
        if let Some(v) = p.name {
            session.name = v;
        }
        if let Some(v) = p.session_type {
            session.session_type =
                parse_session_type(&v).map_err(|e| ErrorData::invalid_params(e, None))?;
        }
        if p.group_path.is_some() {
            session.group_path = normalize_group_path(p.group_path.as_deref());
        }
        if let Some(v) = p.host {
            session.host = v;
        }
        if let Some(v) = p.port {
            session.port = v;
        }
        if p.username.is_some() {
            session.username = p.username;
        }
        let mut options = match serde_json::from_str::<Value>(&session.options_json)
            .unwrap_or(Value::Object(Map::new()))
        {
            Value::Object(map) => map,
            _ => Map::new(),
        };
        session.auth_method = apply_auth(p.auth.as_ref(), &mut options, Some(session.auth_method))
            .map_err(|e| ErrorData::invalid_params(e, None))?;
        session.options_json = merge_options_json(&Value::Object(options).to_string(), p.options)
            .map_err(|e| ErrorData::invalid_params(e, None))?;
        session.updated_at = now_seconds();
        ensure_group_path(&db, session.group_path.as_deref())
            .map_err(|e| ErrorData::internal_error(e, None))?;
        crate::session::db::save_session(&db, &session)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        drop(db);
        self.emit_sessions_changed();
        json_text(&session_to_safe_value(&session))
    }

    #[tool(
        name = "session_duplicate",
        description = "复制一个已保存 session，生成新 id。"
    )]
    async fn session_duplicate(
        &self,
        Parameters(p): Parameters<SessionDuplicateParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let args = serde_json::to_value(&p).unwrap_or(Value::Null);
        self.require_write(&scope, "session_duplicate", &args)
            .await?;
        let state = self.app_state();
        let db = state
            .db
            .lock()
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        let source = crate::session::db::get_session(&db, &p.session_id)
            .map_err(|e| ErrorData::invalid_params(e.to_string(), None))?;
        let now = now_seconds();
        let copy = SessionConfig {
            id: Uuid::new_v4().to_string(),
            name: p.name.unwrap_or_else(|| format!("{} (copy)", source.name)),
            created_at: now,
            updated_at: now,
            last_connected_at: None,
            ..source
        };
        crate::session::db::save_session(&db, &copy)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        drop(db);
        self.emit_sessions_changed();
        json_text(&session_to_safe_value(&copy))
    }

    #[tool(
        name = "session_delete",
        description = "删除一个已保存 session（不会自动关闭已打开 tab）。"
    )]
    async fn session_delete(
        &self,
        Parameters(p): Parameters<SessionIdParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let args = serde_json::to_value(&p).unwrap_or(Value::Null);
        self.require_write(&scope, "session_delete", &args).await?;
        let state = self.app_state();
        let db = state
            .db
            .lock()
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        crate::session::db::delete_session(&db, &p.session_id)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        drop(db);
        self.emit_sessions_changed();
        Ok(text(format!("deleted session {}", p.session_id)))
    }

    #[tool(
        name = "session_move_group",
        description = "移动 session 到指定分组；group_path 为空表示移出分组。"
    )]
    async fn session_move_group(
        &self,
        Parameters(p): Parameters<SessionMoveGroupParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let args = serde_json::to_value(&p).unwrap_or(Value::Null);
        self.require_write(&scope, "session_move_group", &args)
            .await?;
        let group_path = normalize_group_path(p.group_path.as_deref());
        let state = self.app_state();
        let db = state
            .db
            .lock()
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        let mut session = crate::session::db::get_session(&db, &p.session_id)
            .map_err(|e| ErrorData::invalid_params(e.to_string(), None))?;
        ensure_group_path(&db, group_path.as_deref())
            .map_err(|e| ErrorData::internal_error(e, None))?;
        session.group_path = group_path;
        session.updated_at = now_seconds();
        crate::session::db::save_session(&db, &session)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        drop(db);
        self.emit_sessions_changed();
        json_text(&session_to_safe_value(&session))
    }

    #[tool(name = "group_list", description = "列出 session 分组。")]
    async fn group_list(
        &self,
        Parameters(_p): Parameters<EmptyParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.scope(&ctx)?;
        let state = self.app_state();
        let db = state
            .db
            .lock()
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        let groups = crate::session::db::list_groups(&db)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        json_text(&groups)
    }

    #[tool(
        name = "group_create",
        description = "创建 session 分组路径，会自动创建祖先分组。"
    )]
    async fn group_create(
        &self,
        Parameters(p): Parameters<GroupPathParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let args = serde_json::to_value(&p).unwrap_or(Value::Null);
        self.require_write(&scope, "group_create", &args).await?;
        let path = normalize_group_path(Some(&p.path))
            .ok_or_else(|| ErrorData::invalid_params("path is required", None))?;
        let state = self.app_state();
        let db = state
            .db
            .lock()
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        ensure_group_path(&db, Some(&path)).map_err(|e| ErrorData::internal_error(e, None))?;
        drop(db);
        self.emit_sessions_changed();
        Ok(text(format!("created group {path}")))
    }

    #[tool(
        name = "group_rename",
        description = "重命名 session 分组路径，并更新子分组和组内 session。"
    )]
    async fn group_rename(
        &self,
        Parameters(p): Parameters<GroupRenameParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let args = serde_json::to_value(&p).unwrap_or(Value::Null);
        self.require_write(&scope, "group_rename", &args).await?;
        let old_path = normalize_group_path(Some(&p.old_path))
            .ok_or_else(|| ErrorData::invalid_params("old_path is required", None))?;
        let new_path = normalize_group_path(Some(&p.new_path))
            .ok_or_else(|| ErrorData::invalid_params("new_path is required", None))?;
        let state = self.app_state();
        let db = state
            .db
            .lock()
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        ensure_group_path(&db, Some(&new_path)).map_err(|e| ErrorData::internal_error(e, None))?;
        let groups = crate::session::db::list_groups(&db)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        for group in groups
            .iter()
            .filter(|g| path_contains(&old_path, &g.id))
            .collect::<Vec<_>>()
        {
            crate::session::db::delete_group(&db, &group.id)
                .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        }
        for group in groups.iter().filter(|g| path_contains(&old_path, &g.id)) {
            let replaced = replace_group_prefix(Some(&group.id), &old_path, &new_path)
                .unwrap_or_else(|| new_path.clone());
            let mut next = group_for_path(&replaced);
            next.sort_order = group.sort_order;
            next.icon = group.icon.clone();
            crate::session::db::save_group(&db, &next)
                .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        }
        let sessions = crate::session::db::list_sessions(&db, None)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        for mut session in sessions {
            if let Some(replaced) =
                replace_group_prefix(session.group_path.as_deref(), &old_path, &new_path)
            {
                session.group_path = Some(replaced);
                session.updated_at = now_seconds();
                crate::session::db::save_session(&db, &session)
                    .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
            }
        }
        drop(db);
        self.emit_sessions_changed();
        Ok(text(format!("renamed group {old_path} to {new_path}")))
    }

    #[tool(
        name = "group_delete",
        description = "删除分组。默认不删 session，而是把受影响 session 移出分组；delete_sessions=true 才删除 session。"
    )]
    async fn group_delete(
        &self,
        Parameters(p): Parameters<GroupDeleteParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let args = serde_json::to_value(&p).unwrap_or(Value::Null);
        self.require_write(&scope, "group_delete", &args).await?;
        let path = normalize_group_path(Some(&p.path))
            .ok_or_else(|| ErrorData::invalid_params("path is required", None))?;
        let state = self.app_state();
        let db = state
            .db
            .lock()
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        let groups = crate::session::db::list_groups(&db)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        let sessions = crate::session::db::list_sessions(&db, None)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        let mut affected_session_ids = Vec::new();
        for mut session in sessions {
            if normalize_group_path(session.group_path.as_deref())
                .as_deref()
                .map(|g| path_contains(&path, g))
                .unwrap_or(false)
            {
                affected_session_ids.push(session.id.clone());
                if p.delete_sessions {
                    crate::session::db::delete_session(&db, &session.id)
                        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
                } else {
                    session.group_path = None;
                    session.updated_at = now_seconds();
                    crate::session::db::save_session(&db, &session)
                        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
                }
            }
        }
        for group in groups.iter().filter(|g| path_contains(&path, &g.id)) {
            crate::session::db::delete_group(&db, &group.id)
                .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        }
        drop(db);
        self.emit_sessions_changed();
        json_text(&serde_json::json!({
            "deleted_group": path,
            "delete_sessions": p.delete_sessions,
            "affected_session_ids": affected_session_ids,
        }))
    }

    #[tool(
        name = "session_open",
        description = "在 Taomni UI 中打开一个已保存 session。支持 session_id 或唯一 query。"
    )]
    async fn session_open(
        &self,
        Parameters(mut p): Parameters<SessionOpenParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let id = {
            let state = self.app_state();
            let db = state
                .db
                .lock()
                .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
            let sessions = crate::session::db::list_sessions(&db, None)
                .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
            resolve_session_query(&sessions, &p).map_err(|e| ErrorData::invalid_params(e, None))?
        };
        p.session_id = Some(id);
        let args = serde_json::to_value(&p).unwrap_or(Value::Null);
        self.require_write(&scope, "session_open", &args).await?;
        self.dispatch_control_side_effect(&scope, "session_open", args)
            .await
    }

    #[tool(
        name = "session_open_editor",
        description = "打开新建/编辑 session 对话框。可传 session_id 编辑；或传 session_type/group_path 新建。"
    )]
    async fn session_open_editor(
        &self,
        Parameters(p): Parameters<SessionOpenEditorParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let args = serde_json::to_value(&p).unwrap_or(Value::Null);
        self.require_write(&scope, "session_open_editor", &args)
            .await?;
        self.dispatch_control_side_effect(&scope, "session_open_editor", args)
            .await
    }

    #[tool(
        name = "quick_connect",
        description = "使用 Taomni Quick Connect 语法打开临时连接。"
    )]
    async fn quick_connect(
        &self,
        Parameters(p): Parameters<QuickConnectParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        validate_quick_connect_secret_free(&p.input)
            .map_err(|e| ErrorData::invalid_params(e, None))?;
        let args = serde_json::to_value(&p).unwrap_or(Value::Null);
        self.require_write(&scope, "quick_connect", &args).await?;
        self.dispatch_control_side_effect(&scope, "quick_connect", args)
            .await
    }

    #[tool(name = "tab_list", description = "列出当前打开的 Taomni tabs。")]
    async fn tab_list(
        &self,
        Parameters(p): Parameters<EmptyParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        self.dispatch_control_side_effect(&scope, "tab_list", serde_json::to_value(&p).unwrap())
            .await
    }

    #[tool(name = "tab_switch", description = "切换到指定 tab。")]
    async fn tab_switch(
        &self,
        Parameters(p): Parameters<TabIdParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        self.dispatch_control_side_effect(&scope, "tab_switch", serde_json::to_value(&p).unwrap())
            .await
    }

    #[tool(name = "tab_duplicate", description = "复制指定 tab，并激活副本。")]
    async fn tab_duplicate(
        &self,
        Parameters(p): Parameters<TabIdParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let args = serde_json::to_value(&p).unwrap_or(Value::Null);
        self.require_write(&scope, "tab_duplicate", &args).await?;
        self.dispatch_control_side_effect(&scope, "tab_duplicate", args)
            .await
    }

    #[tool(name = "tab_rename", description = "重命名指定 tab。")]
    async fn tab_rename(
        &self,
        Parameters(p): Parameters<TabRenameParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let args = serde_json::to_value(&p).unwrap_or(Value::Null);
        self.require_write(&scope, "tab_rename", &args).await?;
        self.dispatch_control_side_effect(&scope, "tab_rename", args)
            .await
    }

    #[tool(name = "tab_close", description = "关闭指定 tab。")]
    async fn tab_close(
        &self,
        Parameters(p): Parameters<TabIdParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let args = serde_json::to_value(&p).unwrap_or(Value::Null);
        self.require_write(&scope, "tab_close", &args).await?;
        self.dispatch_control_side_effect(&scope, "tab_close", args)
            .await
    }

    #[tool(name = "tab_move", description = "移动 tab 到指定索引。")]
    async fn tab_move(
        &self,
        Parameters(p): Parameters<TabMoveParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let args = serde_json::to_value(&p).unwrap_or(Value::Null);
        self.require_write(&scope, "tab_move", &args).await?;
        self.dispatch_control_side_effect(&scope, "tab_move", args)
            .await
    }

    #[tool(name = "tab_open_settings", description = "打开或切换到设置 tab。")]
    async fn tab_open_settings(
        &self,
        Parameters(p): Parameters<EmptyParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        self.dispatch_control_side_effect(
            &scope,
            "tab_open_settings",
            serde_json::to_value(&p).unwrap(),
        )
        .await
    }

    #[tool(name = "tab_open_local_terminal", description = "打开本地终端 tab。")]
    async fn tab_open_local_terminal(
        &self,
        Parameters(p): Parameters<OpenLocalTerminalParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let args = serde_json::to_value(&p).unwrap_or(Value::Null);
        self.require_write(&scope, "tab_open_local_terminal", &args)
            .await?;
        self.dispatch_control_side_effect(&scope, "tab_open_local_terminal", args)
            .await
    }

    #[tool(
        name = "tab_open_file_browser",
        description = "打开本地文件浏览器 tab。"
    )]
    async fn tab_open_file_browser(
        &self,
        Parameters(p): Parameters<OpenFileBrowserParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let args = serde_json::to_value(&p).unwrap_or(Value::Null);
        self.require_write(&scope, "tab_open_file_browser", &args)
            .await?;
        self.dispatch_control_side_effect(&scope, "tab_open_file_browser", args)
            .await
    }

    #[tool(
        name = "permission_prompt",
        description = "Approve or deny a Taomni control tool call per Taomni's safety rules + human confirmation."
    )]
    async fn permission_prompt(
        &self,
        Parameters(p): Parameters<PermissionParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let scope = self.scope(&ctx)?;
        let tool = normalize_tool_name(&p.tool_name);
        let readonly = matches!(
            tool,
            "session_list" | "session_get" | "group_list" | "tab_list"
        );
        Ok(decide_permission(&self.app, &scope, &p.tool_name, &p.tool_input, readonly).await)
    }
}

#[tool_handler]
impl ServerHandler for ControlHandler {
    fn get_info(&self) -> ServerInfo {
        let mut info = ServerInfo::default();
        info.capabilities = ServerCapabilities::builder().enable_tools().build();
        info.instructions = Some(
            "Taomni control-plane tools for sessions, groups, tabs, and UI commands. Plaintext passwords are rejected; use vault references or the session editor."
                .into(),
        );
        info
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn plaintext_password_option_is_rejected() {
        let err = validate_secret_free_options(&json!({"password": "secret"})).unwrap_err();
        assert!(err.contains("plaintext secret rejected"));
        assert!(validate_secret_free_options(&json!({"passwordRef": "vault:abc"})).is_ok());
    }

    #[test]
    fn group_paths_normalize_to_ui_format() {
        assert_eq!(
            normalize_group_path(Some("Prod / DB/Primary")).as_deref(),
            Some("Prod / DB / Primary")
        );
        assert_eq!(parent_group_path("Prod / DB"), Some("Prod".into()));
    }

    #[test]
    fn password_auth_requires_vault_ref() {
        let mut options = Map::new();
        let auth = SessionAuthParams {
            method: "password_ref".into(),
            private_key_path: None,
            password_ref: Some("vault:one".into()),
        };
        assert!(matches!(
            apply_auth(Some(&auth), &mut options, None).unwrap(),
            AuthMethod::Password
        ));
        assert_eq!(options["passwordRef"], "vault:one");

        let bad = SessionAuthParams {
            method: "password".into(),
            private_key_path: None,
            password_ref: Some("secret".into()),
        };
        assert!(apply_auth(Some(&bad), &mut options, None).is_err());
    }

    #[test]
    fn quick_connect_rejects_plaintext_passwords() {
        assert!(validate_quick_connect_secret_free("ssh://root:secret@example.com").is_err());
        assert!(validate_quick_connect_secret_free("ssh root:secret@example.com").is_err());
        assert!(validate_quick_connect_secret_free("ssh://root@example.com").is_ok());
        assert!(validate_quick_connect_secret_free("ssh root@example.com:22").is_ok());
    }
}
