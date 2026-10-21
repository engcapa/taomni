use super::model::TokenMap;
use super::model::TokenScope;
use crate::state::AppState;
use rmcp::ErrorData;
use rmcp::service::RequestContext;
use rmcp::service::RoleServer;

/// CC names MCP tools as `mcp__<server>__<tool>` when it asks the
/// `--permission-prompt-tool` for a decision. Strip that prefix so the call is
/// graded against Taomni's bare tool vocabulary (`run_in_terminal`, …) — the
/// same names `is_write_tool` / `check_tool_call` recognize. CC's own built-in
/// tools (`Bash`, `Edit`, …) arrive unprefixed and pass through unchanged.
pub(crate) fn normalize_tool_name(name: &str) -> &str {
    name.strip_prefix("mcp__")
        .and_then(|rest| rest.split_once("__"))
        .map(|(_server, tool)| tool)
        .unwrap_or(name)
}

/// Returns true for tools whose `session_id` argument identifies the current
/// execution target bound to this thread. Taomni control/UI tools use ids for
/// saved session configs or tabs instead, so applying the terminal scope check
/// to them would incorrectly reject valid actions like opening `pi-1` from a
/// local PowerShell chat.
pub(crate) fn tool_uses_bound_session_scope(tool: &str) -> bool {
    !matches!(
        normalize_tool_name(tool),
        // Shared control MCP: saved session config management.
        "session_list"
            | "session_get"
            | "session_create"
            | "session_update"
            | "session_duplicate"
            | "session_delete"
            | "session_move_group"
            // Shared control MCP: groups.
            | "group_list"
            | "group_create"
            | "group_rename"
            | "group_delete"
            // Shared control MCP: UI/session opening.
            | "session_open"
            | "session_open_editor"
            | "quick_connect"
            // Shared control MCP: tabs and app UI.
            | "tab_list"
            | "tab_switch"
            | "tab_duplicate"
            | "tab_rename"
            | "tab_close"
            | "tab_move"
            | "tab_open_settings"
            | "tab_open_local_terminal"
            | "tab_open_file_browser"
            // Legacy shell UI tools kept for compatibility.
            | "switch_tab"
            | "open_session_editor"
    )
}

/// Resolve a caller-named `session_id` against the token's bound terminal. CC
/// may name the bound session either by its terminal *tab id* (the canonical
/// scope id) or by the saved `SessionConfig.id` the identity card advertises;
/// both refer to the one bound terminal. Returns the canonical *tab id* when
/// `sid` is in scope, else `None` (foreign session, or a thread bound to none).
pub(super) fn canonical_bound_id<'a>(scope: &'a TokenScope, sid: &str) -> Option<&'a str> {
    let tab = scope.allowed_session_id.as_deref()?;
    if sid == tab || scope.allowed_config_id.as_deref() == Some(sid) {
        Some(tab)
    } else {
        None
    }
}

/// Enforce that any `session_id` named in a tool call refers to the terminal
/// this token is bound to — by tab id or by the advertised `SessionConfig.id`.
/// Tokens with no bound session may not touch a session at all.
pub(crate) fn enforce_session_scope(
    scope: &TokenScope,
    args: &serde_json::Value,
) -> Result<(), String> {
    if let Some(sid) = args.get("session_id").and_then(|v| v.as_str()) {
        if canonical_bound_id(scope, sid).is_some() {
            Ok(())
        } else {
            Err(format!("session '{sid}' is out of scope for this thread"))
        }
    } else {
        Ok(())
    }
}

/// Resolve the calling token's scope from a request's Bearer header. Shared by
/// every flavor's handler (`scope()` methods delegate here).
pub(crate) fn scope_from_ctx(
    tokens: &TokenMap,
    ctx: &RequestContext<RoleServer>,
) -> Result<TokenScope, ErrorData> {
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
    tokens
        .lock()
        .unwrap()
        .get(token)
        .cloned()
        .ok_or_else(|| ErrorData::invalid_params("unknown token", None))
}

/// Normalize a tool call's `session_id` to the canonical terminal *tab id*.
///
/// - Omitted (the common case — CC doesn't know the thread's bound session):
///   inject the bound tab id so the effect targets the linked terminal and the
///   scope check passes. No-op for a global thread (no bound session).
/// - Present as the advertised `SessionConfig.id`: rewrite it to the tab id, so
///   downstream registry / `state.terminal.terminals` lookups (which key on the tab id)
///   resolve instead of missing. The identity card hands CC the config id, so
///   this is the path CC takes when it "helpfully" names the session.
/// - Present as the tab id already, or as a foreign id: left unchanged (a
///   foreign id is then rejected by `enforce_session_scope`).
pub(super) fn fill_session_id(args: &mut serde_json::Value, scope: &TokenScope) {
    // Own the present value first so the immutable borrow of `args` is released
    // before we may mutate it below.
    let present: Option<String> = args
        .get("session_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let target: Option<String> = match present {
        // Omitted: inject the bound tab id (None for a global thread → no-op).
        None => scope.allowed_session_id.clone(),
        // Present: rewrite an advertised config id to the canonical tab id; a
        // tab id (already canonical) or a foreign id needs no change here (a
        // foreign id is rejected later by `enforce_session_scope`).
        Some(sid) => match canonical_bound_id(scope, &sid) {
            Some(tab) if tab != sid => Some(tab.to_string()),
            _ => None,
        },
    };
    if let (Some(sid), Some(obj)) = (target, args.as_object_mut()) {
        obj.insert("session_id".into(), serde_json::Value::String(sid));
    }
}

/// Resolve a caller-facing session id (a terminal *tab id* — what the token
/// scope and `fill_session_id` use) to the *backend terminal session id* that
/// keys `state.terminal.terminals`. The frontend reports this mapping as terminals
/// connect (`cc_track_terminal`). `run_in_terminal` / `read_terminal_tail`
/// don't need this — they dispatch the tab id to the frontend registry, which
/// owns the indirection — but the backend-side capture tools (`run_captured` /
/// `read_capture`) index `state.terminal.terminals` directly and must translate first.
///
/// Falls back to the id unchanged when no mapping exists, so a caller that
/// already passes a backend session id, or a test/local setup with no tracking,
/// still resolves (a miss then surfaces as the usual "no live terminal").
pub(super) fn resolve_backend_session_id(state: &AppState, sid: &str) -> String {
    state
        .agent
        .cc_tab_sessions
        .lock()
        .ok()
        .and_then(|m| m.get(sid).cloned())
        .unwrap_or_else(|| sid.to_string())
}
