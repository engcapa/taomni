use super::display::truncate_display_text;
use super::wire::AcpProtocolError;
use crate::agent::local::LocalAgentUsage;
use serde::Serialize;
use serde_json::Value;

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
    pub supports_prompt_images: bool,
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
    let prompt_capabilities = capabilities
        .and_then(|caps| caps.get("promptCapabilities"))
        .and_then(Value::as_object);
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
        supports_prompt_images: prompt_capabilities
            .and_then(|caps| caps.get("image"))
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
pub(super) fn parse_prompt_usage(result: &Value) -> Option<LocalAgentUsage> {
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

pub(super) fn first_u64(object: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<u64> {
    keys.iter()
        .find_map(|key| object.get(*key).and_then(Value::as_u64))
}

pub(super) fn first_f64(object: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<f64> {
    keys.iter()
        .find_map(|key| object.get(*key).and_then(Value::as_f64))
}
