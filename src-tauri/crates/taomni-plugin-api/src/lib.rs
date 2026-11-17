//! The wire contract between the Taomni core and an out-of-process plugin.
//!
//! The crate deliberately contains data types and small validation helpers only.
//! A plugin host must be able to depend on this crate without pulling in Tauri,
//! the application crate, or a particular async runtime.  JSON-RPC messages are
//! sent over the host's stdio control channel; large frames use [`BinaryRef`] to
//! identify a separately authenticated loopback stream.

use serde::{Deserialize, Serialize};
use serde_json::Value;

mod binary_ref;
pub use binary_ref::BinaryRef;
mod correlation;
mod metadata;
pub use correlation::{ReplayError, RequestIdMode, RequestReplay};
pub mod services;
pub use metadata::PluginKind;

/// Version of the core/plugin API shape. Increment this when a shared service
/// or extension point changes incompatibly.
pub const API_VERSION: u32 = 1;
/// Version of the JSON-RPC message contract. This is independent from
/// [`API_VERSION`], so wire-compatible API additions need not invalidate a
/// plugin's core compatibility declaration.
pub const PROTOCOL_VERSION: u32 = 1;
/// Descriptive aliases used by host implementations. Keep these aliases so
/// protocol code can name the two versions without coupling to a particular
/// role (core versus plugin).
pub const PLUGIN_API_VERSION: u32 = API_VERSION;
pub const RPC_PROTOCOL_VERSION: u32 = PROTOCOL_VERSION;

/// JSON-RPC request identifiers accepted by the protocol.
#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RequestId {
    String(String),
    Number(i64),
}

/// Short alias for code that refers to the JSON-RPC identifier as an RPC id.
pub type RpcId = RequestId;

impl From<String> for RequestId {
    fn from(value: String) -> Self {
        Self::String(value)
    }
}

impl From<&str> for RequestId {
    fn from(value: &str) -> Self {
        Self::String(value.to_owned())
    }
}

impl From<i64> for RequestId {
    fn from(value: i64) -> Self {
        Self::Number(value)
    }
}

impl std::fmt::Display for RequestId {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::String(value) => formatter.write_str(value),
            Self::Number(value) => value.fmt(formatter),
        }
    }
}

/// A JSON-RPC 2.0 request on the stdio control channel.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RpcRequest {
    pub jsonrpc: String,
    pub id: RequestId,
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
    /// Correlation only; the core authenticates the transport and live permit.
    /// Kept outside params so existing command payloads remain wire compatible.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<services::OperationContext>,
}

impl RpcRequest {
    pub fn new(id: impl Into<RequestId>, method: impl Into<String>, params: Option<Value>) -> Self {
        Self {
            jsonrpc: "2.0".to_owned(),
            id: id.into(),
            method: method.into(),
            params,
            context: None,
        }
    }
}

/// A JSON-RPC notification. Notifications intentionally have no identifier and
/// never receive a response.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RpcNotification {
    pub jsonrpc: String,
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

impl RpcNotification {
    pub fn new(method: impl Into<String>, params: Option<Value>) -> Self {
        Self {
            jsonrpc: "2.0".to_owned(),
            method: method.into(),
            params,
        }
    }
}

/// A successful or failed JSON-RPC response.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RpcResponse {
    pub jsonrpc: String,
    pub id: Option<RequestId>,
    #[serde(
        default,
        deserialize_with = "present_response_field",
        skip_serializing_if = "Option::is_none"
    )]
    pub result: Option<Value>,
    #[serde(
        default,
        deserialize_with = "present_response_field",
        skip_serializing_if = "Option::is_none"
    )]
    pub error: Option<RpcError>,
}

/// JSON-RPC permits a successful `result: null`. Serde's normal Option decoder
/// collapses it into an absent field, which makes a completed void operation
/// look like an invalid response. Missing fields use default None; present
/// fields decode their actual type (so `error: null` remains invalid).
fn present_response_field<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

impl RpcResponse {
    pub fn success(id: impl Into<RequestId>, result: Value) -> Self {
        Self {
            jsonrpc: "2.0".to_owned(),
            id: Some(id.into()),
            result: Some(result),
            error: None,
        }
    }

    pub fn failure(id: Option<RequestId>, error: RpcError) -> Self {
        Self {
            jsonrpc: "2.0".to_owned(),
            id,
            result: None,
            error: Some(error),
        }
    }
}

/// The messages that may travel over the control channel.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RpcMessage {
    Request(RpcRequest),
    Notification(RpcNotification),
    Response(RpcResponse),
}

/// Stable JSON-RPC and plugin lifecycle error codes.
///
/// Custom codes intentionally remain in the reserved server range. Keep the
/// numeric values stable: they are displayed in diagnostics and consumed by
/// the host's retry/cancellation logic.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(i32)]
pub enum ErrorCode {
    ParseError = -32700,
    InvalidRequest = -32600,
    MethodNotFound = -32601,
    InvalidParams = -32602,
    InternalError = -32603,
    ApiVersionMismatch = -32001,
    ProtocolVersionMismatch = -32002,
    TokenMismatch = -32003,
    PermissionDenied = -32004,
    DuplicateRequest = -32005,
    RequestCancelled = -32006,
    RequestTimeout = -32007,
    PluginCrashed = -32008,
    InvalidState = -32009,
}

impl ErrorCode {
    pub const fn as_i32(self) -> i32 {
        self as i32
    }
}

/// A serializable, stable JSON-RPC error.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RpcError {
    pub code: i32,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl RpcError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code: code.as_i32(),
            message: message.into(),
            data: None,
        }
    }

    pub fn with_data(mut self, data: Value) -> Self {
        self.data = Some(data);
        self
    }

    pub fn from_code(code: ErrorCode) -> Self {
        Self::new(code, default_error_message(code))
    }
}

fn default_error_message(code: ErrorCode) -> &'static str {
    match code {
        ErrorCode::ParseError => "Parse error",
        ErrorCode::InvalidRequest => "Invalid request",
        ErrorCode::MethodNotFound => "Method not found",
        ErrorCode::InvalidParams => "Invalid params",
        ErrorCode::InternalError => "Internal error",
        ErrorCode::ApiVersionMismatch => "Plugin API version mismatch",
        ErrorCode::ProtocolVersionMismatch => "Plugin protocol version mismatch",
        ErrorCode::TokenMismatch => "Plugin token mismatch",
        ErrorCode::PermissionDenied => "Plugin permission denied",
        ErrorCode::DuplicateRequest => "Duplicate request id",
        ErrorCode::RequestCancelled => "Plugin request cancelled",
        ErrorCode::RequestTimeout => "Plugin request timed out",
        ErrorCode::PluginCrashed => "Plugin host exited unexpectedly",
        ErrorCode::InvalidState => "Invalid plugin state",
    }
}

/// Core-to-host handshake request. The token is a per-process secret supplied
/// by the core and must be echoed by the host before any command is accepted.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandshakeRequest {
    pub api_version: u32,
    pub protocol_version: u32,
    pub plugin_id: String,
    pub plugin_version: String,
    pub token: String,
    #[serde(default)]
    pub commands: Vec<String>,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(
        default,
        skip_serializing_if = "services::ServiceCapabilities::is_empty"
    )]
    pub core_services: services::ServiceCapabilities,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_instance: Option<services::HostInstanceId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<services::HostProfileContext>,
    #[serde(default, skip_serializing_if = "RequestIdMode::is_legacy")]
    pub request_id_mode: RequestIdMode,
}

impl HandshakeRequest {
    pub fn new(
        plugin_id: impl Into<String>,
        plugin_version: impl Into<String>,
        token: impl Into<String>,
        commands: Vec<String>,
        permissions: Vec<String>,
    ) -> Self {
        Self {
            api_version: API_VERSION,
            protocol_version: PROTOCOL_VERSION,
            plugin_id: plugin_id.into(),
            plugin_version: plugin_version.into(),
            token: token.into(),
            commands,
            permissions,
            core_services: services::ServiceCapabilities::default(),
            host_instance: None,
            profile: None,
            request_id_mode: RequestIdMode::Legacy,
        }
    }
}

/// Host-to-core handshake response.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandshakeResponse {
    pub api_version: u32,
    pub protocol_version: u32,
    pub accepted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
    #[serde(default)]
    pub heartbeat_interval_ms: u64,
    #[serde(
        default,
        skip_serializing_if = "services::ServiceCapabilities::is_empty"
    )]
    pub core_services: services::ServiceCapabilities,
    /// A host acknowledges this only after acquiring its own OS leases.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<services::HostProfileContext>,
    /// Echoed only when both peers implement the scoped sequence contract.
    #[serde(default, skip_serializing_if = "RequestIdMode::is_legacy")]
    pub request_id_mode: RequestIdMode,
}

impl HandshakeResponse {
    pub fn accepted(heartbeat_interval_ms: u64) -> Self {
        Self {
            api_version: API_VERSION,
            protocol_version: PROTOCOL_VERSION,
            accepted: true,
            error: None,
            heartbeat_interval_ms,
            core_services: services::ServiceCapabilities::default(),
            profile: None,
            request_id_mode: RequestIdMode::Legacy,
        }
    }

    pub fn rejected(error: RpcError) -> Self {
        Self {
            api_version: API_VERSION,
            protocol_version: PROTOCOL_VERSION,
            accepted: false,
            error: Some(error),
            heartbeat_interval_ms: 0,
            core_services: services::ServiceCapabilities::default(),
            profile: None,
            request_id_mode: RequestIdMode::Legacy,
        }
    }
}

/// Validate the protocol and API versions advertised by a peer.
pub fn validate_versions(api_version: u32, protocol_version: u32) -> Result<(), RpcError> {
    if api_version != API_VERSION {
        return Err(RpcError::from_code(ErrorCode::ApiVersionMismatch)
            .with_data(serde_json::json!({ "expected": API_VERSION, "received": api_version })));
    }
    if protocol_version != PROTOCOL_VERSION {
        return Err(
            RpcError::from_code(ErrorCode::ProtocolVersionMismatch).with_data(
                serde_json::json!({ "expected": PROTOCOL_VERSION, "received": protocol_version }),
            ),
        );
    }
    Ok(())
}

/// Compare a presented process token with the one issued by the core.
///
/// The comparison is constant-time for equal-length tokens and does not leak
/// which prefix matched. A length mismatch is rejected before the comparison.
pub fn validate_token(expected: &str, presented: &str) -> Result<(), RpcError> {
    if expected.len() != presented.len() {
        return Err(RpcError::from_code(ErrorCode::TokenMismatch));
    }
    let mut difference = 0u8;
    for (left, right) in expected.bytes().zip(presented.bytes()) {
        difference |= left ^ right;
    }
    if difference == 0 {
        Ok(())
    } else {
        Err(RpcError::from_code(ErrorCode::TokenMismatch))
    }
}

/// Request cancellation notification. It is sent as the `$/cancelRequest`
/// JSON-RPC notification and therefore has no response of its own.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelRequest {
    pub request_id: RequestId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl CancelRequest {
    pub const METHOD: &'static str = "$/cancelRequest";

    pub fn notification(&self) -> RpcNotification {
        RpcNotification::new(
            Self::METHOD,
            Some(serde_json::to_value(self).expect("CancelRequest is serializable")),
        )
    }
}

/// Heartbeat notification used to detect a dead host without sending a command
/// request. The timestamp is milliseconds since the Unix epoch, supplied by the
/// sender's monotonic/lifecycle clock.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Heartbeat {
    pub timestamp_ms: u64,
}

impl Heartbeat {
    pub const METHOD: &'static str = "plugin/heartbeat";

    pub fn notification(&self) -> RpcNotification {
        RpcNotification::new(
            Self::METHOD,
            Some(serde_json::to_value(self).expect("Heartbeat is serializable")),
        )
    }
}

/// Plugin event notification. Events are namespaced by the plugin host and are
/// never interpreted as command responses by the core.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginEvent {
    pub event: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<Value>,
}

impl PluginEvent {
    pub const METHOD: &'static str = "plugin/event";

    pub fn notification(&self) -> RpcNotification {
        RpcNotification::new(
            Self::METHOD,
            Some(serde_json::to_value(self).expect("PluginEvent is serializable")),
        )
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod binary_ref_tests;
