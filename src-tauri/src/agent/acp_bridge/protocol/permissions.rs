use super::display::truncate_display_text;
use super::wire::AcpProtocolError;
use super::wire::AcpRequestId;
use super::wire::JSON_RPC_VERSION;
use serde::Serialize;
use serde_json::Value;
use serde_json::json;

/// A permission option whose opaque id is returned to the ACP agent only
/// after the user explicitly selects it. The request parser keeps just the
/// display-safe fields needed by the confirmation UI; `rawInput` and other
/// tool metadata are deliberately discarded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpPermissionOption {
    pub option_id: String,
    pub name: String,
    pub kind: AcpPermissionOptionKind,
}

/// ACP v1 permission choices supported by Taomni's human confirmation gate.
/// Unknown choices are rejected rather than presented with ambiguous safety
/// semantics.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AcpPermissionOptionKind {
    AllowOnce,
    AllowAlways,
    RejectOnce,
    RejectAlways,
}

/// The safe subset of an agent-originated `session/request_permission` call.
/// Session and tool-call ids stay inside the runtime; the UI receives only the
/// title, kind, and explicitly offered choices.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcpPermissionRequest {
    pub session_id: String,
    pub tool_call_id: String,
    pub title: String,
    pub kind: String,
    pub options: Vec<AcpPermissionOption>,
    /// When true, the tool targets Taomni's scoped MCP surface, which already
    /// owns the human-in-the-loop ActionCard for side effects. The ACP runtime
    /// auto-selects an allow option so the user is not asked twice.
    pub deferred_to_mcp: bool,
}

/// Parse a standard ACP `session/request_permission` request without
/// retaining raw tool arguments. The agent's option ids are opaque, so they
/// are kept exactly as sent and validated again before resolving the request.
pub fn parse_permission_request(params: &Value) -> Result<AcpPermissionRequest, AcpProtocolError> {
    let params = params
        .as_object()
        .ok_or(AcpProtocolError::InvalidPermissionRequest(
            "params are not an object",
        ))?;
    let session_id = permission_identifier(params.get("sessionId"), "sessionId")?;
    let tool_call = params.get("toolCall").and_then(Value::as_object).ok_or(
        AcpProtocolError::InvalidPermissionRequest("toolCall is missing"),
    )?;
    let tool_call_id = permission_identifier(tool_call.get("toolCallId"), "toolCallId")?;
    let title = tool_call
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .map(|title| truncate_display_text(title, 240))
        .unwrap_or_else(|| "Tool action".into());
    let kind = tool_call
        .get("kind")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|kind| !kind.is_empty())
        .map(|kind| truncate_display_text(kind, 80))
        .unwrap_or_else(|| "tool".into());
    let options = params
        .get("options")
        .and_then(Value::as_array)
        .filter(|options| !options.is_empty())
        .ok_or(AcpProtocolError::InvalidPermissionRequest(
            "options are missing",
        ))?
        .iter()
        .map(parse_permission_option)
        .collect::<Result<Vec<_>, _>>()?;

    if options.len() > 8 {
        return Err(AcpProtocolError::InvalidPermissionRequest(
            "too many options",
        ));
    }
    let mut seen = std::collections::HashSet::new();
    if options
        .iter()
        .any(|option| !seen.insert(option.option_id.as_str()))
    {
        return Err(AcpProtocolError::InvalidPermissionRequest(
            "option ids are not unique",
        ));
    }

    let deferred_to_mcp = tool_call_targets_taomni_mcp(tool_call);

    Ok(AcpPermissionRequest {
        session_id,
        tool_call_id,
        title,
        kind,
        options,
        deferred_to_mcp,
    })
}

/// Detect whether a permission request is for a Taomni-scoped MCP tool.
///
/// Grok (and other ACP agents) prompt via `session/request_permission` before
/// every non-auto-approved tool. Taomni MCP write tools then run the audited
/// ActionCard pipeline again. Identifying our MCP surface lets the runtime
/// skip the first card so the user only confirms once.
///
/// Only stable tool-name identifiers are inspected — never free-form argument
/// values — so secrets in `rawInput` never leave this check.
pub fn tool_call_targets_taomni_mcp(tool_call: &serde_json::Map<String, Value>) -> bool {
    for candidate in permission_tool_name_candidates(tool_call) {
        if is_taomni_mcp_tool_name(&candidate) {
            return true;
        }
    }
    false
}

/// Return true for fully-qualified Taomni MCP tool names in either Grok's
/// `server__tool` form or Claude's `mcp__server__tool` form, plus a small set
/// of bare tool names that only exist on Taomni's MCP surface (so a dispatcher
/// that drops the server prefix still defers correctly).
pub fn is_taomni_mcp_tool_name(name: &str) -> bool {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 256 {
        return false;
    }
    let lower = name.to_ascii_lowercase();
    if lower.starts_with("taomni__")
        || lower.starts_with("taomni_sql__")
        || lower.starts_with("taomni_redis__")
        || lower.starts_with("taomni_control__")
        || lower.starts_with("mcp__taomni__")
        || lower.starts_with("mcp__taomni_sql__")
        || lower.starts_with("mcp__taomni_redis__")
        || lower.starts_with("mcp__taomni_control__")
    {
        return true;
    }
    // Bare names that do not collide with Grok-native tools
    // (`run_terminal_command`, `search_replace`, …). Keep this list narrow.
    matches!(
        lower.as_str(),
        "run_in_terminal"
            | "run_captured"
            | "read_capture"
            | "read_terminal_tail"
            | "sftp_upload"
            | "sftp_download"
            | "save_as_runbook"
            | "open_session_editor"
            | "switch_tab"
            | "run_sql"
            | "run_sql_captured"
            | "export_result"
            | "redis_set_key"
            | "redis_del_key"
            | "redis_exec"
            | "session_open"
            | "session_create"
            | "session_update"
            | "session_delete"
            | "tab_switch"
            | "tab_close"
            | "quick_connect"
    )
}

pub(super) fn permission_tool_name_candidates(
    tool_call: &serde_json::Map<String, Value>,
) -> Vec<String> {
    let mut out = Vec::new();
    let push = |out: &mut Vec<String>, value: Option<&str>| {
        if let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) {
            if !out.iter().any(|existing| existing == value) {
                out.push(value.to_string());
            }
        }
    };

    push(&mut out, tool_call.get("title").and_then(Value::as_str));
    for key in ["name", "toolName", "tool_name", "serverToolName"] {
        push(&mut out, tool_call.get(key).and_then(Value::as_str));
    }
    if let Some(meta_name) = tool_call
        .get("_meta")
        .and_then(|meta| meta.pointer("/x.ai/tool/name"))
        .and_then(Value::as_str)
    {
        push(&mut out, Some(meta_name));
    }

    // Dispatcher wrappers (use_tool / CallMcpTool) may nest the real name.
    // Only read known identifier keys — never arbitrary argument values.
    if let Some(raw) = tool_call.get("rawInput").and_then(Value::as_object) {
        for key in [
            "name",
            "tool",
            "toolName",
            "tool_name",
            "serverToolName",
            "qualifiedName",
            "qualified_name",
        ] {
            push(&mut out, raw.get(key).and_then(Value::as_str));
        }
        if let (Some(server), Some(tool)) = (
            raw.get("server")
                .or_else(|| raw.get("serverName"))
                .or_else(|| raw.get("server_name"))
                .and_then(Value::as_str),
            raw.get("tool")
                .or_else(|| raw.get("toolName"))
                .or_else(|| raw.get("tool_name"))
                .and_then(Value::as_str),
        ) {
            let server = server.trim();
            let tool = tool.trim();
            if !server.is_empty() && !tool.is_empty() {
                push(&mut out, Some(&format!("{server}__{tool}")));
                push(&mut out, Some(&format!("mcp__{server}__{tool}")));
            }
        }
    }

    out
}

/// Build the ACP success response for a human-selected permission option.
pub fn permission_selected_response(id: AcpRequestId, option_id: &str) -> Value {
    json!({
        "jsonrpc": JSON_RPC_VERSION,
        "id": id,
        "result": {
            "outcome": {
                "outcome": "selected",
                "optionId": option_id,
            },
        },
    })
}

/// Build the ACP success response for a cancelled or expired confirmation.
pub fn permission_cancelled_response(id: AcpRequestId) -> Value {
    json!({
        "jsonrpc": JSON_RPC_VERSION,
        "id": id,
        "result": { "outcome": { "outcome": "cancelled" } },
    })
}

pub(super) fn parse_permission_option(
    value: &Value,
) -> Result<AcpPermissionOption, AcpProtocolError> {
    let option = value
        .as_object()
        .ok_or(AcpProtocolError::InvalidPermissionRequest(
            "option is not an object",
        ))?;
    let option_id = permission_identifier(option.get("optionId"), "optionId")?;
    let name = option
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(|name| truncate_display_text(name, 160))
        .ok_or(AcpProtocolError::InvalidPermissionRequest(
            "option name is missing",
        ))?;
    let kind = match option.get("kind").and_then(Value::as_str) {
        Some("allow_once") => AcpPermissionOptionKind::AllowOnce,
        Some("allow_always") => AcpPermissionOptionKind::AllowAlways,
        Some("reject_once") => AcpPermissionOptionKind::RejectOnce,
        Some("reject_always") => AcpPermissionOptionKind::RejectAlways,
        _ => {
            return Err(AcpProtocolError::InvalidPermissionRequest(
                "option kind is unsupported",
            ));
        }
    };
    Ok(AcpPermissionOption {
        option_id,
        name,
        kind,
    })
}

pub(super) fn permission_identifier(
    value: Option<&Value>,
    field: &'static str,
) -> Result<String, AcpProtocolError> {
    let value = value
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.chars().count() <= 256)
        .ok_or(AcpProtocolError::InvalidPermissionRequest(field))?;
    Ok(value.to_string())
}
