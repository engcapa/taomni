//! Agent Client Protocol (ACP) support for local coding agents.
//!
//! This module is additive. It owns the provider-neutral ACP wire contract and
//! will eventually host the stdio runtime used by ACP profiles such as Grok.
//! Existing Claude Code and Codex bridges intentionally remain on their
//! current protocols.

mod protocol;

pub use protocol::{
    AcpAgentInfo, AcpAuthMethod, AcpIncomingMessage, AcpNotification, AcpPromptResult,
    AcpProtocolError, AcpRequest, AcpRequestId, AcpRpcError, AcpSessionUpdate, AcpStopReason,
    AcpUsageUpdate, METHOD_AUTHENTICATE, METHOD_INITIALIZE, METHOD_SESSION_CANCEL,
    METHOD_SESSION_LOAD, METHOD_SESSION_NEW, METHOD_SESSION_PROMPT, METHOD_SESSION_UPDATE,
    authenticate_request, cancel_notification, initialize_request, load_session_request,
    new_session_request, parse_incoming_line, parse_initialize_result, parse_prompt_result,
    parse_session_update, prompt_request, session_id_from_response,
};
