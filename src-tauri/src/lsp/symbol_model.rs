use super::feature_model::LspRange;
use super::lifetime_model::LspSession;
use super::status_model::LspDocumentStatus;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Weak;
use std::time::Instant;

/// Workspace-wide symbol hit from `workspace/symbol`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspWorkspaceSymbol {
    pub name: String,
    pub kind: u32,
    pub container_name: Option<String>,
    pub uri: String,
    pub path: Option<String>,
    pub range: LspRange,
    pub selection_range: LspRange,
    /// False when the provider returned only a URI and requires
    /// `workspaceSymbol/resolve` before a location is available.
    #[serde(default)]
    pub resolved: bool,
    /// Short-lived opaque handle for a deferred provider resolve.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolve_token: Option<String>,
    #[serde(skip)]
    pub(super) raw: Option<Value>,
    #[serde(skip)]
    pub(super) provider_session_key: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspWorkspaceSymbolsResult {
    pub status: LspDocumentStatus,
    pub symbols: Vec<LspWorkspaceSymbol>,
    /// Number of ready language-server sessions discovered for this workspace.
    #[serde(default)]
    pub session_count: u32,
    /// Number of discovered sessions that advertised workspace/symbol and were
    /// actually queried (bounded by the provider fan-out limit).
    #[serde(default)]
    pub provider_count: u32,
    /// Ready sessions that were not queried because they did not advertise
    /// workspace/symbol or fell outside the bounded provider fan-out.
    #[serde(default)]
    pub skipped_provider_count: u32,
    /// Providers whose request or response could not be consumed.
    #[serde(default)]
    pub failed_provider_count: u32,
    /// False when at least one provider failed, no provider was available, or
    /// the bounded result limit was reached. Consumers must not present an
    /// incomplete result as an authoritative project index.
    #[serde(default)]
    pub complete: bool,
    #[serde(default)]
    pub truncated: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub diagnostics: Vec<String>,
}

pub(super) struct WorkspaceSymbolResolutionBatch {
    pub(super) workspace_id: String,
    pub(super) created_at: Instant,
    pub(super) bytes: usize,
    pub(super) entries: HashMap<String, WorkspaceSymbolResolutionEntry>,
}

#[derive(Clone)]
pub(super) struct WorkspaceSymbolResolutionEntry {
    pub(super) session: Weak<LspSession>,
    pub(super) raw: Value,
}
