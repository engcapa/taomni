use crate::lsp::edit_types::LspWorkspaceEdit;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex as StdMutex;
use std::sync::OnceLock;
use std::sync::atomic::AtomicU64;
use tauri::AppHandle;
use tokio::sync::oneshot;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspWorkspaceApplyEditResponse {
    pub applied: bool,
    pub failure_reason: Option<String>,
    pub failed_change: Option<u32>,
}

impl LspWorkspaceApplyEditResponse {
    pub(super) fn failed(reason: impl Into<String>) -> Self {
        Self {
            applied: false,
            failure_reason: Some(reason.into()),
            failed_change: None,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LspWorkspaceApplyEditRequest {
    pub(super) request_id: String,
    pub(super) workspace_id: String,
    pub(super) label: Option<String>,
    pub(super) edit: LspWorkspaceEdit,
}

pub(super) struct PendingWorkspaceApplyEdit {
    pub(super) workspace_id: String,
    pub(super) sender: oneshot::Sender<LspWorkspaceApplyEditResponse>,
}

pub(super) struct PendingShowMessageRequest {
    pub(super) workspace_id: String,
    pub(super) actions: Vec<Value>,
    pub(super) sender: oneshot::Sender<Option<Value>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LspShowMessageRequestEvent {
    pub(super) request_id: String,
    pub(super) workspace_id: String,
    pub(super) server_label: String,
    pub(super) message_type: u32,
    pub(super) message: String,
    pub(super) actions: Vec<Value>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LspShowMessageCancelledEvent {
    pub(super) request_id: String,
    pub(super) workspace_id: String,
    pub(super) reason: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LspShowMessageEvent {
    pub(super) workspace_id: String,
    pub(super) server_label: String,
    pub(super) message_type: u32,
    pub(super) message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LspWorkDoneProgressEvent {
    pub(super) workspace_id: String,
    pub(super) preset_id: String,
    pub(super) server_label: String,
    pub(super) root_uri: String,
    pub(super) token: Value,
    pub(super) kind: String,
    pub(super) title: Option<String>,
    pub(super) message: Option<String>,
    pub(super) percentage: Option<u32>,
    pub(super) cancellable: bool,
}

/// Server-initiated `workspace/diagnostic/refresh` notification for the
/// renderer. Pull diagnostics are otherwise only refreshed by the Problems
/// poller; forwarding this event keeps open-file squiggles and the project
/// Problems view in sync as soon as the server invalidates its report.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LspDiagnosticsRefreshEvent {
    pub(super) workspace_id: String,
    pub(super) preset_id: String,
    pub(super) root_uri: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LspExternalFileChangeEvent {
    pub(super) workspace_id: String,
    pub(super) path: String,
    #[serde(rename = "type")]
    pub(super) change_type: u8,
}

pub(super) struct LspClientRequestBridge {
    pub(super) app: OnceLock<AppHandle>,
    pub(super) pending_workspace_edits: StdMutex<HashMap<String, PendingWorkspaceApplyEdit>>,
    pub(super) pending_show_messages: StdMutex<HashMap<String, PendingShowMessageRequest>>,
    pub(super) next_request_id: AtomicU64,
}
