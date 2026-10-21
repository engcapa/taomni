mod wire;

mod permissions;

mod requests;

mod responses;

mod update_model;

mod updates;

mod display;

#[cfg(test)]
mod tests;

pub use wire::{
    ACP_PROTOCOL_VERSION, AcpIncomingMessage, AcpNotification, AcpProtocolError, AcpRequest,
    AcpRequestId, AcpRpcError, JSON_RPC_VERSION, METHOD_AUTHENTICATE, METHOD_INITIALIZE,
    METHOD_SESSION_CANCEL, METHOD_SESSION_LOAD, METHOD_SESSION_NEW, METHOD_SESSION_PROMPT,
    METHOD_SESSION_REQUEST_PERMISSION, METHOD_SESSION_UPDATE, parse_incoming_line,
};

pub use permissions::{
    AcpPermissionOption, AcpPermissionOptionKind, AcpPermissionRequest, is_taomni_mcp_tool_name,
    parse_permission_request, permission_cancelled_response, permission_selected_response,
    tool_call_targets_taomni_mcp,
};

pub use requests::{
    AcpResourceLink, authenticate_request, cancel_notification, initialize_request,
    load_session_request, new_session_request, prompt_request, prompt_with_resource_links_request,
};

pub use responses::{
    AcpAgentInfo, AcpAuthMethod, AcpPromptResult, AcpStopReason, parse_initialize_result,
    parse_prompt_result, session_id_from_response,
};

pub use update_model::{AcpGeneratedMedia, AcpSessionUpdate, AcpUsageUpdate};

pub use updates::parse_session_update;

pub(super) use display::truncate_display_text;
