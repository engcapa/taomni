//! Application composition. Core and temporary feature ownership stay explicit.
mod core;
mod domains;
pub(crate) mod legacy;
mod mail;
pub use core::CoreState;
pub use domains::*;
pub use legacy::LegacyFeatureRuntime;
pub(crate) use mail::{MailRuntime, mail_db_file_stem};
use std::path::PathBuf;
use std::sync::Arc;

pub type MailDbHandle = Arc<crate::mail::coordination::MailDatabase>;

pub struct WriteStreamHandle {
    pub path: PathBuf,
    pub file: std::fs::File,
}

pub struct ReadStreamHandle {
    pub file: std::fs::File,
}

/// In-flight keyboard-interactive (MFA/OTP) auth round. The SSH connect task
/// registers a oneshot sender here keyed by a per-round request id, emits a
/// prompt event to the frontend, then awaits the user's answers on the
/// receiver. `submit_ssh_auth_response` looks the sender up and delivers the
/// responses (or `None` if the user cancelled).
pub type SshAuthResponder = tokio::sync::oneshot::Sender<Option<Vec<String>>>;

/// Outcome the frontend returns for a Claude Code *side-effect* tool call that
/// the in-app MCP server dispatched to it (`run_in_terminal`, `sftp_upload`,
/// `switch_tab`, …). The MCP tool handler registers a oneshot sender keyed by a
/// per-call id, emits an `agent-cc-tool` event, then blocks on the receiver
/// until `cc_resolve_tool_call` delivers this outcome (D2 hybrid model — the
/// human is naturally in the loop because the frontend performs the effect).
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct CcToolOutcome {
    pub ok: bool,
    pub output: String,
}

pub type CcToolResponder = tokio::sync::oneshot::Sender<CcToolOutcome>;

/// Human decision for a Claude Code permission prompt (HITL, Phase 2). The
/// `permission_prompt` MCP tool registers a oneshot keyed by a per-call id,
/// emits `agent-cc-permission`, and blocks until `cc_resolve_permission`
/// delivers the user's choice from the ActionCard.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CcPermissionDecision {
    Allow,
    AllowSession,
    Deny,
}

pub type CcPermissionResponder = tokio::sync::oneshot::Sender<CcPermissionDecision>;

/// Managed compatibility composition, not a second copy of domain state.
/// No Deref: every caller must name its real core or temporary legacy owner.
pub struct AppState {
    pub core: Arc<CoreState>,
    pub plugins: Arc<crate::plugin::PluginRegistry>,
    pub plugin_downloads: Arc<crate::plugin::download::DownloadManager>,
    pub legacy: LegacyFeatureRuntime,
    pub(crate) _profile: Arc<crate::runtime::profile::ProfileRuntimeLeases>,
}
