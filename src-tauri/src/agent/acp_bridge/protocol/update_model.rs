use crate::agent::local::LocalAgentEvent;
use serde::Serialize;

/// A session-scoped ACP update. The event is intentionally optional because
/// protocol updates such as plans, modes, and unknown extensions are consumed
/// safely but are not yet surfaced in Taomni's chat UI.
#[derive(Debug, Clone, PartialEq)]
pub struct AcpSessionUpdate {
    pub session_id: String,
    pub is_replay: bool,
    pub event: Option<LocalAgentEvent>,
    pub usage: Option<AcpUsageUpdate>,
    /// A local file emitted by a completed agent tool. Only the path is
    /// retained; raw tool input/output and provider metadata stay private.
    /// Consumers must validate and copy this file before exposing it.
    pub generated_media: Option<AcpGeneratedMedia>,
}

/// A candidate local media artifact emitted by an ACP agent tool update.
/// This is deliberately minimal: the raw tool output is never retained or
/// surfaced to chat, and the artifact kind is determined from the copied file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcpGeneratedMedia {
    pub path: String,
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
