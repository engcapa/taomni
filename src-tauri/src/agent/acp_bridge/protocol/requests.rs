use super::wire::ACP_PROTOCOL_VERSION;
use super::wire::AcpNotification;
use super::wire::AcpRequest;
use super::wire::AcpRequestId;
use super::wire::METHOD_AUTHENTICATE;
use super::wire::METHOD_INITIALIZE;
use super::wire::METHOD_SESSION_CANCEL;
use super::wire::METHOD_SESSION_LOAD;
use super::wire::METHOD_SESSION_NEW;
use super::wire::METHOD_SESSION_PROMPT;
use serde_json::Value;
use serde_json::json;

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

/// A local resource exposed to an ACP agent with a standard `resource_link`
/// prompt block. Unlike an inline `image` block, resource links do not require
/// the optional image prompt capability. They let a local agent opt into
/// opening an attachment from its own filesystem when that agent supports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcpResourceLink {
    pub uri: String,
    pub name: String,
    pub mime_type: Option<String>,
}

impl AcpResourceLink {
    pub fn new(uri: impl Into<String>, name: impl Into<String>, mime_type: Option<String>) -> Self {
        Self {
            uri: uri.into(),
            name: name.into(),
            mime_type,
        }
    }

    pub(super) fn as_prompt_block(&self) -> Value {
        let mut block = serde_json::Map::new();
        block.insert("type".into(), Value::String("resource_link".into()));
        block.insert("uri".into(), Value::String(self.uri.clone()));
        block.insert("name".into(), Value::String(self.name.clone()));
        if let Some(mime_type) = self
            .mime_type
            .as_deref()
            .map(str::trim)
            .filter(|mime_type| !mime_type.is_empty())
        {
            block.insert("mimeType".into(), Value::String(mime_type.into()));
        }
        Value::Object(block)
    }
}

/// Build a baseline text prompt turn. Text works for every compliant profile
/// without advertising unsupported image, audio, filesystem, or terminal
/// capabilities.
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

/// Build a prompt turn with local ACP resource links. This intentionally does
/// not use an inline `image` content block: callers must honor an agent's
/// negotiated `promptCapabilities.image` before using that optional feature.
pub fn prompt_with_resource_links_request(
    id: impl Into<AcpRequestId>,
    session_id: impl Into<String>,
    text: impl Into<String>,
    resource_links: &[AcpResourceLink],
) -> AcpRequest {
    let mut prompt = vec![json!({ "type": "text", "text": text.into() })];
    prompt.extend(resource_links.iter().map(AcpResourceLink::as_prompt_block));
    AcpRequest::new(
        id,
        METHOD_SESSION_PROMPT,
        json!({
            "sessionId": session_id.into(),
            "prompt": prompt,
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
