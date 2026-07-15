use crate::agent::local::{LocalAgentEvent, LocalAgentUsage};
use serde::Serialize;
use serde_json::{Value, json};
use std::fmt;

pub const ACP_PROTOCOL_VERSION: u64 = 1;
pub const JSON_RPC_VERSION: &str = "2.0";

pub const METHOD_INITIALIZE: &str = "initialize";
pub const METHOD_AUTHENTICATE: &str = "authenticate";
pub const METHOD_SESSION_NEW: &str = "session/new";
pub const METHOD_SESSION_LOAD: &str = "session/load";
pub const METHOD_SESSION_PROMPT: &str = "session/prompt";
pub const METHOD_SESSION_CANCEL: &str = "session/cancel";
pub const METHOD_SESSION_UPDATE: &str = "session/update";

/// JSON-RPC IDs accepted by ACP. Taomni emits monotonically increasing numeric
/// IDs, but string IDs are parsed too so unexpected peer requests can receive a
/// standards-compliant error response.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(untagged)]
pub enum AcpRequestId {
    Number(u64),
    String(String),
}

impl From<u64> for AcpRequestId {
    fn from(value: u64) -> Self {
        Self::Number(value)
    }
}

impl AcpRequestId {
    fn parse(value: &Value) -> Result<Self, AcpProtocolError> {
        if let Some(id) = value.as_u64() {
            return Ok(Self::Number(id));
        }
        if let Some(id) = value.as_str() {
            return Ok(Self::String(id.to_string()));
        }
        Err(AcpProtocolError::InvalidRequestId)
    }
}

/// A JSON-RPC request sent from Taomni to an ACP agent.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AcpRequest {
    #[serde(rename = "jsonrpc")]
    json_rpc: &'static str,
    pub id: AcpRequestId,
    pub method: String,
    pub params: Value,
}

impl AcpRequest {
    pub fn new(id: impl Into<AcpRequestId>, method: impl Into<String>, params: Value) -> Self {
        Self {
            json_rpc: JSON_RPC_VERSION,
            id: id.into(),
            method: method.into(),
            params,
        }
    }
}

/// A JSON-RPC notification sent from Taomni to an ACP agent.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AcpNotification {
    #[serde(rename = "jsonrpc")]
    json_rpc: &'static str,
    pub method: String,
    pub params: Value,
}

impl AcpNotification {
    pub fn new(method: impl Into<String>, params: Value) -> Self {
        Self {
            json_rpc: JSON_RPC_VERSION,
            method: method.into(),
            params,
        }
    }
}

/// The supported subset of JSON-RPC envelopes received from an ACP agent.
///
/// Agent-to-client requests are retained so the stdio runtime can reject
/// filesystem, terminal, and permission calls explicitly instead of silently
/// dropping them. Taomni does not advertise those capabilities in v1.
#[derive(Debug, Clone, PartialEq)]
pub enum AcpIncomingMessage {
    Response {
        id: AcpRequestId,
        result: Value,
    },
    ErrorResponse {
        id: Option<AcpRequestId>,
        error: AcpRpcError,
    },
    Notification {
        method: String,
        params: Value,
    },
    Request {
        id: AcpRequestId,
        method: String,
        params: Value,
    },
}

/// A sanitized JSON-RPC error. The optional `data` field is intentionally not
/// retained because agents may place credentials or raw configuration there.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcpRpcError {
    pub code: i64,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AcpProtocolError {
    InvalidJson,
    InvalidJsonRpcVersion,
    InvalidEnvelope(&'static str),
    InvalidRequestId,
    InvalidInitializeResponse(&'static str),
    MissingSessionId,
    MissingPromptStopReason,
}

impl fmt::Display for AcpProtocolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidJson => f.write_str("ACP agent emitted invalid JSON"),
            Self::InvalidJsonRpcVersion => f.write_str("ACP message is not JSON-RPC 2.0"),
            Self::InvalidEnvelope(detail) => write!(f, "invalid ACP JSON-RPC envelope: {detail}"),
            Self::InvalidRequestId => f.write_str("ACP message contains an invalid request id"),
            Self::InvalidInitializeResponse(detail) => {
                write!(f, "invalid ACP initialize response: {detail}")
            }
            Self::MissingSessionId => {
                f.write_str("ACP session response did not include a session id")
            }
            Self::MissingPromptStopReason => {
                f.write_str("ACP prompt response did not include a stop reason")
            }
        }
    }
}

impl std::error::Error for AcpProtocolError {}

/// Parse one newline-delimited JSON-RPC message without retaining the original
/// line. The caller can safely report the returned error without leaking raw
/// ACP diagnostics or configuration.
pub fn parse_incoming_line(line: &str) -> Result<AcpIncomingMessage, AcpProtocolError> {
    let value: Value = serde_json::from_str(line).map_err(|_| AcpProtocolError::InvalidJson)?;
    let object = value.as_object().ok_or(AcpProtocolError::InvalidEnvelope(
        "message is not an object",
    ))?;

    if object.get("jsonrpc").and_then(Value::as_str) != Some(JSON_RPC_VERSION) {
        return Err(AcpProtocolError::InvalidJsonRpcVersion);
    }

    let params = object.get("params").cloned().unwrap_or(Value::Null);
    if let Some(method) = object.get("method").and_then(Value::as_str) {
        return match object.get("id") {
            Some(id) if !id.is_null() => Ok(AcpIncomingMessage::Request {
                id: AcpRequestId::parse(id)?,
                method: method.to_string(),
                params,
            }),
            _ => Ok(AcpIncomingMessage::Notification {
                method: method.to_string(),
                params,
            }),
        };
    }

    let has_result = object.contains_key("result");
    let has_error = object.contains_key("error");
    if has_result == has_error {
        return Err(AcpProtocolError::InvalidEnvelope(
            "response must contain exactly one of result or error",
        ));
    }

    if has_result {
        let id = object.get("id").filter(|id| !id.is_null()).ok_or(
            AcpProtocolError::InvalidEnvelope("result response is missing id"),
        )?;
        return Ok(AcpIncomingMessage::Response {
            id: AcpRequestId::parse(id)?,
            result: object.get("result").cloned().unwrap_or(Value::Null),
        });
    }

    let error = object
        .get("error")
        .and_then(Value::as_object)
        .ok_or(AcpProtocolError::InvalidEnvelope("error is not an object"))?;
    let code = error
        .get("code")
        .and_then(Value::as_i64)
        .ok_or(AcpProtocolError::InvalidEnvelope("error code is missing"))?;
    let message =
        error
            .get("message")
            .and_then(Value::as_str)
            .ok_or(AcpProtocolError::InvalidEnvelope(
                "error message is missing",
            ))?;
    let id = match object.get("id") {
        Some(id) if !id.is_null() => Some(AcpRequestId::parse(id)?),
        _ => None,
    };
    Ok(AcpIncomingMessage::ErrorResponse {
        id,
        error: AcpRpcError {
            code,
            message: truncate_display_text(message, 500),
        },
    })
}

/// Build the restricted initialize request used for every ACP profile.
///
/// Taomni deliberately advertises neither general filesystem access nor a
/// terminal endpoint. Agents can only perform Taomni side effects through the
/// separately provisioned MCP surface.
pub fn initialize_request(
    id: impl Into<AcpRequestId>,
    client_name: impl Into<String>,
    client_version: impl Into<String>,
) -> AcpRequest {
    AcpRequest::new(
        id,
        METHOD_INITIALIZE,
        json!({
            "protocolVersion": ACP_PROTOCOL_VERSION,
            "clientCapabilities": {
                "fs": {
                    "readTextFile": false,
                    "writeTextFile": false,
                },
                "terminal": false,
            },
            "clientInfo": {
                "name": client_name.into(),
                "version": client_version.into(),
            },
        }),
    )
}

/// Build an authentication request for an advertised ACP auth method. The
/// method's credential handling remains inside the local CLI; this request
/// never transports an xAI API key or other secret from Taomni.
pub fn authenticate_request(
    id: impl Into<AcpRequestId>,
    method_id: impl Into<String>,
) -> AcpRequest {
    AcpRequest::new(
        id,
        METHOD_AUTHENTICATE,
        json!({ "methodId": method_id.into() }),
    )
}

/// Build a new ACP session request. `mcp_servers` must already have been
/// capability-checked and contain no secrets outside local loopback URLs.
pub fn new_session_request(
    id: impl Into<AcpRequestId>,
    cwd: impl Into<String>,
    mcp_servers: Vec<Value>,
) -> AcpRequest {
    AcpRequest::new(
        id,
        METHOD_SESSION_NEW,
        json!({
            "cwd": cwd.into(),
            "mcpServers": mcp_servers,
        }),
    )
}

/// Build a session resume request. ACP v1 requires the current cwd and MCP
/// server set again when loading a persisted session.
pub fn load_session_request(
    id: impl Into<AcpRequestId>,
    session_id: impl Into<String>,
    cwd: impl Into<String>,
    mcp_servers: Vec<Value>,
) -> AcpRequest {
    AcpRequest::new(
        id,
        METHOD_SESSION_LOAD,
        json!({
            "sessionId": session_id.into(),
            "cwd": cwd.into(),
            "mcpServers": mcp_servers,
        }),
    )
}

/// Build a text-only prompt turn. Text is the ACP v1 baseline content block and
/// therefore works for every compliant profile without advertising unsupported
/// file, image, or terminal capabilities.
pub fn prompt_request(
    id: impl Into<AcpRequestId>,
    session_id: impl Into<String>,
    text: impl Into<String>,
) -> AcpRequest {
    AcpRequest::new(
        id,
        METHOD_SESSION_PROMPT,
        json!({
            "sessionId": session_id.into(),
            "prompt": [{ "type": "text", "text": text.into() }],
        }),
    )
}

/// Build the fire-and-forget ACP cancellation notification. Notifications never
/// receive a JSON-RPC response; the active prompt completes later with a
/// `cancelled` stop reason.
pub fn cancel_notification(session_id: impl Into<String>) -> AcpNotification {
    AcpNotification::new(
        METHOD_SESSION_CANCEL,
        json!({ "sessionId": session_id.into() }),
    )
}

/// A safe summary of the agent's negotiated ACP features. We intentionally do
/// not retain arbitrary capability metadata or agent-provided configuration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpAgentInfo {
    pub protocol_version: u64,
    pub name: Option<String>,
    pub title: Option<String>,
    pub version: Option<String>,
    pub supports_session_load: bool,
    pub supports_mcp_http: bool,
    pub supports_mcp_sse: bool,
    pub auth_methods: Vec<AcpAuthMethod>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpAuthMethod {
    pub id: String,
    pub name: String,
}

/// Extract the stable, UI-safe fields from an initialize response.
pub fn parse_initialize_result(result: &Value) -> Result<AcpAgentInfo, AcpProtocolError> {
    let object = result
        .as_object()
        .ok_or(AcpProtocolError::InvalidInitializeResponse(
            "result is not an object",
        ))?;
    let protocol_version = object
        .get("protocolVersion")
        .and_then(Value::as_u64)
        .ok_or(AcpProtocolError::InvalidInitializeResponse(
            "protocolVersion is missing",
        ))?;

    let agent_info = object.get("agentInfo").and_then(Value::as_object);
    let capabilities = object.get("agentCapabilities").and_then(Value::as_object);
    let mcp_capabilities = capabilities
        .and_then(|caps| caps.get("mcpCapabilities"))
        .and_then(Value::as_object);
    let auth_methods = object
        .get("authMethods")
        .and_then(Value::as_array)
        .map(|methods| {
            methods
                .iter()
                .filter_map(|method| {
                    let method = method.as_object()?;
                    let id = method.get("id")?.as_str()?.trim();
                    let name = method.get("name")?.as_str()?.trim();
                    if id.is_empty() || name.is_empty() {
                        return None;
                    }
                    Some(AcpAuthMethod {
                        id: truncate_display_text(id, 120),
                        name: truncate_display_text(name, 160),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(AcpAgentInfo {
        protocol_version,
        name: agent_info
            .and_then(|info| info.get("name"))
            .and_then(Value::as_str)
            .map(|name| truncate_display_text(name, 160)),
        title: agent_info
            .and_then(|info| info.get("title"))
            .and_then(Value::as_str)
            .map(|title| truncate_display_text(title, 160)),
        version: agent_info
            .and_then(|info| info.get("version"))
            .and_then(Value::as_str)
            .map(|version| truncate_display_text(version, 120)),
        supports_session_load: capabilities
            .and_then(|caps| caps.get("loadSession"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        supports_mcp_http: mcp_capabilities
            .and_then(|caps| caps.get("http"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        supports_mcp_sse: mcp_capabilities
            .and_then(|caps| caps.get("sse"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        auth_methods,
    })
}

/// Return a newly-created ACP session id while preventing an empty or raw
/// provider result from being persisted.
pub fn session_id_from_response(result: &Value) -> Result<String, AcpProtocolError> {
    result
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(|id| id.to_string())
        .ok_or(AcpProtocolError::MissingSessionId)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AcpStopReason {
    EndTurn,
    MaxTokens,
    MaxTurnRequests,
    Refusal,
    Cancelled,
    Other(String),
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpPromptResult {
    pub stop_reason: AcpStopReason,
    pub usage: Option<LocalAgentUsage>,
}

pub fn parse_prompt_result(result: &Value) -> Result<AcpPromptResult, AcpProtocolError> {
    let stop_reason = result
        .get("stopReason")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|reason| !reason.is_empty())
        .ok_or(AcpProtocolError::MissingPromptStopReason)?;
    let stop_reason = match stop_reason {
        "end_turn" => AcpStopReason::EndTurn,
        "max_tokens" => AcpStopReason::MaxTokens,
        "max_turn_requests" => AcpStopReason::MaxTurnRequests,
        "refusal" => AcpStopReason::Refusal,
        "cancelled" => AcpStopReason::Cancelled,
        other => AcpStopReason::Other(truncate_display_text(other, 80)),
    };
    Ok(AcpPromptResult {
        stop_reason,
        usage: parse_prompt_usage(result),
    })
}

/// Extract only known numeric usage fields from agent-specific prompt
/// metadata. Grok currently reports final turn accounting under `_meta.usage`;
/// every other private metadata field remains intentionally unobserved.
fn parse_prompt_usage(result: &Value) -> Option<LocalAgentUsage> {
    let meta = result.get("_meta")?.as_object()?;
    let usage = meta.get("usage").and_then(Value::as_object).unwrap_or(meta);
    let input_tokens = first_u64(usage, &["inputTokens", "input_tokens"]);
    let output_tokens = first_u64(usage, &["outputTokens", "output_tokens"]);
    let total_tokens = first_u64(usage, &["totalTokens", "total_tokens"]);
    let total_cost_usd = first_f64(usage, &["totalCostUsd", "total_cost_usd", "costUsd"]);
    let duration_ms = first_u64(usage, &["durationMs", "duration_ms"]);
    let num_turns = first_u64(usage, &["numTurns", "num_turns"]);

    if [
        input_tokens,
        output_tokens,
        total_tokens,
        duration_ms,
        num_turns,
    ]
    .iter()
    .all(Option::is_none)
        && total_cost_usd.is_none()
    {
        return None;
    }

    Some(LocalAgentUsage {
        input_tokens,
        output_tokens,
        total_tokens,
        total_cost_usd,
        duration_ms,
        num_turns,
    })
}

fn first_u64(object: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<u64> {
    keys.iter()
        .find_map(|key| object.get(*key).and_then(Value::as_u64))
}

fn first_f64(object: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<f64> {
    keys.iter()
        .find_map(|key| object.get(*key).and_then(Value::as_f64))
}

/// A session-scoped ACP update. The event is intentionally optional because
/// protocol updates such as plans, modes, and unknown extensions are consumed
/// safely but are not yet surfaced in Taomni's chat UI.
#[derive(Debug, Clone, PartialEq)]
pub struct AcpSessionUpdate {
    pub session_id: String,
    pub is_replay: bool,
    pub event: Option<LocalAgentEvent>,
    pub usage: Option<AcpUsageUpdate>,
}

/// Context-window usage carries different semantics from input/output token
/// accounting, so it remains a separate value rather than being forced into
/// `LocalAgentUsage`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpUsageUpdate {
    pub used_tokens: u64,
    pub total_tokens: u64,
    pub cost_amount: Option<f64>,
    pub cost_currency: Option<String>,
}

/// Parse an ACP `session/update` params object into the limited UI-safe event
/// vocabulary. Raw tool input, tool output, provider metadata, and thoughts are
/// deliberately never forwarded into the shared local-agent model.
pub fn parse_session_update(params: &Value) -> Option<AcpSessionUpdate> {
    let session_id = params
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())?
        .to_string();
    let update = params.get("update").unwrap_or(params);
    let update_type = update.get("sessionUpdate").and_then(Value::as_str)?;
    let is_replay = params
        .get("_meta")
        .and_then(Value::as_object)
        .and_then(|meta| meta.get("isReplay"))
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let event = if is_replay {
        None
    } else {
        match update_type {
            "agent_message_chunk" | "agent_text" | "agent-text" => update
                .get("content")
                .and_then(Value::as_object)
                .filter(|content| {
                    content
                        .get("type")
                        .and_then(Value::as_str)
                        .is_none_or(|kind| kind == "text")
                })
                .and_then(|content| content.get("text"))
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
                .map(|content| LocalAgentEvent::AssistantDelta {
                    content: content.to_string(),
                }),
            "tool_call" => {
                let id = update
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|id| !id.is_empty());
                let title = update
                    .get("title")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|title| !title.is_empty())
                    .unwrap_or("Tool");
                id.map(|id| LocalAgentEvent::ToolStarted {
                    id: id.to_string(),
                    name: truncate_display_text(title, 240),
                    input: Value::Null,
                })
            }
            "tool_call_update" => {
                let id = update
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|id| !id.is_empty());
                let status = update
                    .get("status")
                    .and_then(Value::as_str)
                    .filter(|status| matches!(*status, "completed" | "failed"));
                id.zip(status)
                    .map(|(id, status)| LocalAgentEvent::ToolCompleted {
                        id: id.to_string(),
                        output: status.to_string(),
                    })
            }
            _ => None,
        }
    };

    let usage = if !is_replay && update_type == "usage_update" {
        let used_tokens = update.get("used").and_then(Value::as_u64)?;
        let total_tokens = update.get("size").and_then(Value::as_u64)?;
        let cost = update.get("cost").and_then(Value::as_object);
        Some(AcpUsageUpdate {
            used_tokens,
            total_tokens,
            cost_amount: cost
                .and_then(|cost| cost.get("amount"))
                .and_then(Value::as_f64),
            cost_currency: cost
                .and_then(|cost| cost.get("currency"))
                .and_then(Value::as_str)
                .map(|currency| truncate_display_text(currency, 16)),
        })
    } else {
        None
    };

    Some(AcpSessionUpdate {
        session_id,
        is_replay,
        event,
        usage,
    })
}

fn truncate_display_text(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars();
    let truncated: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        format!("{truncated}…")
    } else {
        truncated
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builders_follow_acp_v1_and_advertise_restricted_capabilities() {
        let initialize = initialize_request(1, "taomni", "0.3.0");
        assert_eq!(initialize.method, METHOD_INITIALIZE);
        assert_eq!(
            serde_json::to_value(initialize).unwrap(),
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": 1,
                    "clientCapabilities": {
                        "fs": { "readTextFile": false, "writeTextFile": false },
                        "terminal": false,
                    },
                    "clientInfo": { "name": "taomni", "version": "0.3.0" },
                },
            }),
        );

        assert_eq!(
            serde_json::to_value(new_session_request(2, "/workspace", vec![])).unwrap(),
            json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "session/new",
                "params": { "cwd": "/workspace", "mcpServers": [] },
            }),
        );
        assert_eq!(
            serde_json::to_value(prompt_request(3, "session-1", "hello")).unwrap(),
            json!({
                "jsonrpc": "2.0",
                "id": 3,
                "method": "session/prompt",
                "params": {
                    "sessionId": "session-1",
                    "prompt": [{ "type": "text", "text": "hello" }],
                },
            }),
        );
        assert_eq!(
            serde_json::to_value(cancel_notification("session-1")).unwrap(),
            json!({
                "jsonrpc": "2.0",
                "method": "session/cancel",
                "params": { "sessionId": "session-1" },
            }),
        );
    }

    #[test]
    fn parses_json_rpc_response_error_notification_and_peer_request() {
        assert_eq!(
            parse_incoming_line(r#"{"jsonrpc":"2.0","id":7,"result":{"sessionId":"s1"}}"#).unwrap(),
            AcpIncomingMessage::Response {
                id: AcpRequestId::Number(7),
                result: json!({ "sessionId": "s1" }),
            },
        );
        assert_eq!(
            parse_incoming_line(
                r#"{"jsonrpc":"2.0","id":7,"error":{"code":-32001,"message":"not authenticated","data":{"secret":"discarded"}}}"#,
            )
            .unwrap(),
            AcpIncomingMessage::ErrorResponse {
                id: Some(AcpRequestId::Number(7)),
                error: AcpRpcError {
                    code: -32001,
                    message: "not authenticated".into(),
                },
            },
        );
        assert_eq!(
            parse_incoming_line(r#"{"jsonrpc":"2.0","method":"session/update","params":{}}"#)
                .unwrap(),
            AcpIncomingMessage::Notification {
                method: "session/update".into(),
                params: json!({}),
            },
        );
        assert_eq!(
            parse_incoming_line(
                r#"{"jsonrpc":"2.0","id":"fs-1","method":"fs/read_text_file","params":{}}"#
            )
            .unwrap(),
            AcpIncomingMessage::Request {
                id: AcpRequestId::String("fs-1".into()),
                method: "fs/read_text_file".into(),
                params: json!({}),
            },
        );
    }

    #[test]
    fn rejects_malformed_or_ambiguous_json_rpc_messages() {
        assert_eq!(
            parse_incoming_line("not-json"),
            Err(AcpProtocolError::InvalidJson)
        );
        assert_eq!(
            parse_incoming_line(r#"{"jsonrpc":"1.0","id":1,"result":{}}"#),
            Err(AcpProtocolError::InvalidJsonRpcVersion),
        );
        assert_eq!(
            parse_incoming_line(r#"{"jsonrpc":"2.0","id":1,"result":{},"error":{}}"#),
            Err(AcpProtocolError::InvalidEnvelope(
                "response must contain exactly one of result or error"
            )),
        );
    }

    #[test]
    fn extracts_safe_initialize_session_and_prompt_metadata() {
        let initialize = parse_initialize_result(&json!({
            "protocolVersion": 1,
            "agentInfo": { "name": "grok", "title": "Grok", "version": "0.2.101" },
            "agentCapabilities": {
                "loadSession": true,
                "mcpCapabilities": { "http": true, "sse": false },
            },
            "authMethods": [
                { "id": "cached_token", "name": "Cached token" },
                { "id": "xai.api_key", "name": "API key", "credentials": "discarded" },
            ],
        }))
        .unwrap();
        assert_eq!(
            initialize,
            AcpAgentInfo {
                protocol_version: 1,
                name: Some("grok".into()),
                title: Some("Grok".into()),
                version: Some("0.2.101".into()),
                supports_session_load: true,
                supports_mcp_http: true,
                supports_mcp_sse: false,
                auth_methods: vec![
                    AcpAuthMethod {
                        id: "cached_token".into(),
                        name: "Cached token".into(),
                    },
                    AcpAuthMethod {
                        id: "xai.api_key".into(),
                        name: "API key".into(),
                    },
                ],
            },
        );
        assert_eq!(
            session_id_from_response(&json!({ "sessionId": "s1" })).unwrap(),
            "s1",
        );
        assert_eq!(
            parse_prompt_result(&json!({
                "stopReason": "cancelled",
                "_meta": {
                    "usage": {
                        "inputTokens": 12,
                        "outputTokens": 7,
                        "totalTokens": 19,
                        "numTurns": 2,
                        "privateConfig": "discarded",
                    },
                },
            }))
            .unwrap(),
            AcpPromptResult {
                stop_reason: AcpStopReason::Cancelled,
                usage: Some(LocalAgentUsage {
                    input_tokens: Some(12),
                    output_tokens: Some(7),
                    total_tokens: Some(19),
                    total_cost_usd: None,
                    duration_ms: None,
                    num_turns: Some(2),
                }),
            },
        );
    }

    #[test]
    fn maps_safe_session_updates_without_forwarding_raw_tool_data_or_thoughts() {
        assert_eq!(
            parse_session_update(&json!({
                "sessionId": "s1",
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "type": "text", "text": "Hello" },
                },
            })),
            Some(AcpSessionUpdate {
                session_id: "s1".into(),
                is_replay: false,
                event: Some(LocalAgentEvent::AssistantDelta {
                    content: "Hello".into(),
                }),
                usage: None,
            }),
        );
        assert_eq!(
            parse_session_update(&json!({
                "sessionId": "s1",
                "update": {
                    "sessionUpdate": "tool_call",
                    "toolCallId": "tool-1",
                    "title": "Read config",
                    "rawInput": { "token": "must not escape" },
                },
            })),
            Some(AcpSessionUpdate {
                session_id: "s1".into(),
                is_replay: false,
                event: Some(LocalAgentEvent::ToolStarted {
                    id: "tool-1".into(),
                    name: "Read config".into(),
                    input: Value::Null,
                }),
                usage: None,
            }),
        );
        assert_eq!(
            parse_session_update(&json!({
                "sessionId": "s1",
                "update": {
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": "tool-1",
                    "status": "completed",
                    "rawOutput": { "token": "must not escape" },
                },
            })),
            Some(AcpSessionUpdate {
                session_id: "s1".into(),
                is_replay: false,
                event: Some(LocalAgentEvent::ToolCompleted {
                    id: "tool-1".into(),
                    output: "completed".into(),
                }),
                usage: None,
            }),
        );
        assert_eq!(
            parse_session_update(&json!({
                "sessionId": "s1",
                "update": {
                    "sessionUpdate": "agent_thought_chunk",
                    "content": { "type": "text", "text": "hidden reasoning" },
                },
            })),
            Some(AcpSessionUpdate {
                session_id: "s1".into(),
                is_replay: false,
                event: None,
                usage: None,
            }),
        );
        assert_eq!(
            parse_session_update(&json!({
                "sessionId": "s1",
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "type": "text", "text": "old answer" },
                },
                "_meta": { "isReplay": true },
            })),
            Some(AcpSessionUpdate {
                session_id: "s1".into(),
                is_replay: true,
                event: None,
                usage: None,
            }),
        );
    }

    #[test]
    fn preserves_usage_as_context_window_metadata() {
        assert_eq!(
            parse_session_update(&json!({
                "sessionId": "s1",
                "update": {
                    "sessionUpdate": "usage_update",
                    "used": 240,
                    "size": 8192,
                    "cost": { "amount": 0.12, "currency": "USD" },
                },
            })),
            Some(AcpSessionUpdate {
                session_id: "s1".into(),
                is_replay: false,
                event: None,
                usage: Some(AcpUsageUpdate {
                    used_tokens: 240,
                    total_tokens: 8192,
                    cost_amount: Some(0.12),
                    cost_currency: Some("USD".into()),
                }),
            }),
        );
    }
}
