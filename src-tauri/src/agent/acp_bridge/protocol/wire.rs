use super::display::truncate_display_text;
use serde::Serialize;
use serde_json::Value;
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
pub const METHOD_SESSION_REQUEST_PERMISSION: &str = "session/request_permission";

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
    pub(super) fn parse(value: &Value) -> Result<Self, AcpProtocolError> {
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
    pub(super) json_rpc: &'static str,
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
    pub(super) json_rpc: &'static str,
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
/// Agent-to-client requests are retained so the stdio runtime can surface the
/// standard permission request through a human gate while explicitly rejecting
/// filesystem, terminal, and other unsupported calls. Taomni does not
/// advertise those capabilities in v1.
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
    InvalidPermissionRequest(&'static str),
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
            Self::InvalidPermissionRequest(detail) => {
                write!(f, "invalid ACP permission request: {detail}")
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
