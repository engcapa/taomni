use serde::Deserialize;

// ---------------------------------------------------------------------------
// Tool parameter schemas
// ---------------------------------------------------------------------------

#[derive(Deserialize, schemars::JsonSchema, Default)]
pub(super) struct ListSessionsParams {
    /// Optional case-insensitive filter over session name / host.
    #[serde(default)]
    pub(super) query: Option<String>,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub(super) struct SearchHistoryParams {
    /// Substring to search command history for.
    pub(super) query: String,
}

#[derive(Deserialize, schemars::JsonSchema, serde::Serialize)]
pub(super) struct ReadTerminalTailParams {
    pub(super) session_id: Option<String>,
    #[serde(default)]
    pub(super) lines: Option<u32>,
    /// Must be true — only available when the user explicitly triggered a read.
    pub(super) user_invoked: bool,
}

#[derive(Deserialize, schemars::JsonSchema, serde::Serialize)]
pub(super) struct RunInTerminalParams {
    pub(super) session_id: Option<String>,
    pub(super) command: String,
}

#[derive(Deserialize, schemars::JsonSchema, serde::Serialize)]
pub(super) struct SwitchTabParams {
    /// Session id, name, or host fragment to switch to.
    pub(super) query: String,
}

#[derive(Deserialize, schemars::JsonSchema, serde::Serialize)]
pub(super) struct OpenSessionEditorParams {
    pub(super) name: Option<String>,
    pub(super) host: Option<String>,
    pub(super) username: Option<String>,
}

#[derive(Deserialize, schemars::JsonSchema, serde::Serialize)]
pub(super) struct SftpUploadParams {
    /// Optional; omitted calls target the thread's bound terminal/SFTP session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) session_id: Option<String>,
    /// Single local file or directory to upload. Use `local_paths` for batches.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) local_path: Option<String>,
    /// Multiple local files/directories uploaded into `remote_path`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(super) local_paths: Vec<String>,
    /// Remote directory, or a full destination path when uploading one item.
    pub(super) remote_path: String,
}

#[derive(Deserialize, schemars::JsonSchema, serde::Serialize)]
pub(super) struct SftpDownloadParams {
    pub(super) session_id: Option<String>,
    pub(super) remote_path: String,
    pub(super) local_dir: String,
}

#[derive(Deserialize, schemars::JsonSchema, serde::Serialize)]
pub(super) struct SaveAsRunbookParams {
    pub(super) name: String,
    pub(super) commands: Vec<String>,
}

#[derive(Deserialize, schemars::JsonSchema, serde::Serialize)]
pub(super) struct RunCapturedParams {
    /// Command to run on the bound session's host. Its full stdout+stderr are
    /// captured; only a summary is returned. Use read_capture to grep/page it.
    pub(super) command: String,
    /// false (default): run in an independent channel (clean output, divorced
    /// from interactive shell state, cwd bridged). true: run in the live
    /// interactive session (visible, full shell state) — C path.
    #[serde(default)]
    pub(super) reflect_session: bool,
    pub(super) session_id: Option<String>,
}

#[derive(Deserialize, schemars::JsonSchema, serde::Serialize, Clone)]
pub(super) struct ReadCaptureParams {
    pub(super) capture_id: String,
    /// One of: head | tail | range | grep | jq | stats.
    pub(super) op: String,
    /// head/tail: number of lines.
    pub(super) n: Option<u32>,
    /// range: 1-based inclusive bounds.
    pub(super) start: Option<u32>,
    pub(super) end: Option<u32>,
    /// grep: regex pattern + optional context lines.
    pub(super) pattern: Option<String>,
    pub(super) context: Option<u32>,
    /// jq: filter expression.
    pub(super) filter: Option<String>,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub(crate) struct PermissionParams {
    pub(crate) tool_name: String,
    // Claude Code's permission-prompt protocol sends the requested tool's input
    // under `input`. Accept `tool_input` as an alias for forward/back-compat.
    // Without this the field silently defaulted to `Null`, so we emitted
    // `args: null` to the UI and handed CC back `updatedInput: null`.
    #[serde(default, alias = "input")]
    pub(crate) tool_input: serde_json::Value,
}

pub(crate) fn as_value<T: serde::Serialize>(p: &T) -> serde_json::Value {
    serde_json::to_value(p).unwrap_or(serde_json::Value::Null)
}
