use crate::state::AppState;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{hash_map::DefaultHasher, HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::State;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::{oneshot, Mutex, RwLock};

const REQUEST_TIMEOUT_SECS: u64 = 8;
const INITIALIZE_TIMEOUT_SECS: u64 = 20;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspServerCommandPreset {
    pub id: String,
    pub label: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub install_hint: String,
    #[serde(default)]
    pub fallback: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspCustomServerCommand {
    #[serde(default)]
    pub label: Option<String>,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspServerPreset {
    pub id: String,
    pub display_name: String,
    pub document_language_ids: Vec<String>,
    pub file_extensions: Vec<String>,
    pub file_names: Vec<String>,
    pub commands: Vec<LspServerCommandPreset>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspServerCommandStatus {
    pub id: String,
    pub label: String,
    pub command: String,
    pub args: Vec<String>,
    pub install_hint: String,
    pub fallback: bool,
    pub available: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspServerStatus {
    pub preset_id: String,
    pub display_name: String,
    pub document_language_ids: Vec<String>,
    pub available: bool,
    pub active: bool,
    pub selected_command_id: Option<String>,
    pub selected_command: Option<String>,
    pub install_hint: String,
    pub error: Option<String>,
    pub commands: Vec<LspServerCommandStatus>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDocumentStatus {
    pub path: String,
    pub uri: String,
    pub preset_id: Option<String>,
    pub language_id: Option<String>,
    pub display_name: Option<String>,
    pub available: bool,
    pub active: bool,
    pub selected_command_id: Option<String>,
    pub selected_command: Option<String>,
    pub install_hint: Option<String>,
    pub error: Option<String>,
    /// Present only while a session is active for this document.
    #[serde(default)]
    pub capabilities: Option<LspCapabilitySummary>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspPosition {
    pub line: u32,
    pub character: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspRange {
    pub start: LspPosition,
    pub end: LspPosition,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDiagnostic {
    pub range: LspRange,
    pub severity: Option<u8>,
    pub code: Option<String>,
    pub source: Option<String>,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspLocation {
    pub uri: String,
    pub path: Option<String>,
    pub range: LspRange,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDiagnosticsResult {
    pub status: LspDocumentStatus,
    pub diagnostics: Vec<LspDiagnostic>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspHoverResult {
    pub status: LspDocumentStatus,
    pub contents: Option<String>,
    pub range: Option<LspRange>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspLocationsResult {
    pub status: LspDocumentStatus,
    pub locations: Vec<LspLocation>,
}

/// One entry of a flattened `textDocument/documentSymbol` tree; `depth`
/// preserves the hierarchy for indented rendering.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDocumentSymbol {
    pub name: String,
    pub detail: Option<String>,
    pub kind: u32,
    pub depth: u32,
    pub range: LspRange,
    pub selection_range: LspRange,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDocumentSymbolsResult {
    pub status: LspDocumentStatus,
    pub symbols: Vec<LspDocumentSymbol>,
}

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
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspWorkspaceSymbolsResult {
    pub status: LspDocumentStatus,
    pub symbols: Vec<LspWorkspaceSymbol>,
}

/// Feature summary distilled from the server's `initialize` response so the
/// UI can enable/disable entry points per capability instead of guessing.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspCapabilitySummary {
    pub completion: bool,
    pub signature_help: bool,
    pub hover: bool,
    pub definition: bool,
    pub type_definition: bool,
    pub implementation: bool,
    pub references: bool,
    pub document_symbol: bool,
    pub workspace_symbol: bool,
    pub rename: bool,
    pub formatting: bool,
    pub range_formatting: bool,
    pub code_action: bool,
    pub document_highlight: bool,
    pub call_hierarchy: bool,
    pub type_hierarchy: bool,
    pub inlay_hint: bool,
    pub completion_trigger_characters: Vec<String>,
    pub signature_trigger_characters: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspTextEdit {
    pub range: LspRange,
    pub new_text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspCompletionItem {
    pub label: String,
    pub kind: Option<u32>,
    pub detail: Option<String>,
    pub documentation: Option<String>,
    pub insert_text: Option<String>,
    /// 1 = plain text, 2 = snippet (`${1:placeholder}` syntax).
    pub insert_text_format: Option<u32>,
    pub filter_text: Option<String>,
    pub sort_text: Option<String>,
    pub text_edit: Option<LspTextEdit>,
    pub additional_text_edits: Vec<LspTextEdit>,
    /// Original server item, echoed back verbatim for `completionItem/resolve`.
    pub raw: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspCompletionResult {
    pub status: LspDocumentStatus,
    pub is_incomplete: bool,
    pub items: Vec<LspCompletionItem>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspSignatureParameter {
    pub label: String,
    pub documentation: Option<String>,
    /// Offsets into the signature label when the server sends `[start, end]`.
    pub label_start: Option<u32>,
    pub label_end: Option<u32>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspSignatureInfo {
    pub label: String,
    pub documentation: Option<String>,
    pub parameters: Vec<LspSignatureParameter>,
    pub active_parameter: Option<u32>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspSignatureHelpResult {
    pub status: LspDocumentStatus,
    pub signatures: Vec<LspSignatureInfo>,
    pub active_signature: u32,
    pub active_parameter: u32,
}

#[derive(Clone, Debug)]
struct DetectedLanguage {
    preset_id: String,
    language_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct LspSessionKey {
    workspace_id: String,
    preset_id: String,
    root_path: String,
    command_id: String,
}

impl LspSessionKey {
    fn map_key(&self) -> String {
        format!(
            "{}\n{}\n{}\n{}",
            self.workspace_id, self.preset_id, self.root_path, self.command_id
        )
    }
}

#[derive(Debug)]
struct PendingResponse {
    sender: oneshot::Sender<Result<Value, String>>,
}

pub struct LspManager {
    sessions: Mutex<HashMap<String, Arc<LspSession>>>,
}

struct LspSession {
    key: LspSessionKey,
    preset: LspServerPreset,
    command: LspServerCommandPreset,
    root_uri: String,
    stdin: Mutex<ChildStdin>,
    pending: Mutex<HashMap<u64, PendingResponse>>,
    opened_documents: RwLock<HashSet<String>>,
    diagnostics: RwLock<HashMap<String, Vec<LspDiagnostic>>>,
    capabilities: RwLock<Option<LspCapabilitySummary>>,
    next_id: AtomicU64,
    _child: Mutex<Child>,
}

struct ResolvedDocument {
    path: PathBuf,
    uri: String,
    root_path: PathBuf,
    root_uri: String,
    workspace_id: String,
    preset: Option<LspServerPreset>,
    language_id: Option<String>,
    version: i64,
}

impl LspManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    async fn document_status(
        &self,
        document: &ResolvedDocument,
        preferred_command_id: Option<&str>,
        custom_command: Option<&LspCustomServerCommand>,
    ) -> LspDocumentStatus {
        let Some(preset) = document.preset.as_ref() else {
            return LspDocumentStatus {
                path: document.path.to_string_lossy().into_owned(),
                uri: document.uri.clone(),
                preset_id: None,
                language_id: document.language_id.clone(),
                display_name: None,
                available: false,
                active: false,
                selected_command_id: None,
                selected_command: None,
                install_hint: None,
                error: Some("No language server preset for this file type".into()),
                capabilities: None,
            };
        };

        let configured_command = configured_command(preset, preferred_command_id, custom_command);
        let command = select_available_command(preset, preferred_command_id, custom_command);
        let selected_command_id = command
            .as_ref()
            .or(configured_command.as_ref())
            .map(|cmd| cmd.id.clone());
        let selected_command = command
            .as_ref()
            .or(configured_command.as_ref())
            .map(|cmd| command_line(&cmd.command, &cmd.args));
        let (active, capabilities) = if let Some(cmd) = command.as_ref() {
            let key = session_key(document, preset, cmd);
            match self.sessions.lock().await.get(&key.map_key()) {
                Some(session) => (true, session.capabilities.read().await.clone()),
                None => (false, None),
            }
        } else {
            (false, None)
        };
        let using_custom = custom_command_to_preset(custom_command).is_some();
        LspDocumentStatus {
            path: document.path.to_string_lossy().into_owned(),
            uri: document.uri.clone(),
            preset_id: Some(preset.id.clone()),
            language_id: document.language_id.clone(),
            display_name: Some(preset.display_name.clone()),
            available: command.is_some(),
            active,
            selected_command_id,
            selected_command,
            install_hint: if using_custom {
                Some("Check the custom language server command".into())
            } else {
                primary_install_hint(preset)
            },
            error: if command.is_some() {
                None
            } else if using_custom {
                Some(format!(
                    "Custom {} language server command is not available",
                    preset.display_name
                ))
            } else {
                Some(format!(
                    "{} language server is not installed",
                    preset.display_name
                ))
            },
            capabilities,
        }
    }

    async fn ensure_session(
        &self,
        document: &ResolvedDocument,
        preferred_command_id: Option<&str>,
        custom_command: Option<&LspCustomServerCommand>,
    ) -> Result<Arc<LspSession>, LspDocumentStatus> {
        let Some(preset) = document.preset.as_ref() else {
            return Err(self
                .document_status(document, preferred_command_id, custom_command)
                .await);
        };
        let Some(command) = select_available_command(preset, preferred_command_id, custom_command)
        else {
            return Err(self
                .document_status(document, preferred_command_id, custom_command)
                .await);
        };
        let key = session_key(document, preset, &command);
        let map_key = key.map_key();
        {
            let sessions = self.sessions.lock().await;
            if let Some(existing) = sessions.get(&map_key) {
                return Ok(existing.clone());
            }
        }

        let session = match LspSession::spawn(
            key.clone(),
            preset.clone(),
            command.clone(),
            document.root_path.clone(),
            document.root_uri.clone(),
        )
        .await
        {
            Ok(session) => session,
            Err(error) => {
                return Err(LspDocumentStatus {
                    path: document.path.to_string_lossy().into_owned(),
                    uri: document.uri.clone(),
                    preset_id: Some(preset.id.clone()),
                    language_id: document.language_id.clone(),
                    display_name: Some(preset.display_name.clone()),
                    available: true,
                    active: false,
                    selected_command_id: Some(command.id.clone()),
                    selected_command: Some(command_line(&command.command, &command.args)),
                    install_hint: Some(command.install_hint.clone()),
                    error: Some(error),
                    capabilities: None,
                });
            }
        };
        let mut sessions = self.sessions.lock().await;
        let entry = sessions.entry(map_key).or_insert_with(|| session.clone());
        Ok(entry.clone())
    }

    async fn active_session(
        &self,
        document: &ResolvedDocument,
        preferred_command_id: Option<&str>,
        custom_command: Option<&LspCustomServerCommand>,
    ) -> Option<Arc<LspSession>> {
        let preset = document.preset.as_ref()?;
        let command = select_available_command(preset, preferred_command_id, custom_command)?;
        let key = session_key(document, preset, &command);
        self.sessions.lock().await.get(&key.map_key()).cloned()
    }
}

impl LspSession {
    async fn spawn(
        key: LspSessionKey,
        preset: LspServerPreset,
        command: LspServerCommandPreset,
        root_path: PathBuf,
        root_uri: String,
    ) -> Result<Arc<Self>, String> {
        let mut child = Command::new(&command.command)
            .args(&command.args)
            .current_dir(&root_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("spawn {}: {e}", command.command))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| format!("{} did not expose stdin", command.command))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| format!("{} did not expose stdout", command.command))?;
        let stderr = child.stderr.take();

        let session = Arc::new(Self {
            key,
            preset,
            command,
            root_uri,
            stdin: Mutex::new(stdin),
            pending: Mutex::new(HashMap::new()),
            opened_documents: RwLock::new(HashSet::new()),
            diagnostics: RwLock::new(HashMap::new()),
            capabilities: RwLock::new(None),
            next_id: AtomicU64::new(1),
            _child: Mutex::new(child),
        });

        tokio::spawn(read_stdout(session.clone(), stdout));
        if let Some(stderr) = stderr {
            tokio::spawn(read_stderr(session.command.command.clone(), stderr));
        }

        let initialize_params = json!({
            "processId": Value::Null,
            "rootUri": session.root_uri,
            "workspaceFolders": [{
                "uri": session.root_uri,
                "name": root_path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("workspace")
            }],
            "capabilities": {
                "textDocument": {
                    "synchronization": {
                        "dynamicRegistration": false,
                        "didSave": true
                    },
                    "hover": {
                        "contentFormat": ["markdown", "plaintext"]
                    },
                    "definition": {
                        "linkSupport": true
                    },
                    "references": {
                        "dynamicRegistration": false
                    },
                    "completion": {
                        "dynamicRegistration": false,
                        "contextSupport": true,
                        "completionItem": {
                            "snippetSupport": true,
                            "insertReplaceSupport": true,
                            "documentationFormat": ["markdown", "plaintext"],
                            "resolveSupport": {
                                "properties": ["documentation", "detail", "additionalTextEdits"]
                            }
                        },
                        "completionItemKind": {
                            "valueSet": (1..=25u32).collect::<Vec<_>>()
                        }
                    },
                    "signatureHelp": {
                        "contextSupport": true,
                        "signatureInformation": {
                            "documentationFormat": ["markdown", "plaintext"],
                            "parameterInformation": { "labelOffsetSupport": true },
                            "activeParameterSupport": true
                        }
                    },
                    "documentSymbol": {
                        "hierarchicalDocumentSymbolSupport": true
                    },
                    "publishDiagnostics": {
                        "relatedInformation": true,
                        "versionSupport": true
                    }
                },
                "workspace": {
                    "workspaceFolders": true,
                    "configuration": false
                }
            }
        });
        let initialize_result = session
            .request_with_timeout("initialize", initialize_params, INITIALIZE_TIMEOUT_SECS)
            .await?;
        *session.capabilities.write().await = initialize_result
            .get("capabilities")
            .map(capability_summary_from);
        session.notify("initialized", json!({})).await?;
        Ok(session)
    }

    async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        let payload = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        });
        self.write_message(&payload).await
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        self.request_with_timeout(method, params, REQUEST_TIMEOUT_SECS)
            .await
    }

    async fn request_with_timeout(
        &self,
        method: &str,
        params: Value,
        timeout_secs: u64,
    ) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (sender, receiver) = oneshot::channel();
        self.pending
            .lock()
            .await
            .insert(id, PendingResponse { sender });
        let payload = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        });
        if let Err(error) = self.write_message(&payload).await {
            self.pending.lock().await.remove(&id);
            return Err(error);
        }
        match tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(format!("language server closed request {method}")),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(format!("language server request timed out: {method}"))
            }
        }
    }

    async fn write_message(&self, payload: &Value) -> Result<(), String> {
        let body =
            serde_json::to_vec(payload).map_err(|e| format!("serialize LSP message: {e}"))?;
        let header = format!("Content-Length: {}\r\n\r\n", body.len());
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(header.as_bytes())
            .await
            .map_err(|e| format!("write LSP header: {e}"))?;
        stdin
            .write_all(&body)
            .await
            .map_err(|e| format!("write LSP body: {e}"))?;
        stdin
            .flush()
            .await
            .map_err(|e| format!("flush LSP message: {e}"))
    }

    async fn handle_message(&self, message: Value) {
        if let Some(id) = message.get("id").and_then(message_id) {
            if message.get("method").is_none() {
                let pending = self.pending.lock().await.remove(&id);
                if let Some(pending) = pending {
                    let response = if let Some(error) = message.get("error") {
                        Err(error
                            .get("message")
                            .and_then(Value::as_str)
                            .map(ToString::to_string)
                            .unwrap_or_else(|| error.to_string()))
                    } else {
                        Ok(message.get("result").cloned().unwrap_or(Value::Null))
                    };
                    let _ = pending.sender.send(response);
                }
                return;
            }
        }

        let Some(method) = message.get("method").and_then(Value::as_str) else {
            return;
        };
        if method == "textDocument/publishDiagnostics" {
            let Some(params) = message.get("params") else {
                return;
            };
            let Some(uri) = params.get("uri").and_then(Value::as_str) else {
                return;
            };
            let diagnostics = params
                .get("diagnostics")
                .and_then(Value::as_array)
                .map(|items| items.iter().filter_map(parse_diagnostic).collect())
                .unwrap_or_default();
            self.diagnostics
                .write()
                .await
                .insert(uri.to_string(), diagnostics);
        }
    }
}

async fn read_stdout(session: Arc<LspSession>, stdout: ChildStdout) {
    let mut reader = BufReader::new(stdout);
    loop {
        let mut content_length = None;
        loop {
            let mut line = Vec::new();
            match reader.read_until(b'\n', &mut line).await {
                Ok(0) => return,
                Ok(_) => {
                    if line == b"\r\n" || line == b"\n" {
                        break;
                    }
                    if let Ok(header) = std::str::from_utf8(&line) {
                        let trimmed = header.trim();
                        if let Some(value) = trimmed.strip_prefix("Content-Length:") {
                            content_length = value.trim().parse::<usize>().ok();
                        }
                    }
                }
                Err(e) => {
                    log::warn!(
                        "lsp: stdout read failed for {}: {e}",
                        session.command.command
                    );
                    return;
                }
            }
        }
        let Some(len) = content_length else {
            log::warn!(
                "lsp: missing Content-Length from {}",
                session.command.command
            );
            return;
        };
        let mut body = vec![0u8; len];
        if let Err(e) = reader.read_exact(&mut body).await {
            log::warn!("lsp: body read failed for {}: {e}", session.command.command);
            return;
        }
        match serde_json::from_slice::<Value>(&body) {
            Ok(message) => session.handle_message(message).await,
            Err(e) => log::warn!("lsp: invalid JSON from {}: {e}", session.command.command),
        }
    }
}

async fn read_stderr(command: String, stderr: ChildStderr) {
    let mut lines = BufReader::new(stderr).lines();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => log::debug!("lsp:{command}: {line}"),
            Ok(None) => return,
            Err(e) => {
                log::debug!("lsp:{command}: stderr read failed: {e}");
                return;
            }
        }
    }
}

#[tauri::command]
pub fn lsp_list_presets() -> Vec<LspServerPreset> {
    lsp_presets()
}

#[tauri::command]
pub fn lsp_detect_servers() -> Vec<LspServerStatus> {
    lsp_presets()
        .iter()
        .map(|preset| server_status(preset, None, false, None))
        .collect()
}

#[tauri::command]
pub async fn lsp_document_status(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspDocumentStatus, String> {
    let document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    Ok(state
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await)
}

#[tauri::command]
pub async fn lsp_open_document(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    text: String,
    version: i64,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspDocumentStatus, String> {
    let document = resolve_document(workspace_id, root_path, file_path, language_id, version)?;
    let session = match state
        .lsp
        .ensure_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
    {
        Ok(session) => session,
        Err(status) => return Ok(status),
    };
    let language_id = document.language_id.as_deref().unwrap_or("plaintext");
    session
        .notify(
            "textDocument/didOpen",
            json!({
                "textDocument": {
                    "uri": document.uri,
                    "languageId": language_id,
                    "version": document.version,
                    "text": text
                }
            }),
        )
        .await
        .map_err(|e| format!("LSP didOpen failed: {e}"))?;
    session
        .opened_documents
        .write()
        .await
        .insert(document.uri.clone());
    Ok(state
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await)
}

#[tauri::command]
pub async fn lsp_change_document(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    text: String,
    version: i64,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspDocumentStatus, String> {
    let document = resolve_document(workspace_id, root_path, file_path, language_id, version)?;
    let Some(session) = state
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
    else {
        return lsp_open_document(
            state,
            document.workspace_id.clone(),
            Some(document.root_path.to_string_lossy().into_owned()),
            document.path.to_string_lossy().into_owned(),
            text,
            version,
            document.language_id.clone(),
            server_command_id,
            custom_server_command,
        )
        .await;
    };
    if !session
        .opened_documents
        .read()
        .await
        .contains(&document.uri)
    {
        let language_id = document.language_id.as_deref().unwrap_or("plaintext");
        session
            .notify(
                "textDocument/didOpen",
                json!({
                    "textDocument": {
                        "uri": document.uri,
                        "languageId": language_id,
                        "version": document.version,
                        "text": text
                    }
                }),
            )
            .await
            .map_err(|e| format!("LSP didOpen failed: {e}"))?;
        session
            .opened_documents
            .write()
            .await
            .insert(document.uri.clone());
        return Ok(state
            .lsp
            .document_status(
                &document,
                server_command_id.as_deref(),
                custom_server_command.as_ref(),
            )
            .await);
    }
    session
        .notify(
            "textDocument/didChange",
            json!({
                "textDocument": {
                    "uri": document.uri,
                    "version": document.version
                },
                "contentChanges": [{ "text": text }]
            }),
        )
        .await
        .map_err(|e| format!("LSP didChange failed: {e}"))?;
    Ok(state
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await)
}

#[tauri::command]
pub async fn lsp_save_document(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    text: Option<String>,
    version: i64,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspDocumentStatus, String> {
    let document = resolve_document(workspace_id, root_path, file_path, language_id, version)?;
    if let Some(session) = state
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
    {
        let mut params = json!({
            "textDocument": { "uri": document.uri }
        });
        if let Some(text) = text {
            params["text"] = Value::String(text);
        }
        session
            .notify("textDocument/didSave", params)
            .await
            .map_err(|e| format!("LSP didSave failed: {e}"))?;
    }
    Ok(state
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await)
}

#[tauri::command]
pub async fn lsp_close_document(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspDocumentStatus, String> {
    let document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    if let Some(session) = state
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
    {
        session
            .notify(
                "textDocument/didClose",
                json!({ "textDocument": { "uri": document.uri } }),
            )
            .await
            .map_err(|e| format!("LSP didClose failed: {e}"))?;
        session.opened_documents.write().await.remove(&document.uri);
        session.diagnostics.write().await.remove(&document.uri);
    }
    Ok(state
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await)
}

#[tauri::command]
pub async fn lsp_get_diagnostics(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspDiagnosticsResult, String> {
    let document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    let diagnostics = match state
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
    {
        Some(session) => session
            .diagnostics
            .read()
            .await
            .get(&document.uri)
            .cloned()
            .unwrap_or_default(),
        None => Vec::new(),
    };
    let status = state
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await;
    Ok(LspDiagnosticsResult {
        status,
        diagnostics,
    })
}

#[tauri::command]
pub async fn lsp_hover(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    line: u32,
    character: u32,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspHoverResult, String> {
    let document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    let session = match state
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
    {
        Some(session) => session,
        None => {
            let status = state
                .lsp
                .document_status(
                    &document,
                    server_command_id.as_deref(),
                    custom_server_command.as_ref(),
                )
                .await;
            return Ok(LspHoverResult {
                status,
                contents: None,
                range: None,
            });
        }
    };
    let result = session
        .request(
            "textDocument/hover",
            json!({
                "textDocument": { "uri": document.uri },
                "position": { "line": line, "character": character }
            }),
        )
        .await
        .unwrap_or(Value::Null);
    let status = state
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await;
    Ok(LspHoverResult {
        status,
        contents: hover_contents(&result),
        range: result.get("range").and_then(parse_range),
    })
}

#[tauri::command]
pub async fn lsp_definition(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    line: u32,
    character: u32,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspLocationsResult, String> {
    lsp_location_request(
        state,
        workspace_id,
        root_path,
        file_path,
        line,
        character,
        language_id,
        server_command_id,
        custom_server_command,
        "textDocument/definition",
        json!({}),
    )
    .await
}

#[tauri::command]
pub async fn lsp_references(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    line: u32,
    character: u32,
    include_declaration: Option<bool>,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspLocationsResult, String> {
    lsp_location_request(
        state,
        workspace_id,
        root_path,
        file_path,
        line,
        character,
        language_id,
        server_command_id,
        custom_server_command,
        "textDocument/references",
        json!({
            "context": {
                "includeDeclaration": include_declaration.unwrap_or(true)
            }
        }),
    )
    .await
}

async fn lsp_location_request(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    line: u32,
    character: u32,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
    method: &str,
    mut extra: Value,
) -> Result<LspLocationsResult, String> {
    let document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    let session = match state
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
    {
        Some(session) => session,
        None => {
            let status = state
                .lsp
                .document_status(
                    &document,
                    server_command_id.as_deref(),
                    custom_server_command.as_ref(),
                )
                .await;
            return Ok(LspLocationsResult {
                status,
                locations: Vec::new(),
            });
        }
    };
    extra["textDocument"] = json!({ "uri": document.uri });
    extra["position"] = json!({ "line": line, "character": character });
    let result = session.request(method, extra).await.unwrap_or(Value::Null);
    let status = state
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await;
    Ok(LspLocationsResult {
        status,
        locations: parse_locations(&result),
    })
}

#[tauri::command]
pub async fn lsp_document_symbols(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspDocumentSymbolsResult, String> {
    let document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    let session = match state
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
    {
        Some(session) => session,
        None => {
            let status = state
                .lsp
                .document_status(
                    &document,
                    server_command_id.as_deref(),
                    custom_server_command.as_ref(),
                )
                .await;
            return Ok(LspDocumentSymbolsResult {
                status,
                symbols: Vec::new(),
            });
        }
    };
    let result = session
        .request(
            "textDocument/documentSymbol",
            json!({ "textDocument": { "uri": document.uri } }),
        )
        .await
        .unwrap_or(Value::Null);
    let status = state
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await;
    let mut symbols = Vec::new();
    collect_document_symbols(&result, 0, &mut symbols);
    Ok(LspDocumentSymbolsResult { status, symbols })
}

#[tauri::command]
pub async fn lsp_completion(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    line: u32,
    character: u32,
    trigger_character: Option<String>,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspCompletionResult, String> {
    let document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    let session = match state
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
    {
        Some(session) => session,
        None => {
            let status = state
                .lsp
                .document_status(
                    &document,
                    server_command_id.as_deref(),
                    custom_server_command.as_ref(),
                )
                .await;
            return Ok(LspCompletionResult {
                status,
                is_incomplete: false,
                items: Vec::new(),
            });
        }
    };
    let context = match trigger_character.as_deref().filter(|c| !c.is_empty()) {
        Some(character) => json!({ "triggerKind": 2, "triggerCharacter": character }),
        None => json!({ "triggerKind": 1 }),
    };
    let result = session
        .request(
            "textDocument/completion",
            json!({
                "textDocument": { "uri": document.uri },
                "position": { "line": line, "character": character },
                "context": context,
            }),
        )
        .await
        .unwrap_or(Value::Null);
    let status = state
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await;
    let (is_incomplete, items) = parse_completion_response(&result);
    Ok(LspCompletionResult {
        status,
        is_incomplete,
        items,
    })
}

#[tauri::command]
pub async fn lsp_completion_resolve(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    item: Value,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<Option<LspCompletionItem>, String> {
    let document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    let Some(session) = state
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
    else {
        return Ok(None);
    };
    let resolved = session
        .request("completionItem/resolve", item.clone())
        .await
        .unwrap_or(Value::Null);
    // Servers without resolve support may error or return null; fall back to
    // the original item so callers always get something applicable.
    Ok(parse_completion_item(&resolved).or_else(|| parse_completion_item(&item)))
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspFormattingResult {
    pub status: LspDocumentStatus,
    pub edits: Vec<LspTextEdit>,
}

/// One file's worth of TextEdits from a WorkspaceEdit.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspFileTextEdits {
    pub uri: String,
    pub path: Option<String>,
    pub edits: Vec<LspTextEdit>,
}

/// Normalized workspace edit for clients (rename / code actions / replace).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspWorkspaceEdit {
    pub document_edits: Vec<LspFileTextEdits>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspCodeAction {
    pub title: String,
    pub kind: Option<String>,
    pub is_preferred: bool,
    pub edit: Option<LspWorkspaceEdit>,
    pub command: Option<String>,
    pub command_arguments: Option<Value>,
    /// Original server action for executeCommand / resolve.
    pub raw: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspCodeActionsResult {
    pub status: LspDocumentStatus,
    pub actions: Vec<LspCodeAction>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspPrepareRenameResult {
    pub status: LspDocumentStatus,
    pub range: Option<LspRange>,
    pub placeholder: Option<String>,
    pub allowed: bool,
    pub message: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspRenameResult {
    pub status: LspDocumentStatus,
    pub edit: LspWorkspaceEdit,
}

#[tauri::command]
pub async fn lsp_prepare_rename(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    line: u32,
    character: u32,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspPrepareRenameResult, String> {
    let document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    let session = match state
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
    {
        Some(session) => session,
        None => {
            let status = state
                .lsp
                .document_status(
                    &document,
                    server_command_id.as_deref(),
                    custom_server_command.as_ref(),
                )
                .await;
            return Ok(LspPrepareRenameResult {
                status,
                range: None,
                placeholder: None,
                allowed: false,
                message: Some("Language server is not active".into()),
            });
        }
    };
    let result = session
        .request(
            "textDocument/prepareRename",
            json!({
                "textDocument": { "uri": document.uri },
                "position": { "line": line, "character": character },
            }),
        )
        .await;
    let status = state
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await;
    match result {
        Ok(Value::Null) | Err(_) => Ok(LspPrepareRenameResult {
            status,
            range: None,
            placeholder: None,
            allowed: false,
            message: Some("Rename is not available at this position".into()),
        }),
        Ok(value) => {
            // Range | { range, placeholder } | { defaultBehavior: true }
            if value.get("defaultBehavior").and_then(Value::as_bool) == Some(true) {
                return Ok(LspPrepareRenameResult {
                    status,
                    range: None,
                    placeholder: None,
                    allowed: true,
                    message: None,
                });
            }
            let range = value
                .get("range")
                .and_then(parse_range)
                .or_else(|| parse_range(&value));
            let placeholder = value
                .get("placeholder")
                .and_then(Value::as_str)
                .map(ToString::to_string);
            let allowed = range.is_some() || placeholder.is_some();
            Ok(LspPrepareRenameResult {
                status,
                range,
                placeholder,
                allowed,
                message: None,
            })
        }
    }
}

#[tauri::command]
pub async fn lsp_rename(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    line: u32,
    character: u32,
    new_name: String,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspRenameResult, String> {
    let document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    let session = match state
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
    {
        Some(session) => session,
        None => {
            let status = state
                .lsp
                .document_status(
                    &document,
                    server_command_id.as_deref(),
                    custom_server_command.as_ref(),
                )
                .await;
            return Ok(LspRenameResult {
                status,
                edit: LspWorkspaceEdit::default(),
            });
        }
    };
    let result = session
        .request(
            "textDocument/rename",
            json!({
                "textDocument": { "uri": document.uri },
                "position": { "line": line, "character": character },
                "newName": new_name,
            }),
        )
        .await
        .unwrap_or(Value::Null);
    let status = state
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await;
    Ok(LspRenameResult {
        status,
        edit: parse_workspace_edit(&result),
    })
}

#[tauri::command]
pub async fn lsp_type_definition(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    line: u32,
    character: u32,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspLocationsResult, String> {
    lsp_location_request(
        state,
        workspace_id,
        root_path,
        file_path,
        line,
        character,
        language_id,
        server_command_id,
        custom_server_command,
        "textDocument/typeDefinition",
        json!({}),
    )
    .await
}

#[tauri::command]
pub async fn lsp_implementation(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    line: u32,
    character: u32,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspLocationsResult, String> {
    lsp_location_request(
        state,
        workspace_id,
        root_path,
        file_path,
        line,
        character,
        language_id,
        server_command_id,
        custom_server_command,
        "textDocument/implementation",
        json!({}),
    )
    .await
}

#[tauri::command]
pub async fn lsp_workspace_symbols(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    query: String,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspWorkspaceSymbolsResult, String> {
    // Any open document under the workspace is enough to resolve the active
    // language server session for workspace/symbol.
    let document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    let session = match state
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
    {
        Some(session) => session,
        None => {
            let status = state
                .lsp
                .document_status(
                    &document,
                    server_command_id.as_deref(),
                    custom_server_command.as_ref(),
                )
                .await;
            return Ok(LspWorkspaceSymbolsResult {
                status,
                symbols: Vec::new(),
            });
        }
    };
    let result = session
        .request(
            "workspace/symbol",
            json!({ "query": query }),
        )
        .await
        .unwrap_or(Value::Null);
    let status = state
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await;
    Ok(LspWorkspaceSymbolsResult {
        status,
        symbols: parse_workspace_symbols(&result),
    })
}

#[tauri::command]
pub async fn lsp_code_actions(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    start_line: u32,
    start_character: u32,
    end_line: u32,
    end_character: u32,
    diagnostics: Option<Vec<Value>>,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspCodeActionsResult, String> {
    let document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    let session = match state
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
    {
        Some(session) => session,
        None => {
            let status = state
                .lsp
                .document_status(
                    &document,
                    server_command_id.as_deref(),
                    custom_server_command.as_ref(),
                )
                .await;
            return Ok(LspCodeActionsResult {
                status,
                actions: Vec::new(),
            });
        }
    };
    let result = session
        .request(
            "textDocument/codeAction",
            json!({
                "textDocument": { "uri": document.uri },
                "range": {
                    "start": { "line": start_line, "character": start_character },
                    "end": { "line": end_line, "character": end_character },
                },
                "context": {
                    "diagnostics": diagnostics.unwrap_or_default(),
                    "only": null,
                    "triggerKind": 1,
                },
            }),
        )
        .await
        .unwrap_or(Value::Null);
    let status = state
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await;
    Ok(LspCodeActionsResult {
        status,
        actions: parse_code_actions(&result),
    })
}

#[tauri::command]
pub async fn lsp_formatting(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
    tab_size: Option<u32>,
    insert_spaces: Option<bool>,
) -> Result<LspFormattingResult, String> {
    let document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    let session = match state
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
    {
        Some(session) => session,
        None => {
            let status = state
                .lsp
                .document_status(
                    &document,
                    server_command_id.as_deref(),
                    custom_server_command.as_ref(),
                )
                .await;
            return Ok(LspFormattingResult {
                status,
                edits: Vec::new(),
            });
        }
    };
    let result = session
        .request(
            "textDocument/formatting",
            json!({
                "textDocument": { "uri": document.uri },
                "options": {
                    "tabSize": tab_size.unwrap_or(2),
                    "insertSpaces": insert_spaces.unwrap_or(true),
                },
            }),
        )
        .await
        .unwrap_or(Value::Null);
    let status = state
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await;
    Ok(LspFormattingResult {
        status,
        edits: parse_text_edits(&result),
    })
}

#[tauri::command]
pub async fn lsp_range_formatting(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    start_line: u32,
    start_character: u32,
    end_line: u32,
    end_character: u32,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
    tab_size: Option<u32>,
    insert_spaces: Option<bool>,
) -> Result<LspFormattingResult, String> {
    let document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    let session = match state
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
    {
        Some(session) => session,
        None => {
            let status = state
                .lsp
                .document_status(
                    &document,
                    server_command_id.as_deref(),
                    custom_server_command.as_ref(),
                )
                .await;
            return Ok(LspFormattingResult {
                status,
                edits: Vec::new(),
            });
        }
    };
    let result = session
        .request(
            "textDocument/rangeFormatting",
            json!({
                "textDocument": { "uri": document.uri },
                "range": {
                    "start": { "line": start_line, "character": start_character },
                    "end": { "line": end_line, "character": end_character },
                },
                "options": {
                    "tabSize": tab_size.unwrap_or(2),
                    "insertSpaces": insert_spaces.unwrap_or(true),
                },
            }),
        )
        .await
        .unwrap_or(Value::Null);
    let status = state
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await;
    Ok(LspFormattingResult {
        status,
        edits: parse_text_edits(&result),
    })
}

#[tauri::command]
pub async fn lsp_signature_help(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    line: u32,
    character: u32,
    trigger_character: Option<String>,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspSignatureHelpResult, String> {
    let document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    let session = match state
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
    {
        Some(session) => session,
        None => {
            let status = state
                .lsp
                .document_status(
                    &document,
                    server_command_id.as_deref(),
                    custom_server_command.as_ref(),
                )
                .await;
            return Ok(LspSignatureHelpResult {
                status,
                signatures: Vec::new(),
                active_signature: 0,
                active_parameter: 0,
            });
        }
    };
    let context = match trigger_character.as_deref().filter(|c| !c.is_empty()) {
        Some(character) => json!({
            "triggerKind": 2,
            "triggerCharacter": character,
            "isRetrigger": false,
        }),
        None => json!({ "triggerKind": 1, "isRetrigger": false }),
    };
    let result = session
        .request(
            "textDocument/signatureHelp",
            json!({
                "textDocument": { "uri": document.uri },
                "position": { "line": line, "character": character },
                "context": context,
            }),
        )
        .await
        .unwrap_or(Value::Null);
    let status = state
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await;
    let (signatures, active_signature, active_parameter) = parse_signature_help(&result);
    Ok(LspSignatureHelpResult {
        status,
        signatures,
        active_signature,
        active_parameter,
    })
}

fn resolve_document(
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    language_id: Option<String>,
    version: i64,
) -> Result<ResolvedDocument, String> {
    let trimmed_workspace = workspace_id.trim();
    let workspace_id = if trimmed_workspace.is_empty() {
        "default".to_string()
    } else {
        trimmed_workspace.to_string()
    };
    let path = resolve_file_path(root_path.as_deref(), &file_path)?;
    let root_path = resolve_root_path(root_path.as_deref(), &path)?;
    let uri = url::Url::from_file_path(&path)
        .map_err(|_| format!("Cannot convert path to file URI: {}", path.display()))?
        .to_string();
    let root_uri = url::Url::from_directory_path(&root_path)
        .map_err(|_| format!("Cannot convert root to file URI: {}", root_path.display()))?
        .to_string();
    let detected = language_id
        .as_deref()
        .and_then(detect_language_id)
        .or_else(|| detect_language_for_path(&path));
    let preset = detected
        .as_ref()
        .and_then(|detected| find_preset(&detected.preset_id));
    Ok(ResolvedDocument {
        path,
        uri,
        root_path,
        root_uri,
        workspace_id,
        preset,
        language_id: detected.map(|detected| detected.language_id),
        version,
    })
}

fn resolve_file_path(root_path: Option<&str>, file_path: &str) -> Result<PathBuf, String> {
    let file = Path::new(file_path);
    let path = if file.is_absolute() {
        file.to_path_buf()
    } else if let Some(root) = root_path.map(str::trim).filter(|root| !root.is_empty()) {
        Path::new(root).join(file)
    } else {
        file.to_path_buf()
    };
    Ok(path)
}

fn resolve_root_path(root_path: Option<&str>, file_path: &Path) -> Result<PathBuf, String> {
    if let Some(root) = root_path.map(str::trim).filter(|root| !root.is_empty()) {
        return Ok(PathBuf::from(root));
    }
    file_path.parent().map(Path::to_path_buf).ok_or_else(|| {
        format!(
            "Cannot resolve parent directory for {}",
            file_path.display()
        )
    })
}

fn session_key(
    document: &ResolvedDocument,
    preset: &LspServerPreset,
    command: &LspServerCommandPreset,
) -> LspSessionKey {
    LspSessionKey {
        workspace_id: document.workspace_id.clone(),
        preset_id: preset.id.clone(),
        root_path: document.root_path.to_string_lossy().into_owned(),
        command_id: command.id.clone(),
    }
}

fn server_status(
    preset: &LspServerPreset,
    preferred_command_id: Option<&str>,
    active: bool,
    error: Option<String>,
) -> LspServerStatus {
    let command = select_available_command(preset, preferred_command_id, None);
    LspServerStatus {
        preset_id: preset.id.clone(),
        display_name: preset.display_name.clone(),
        document_language_ids: preset.document_language_ids.clone(),
        available: command.is_some(),
        active,
        selected_command_id: command.as_ref().map(|cmd| cmd.id.clone()),
        selected_command: command
            .as_ref()
            .map(|cmd| command_line(&cmd.command, &cmd.args)),
        install_hint: primary_install_hint(preset).unwrap_or_default(),
        error,
        commands: preset
            .commands
            .iter()
            .map(|cmd| LspServerCommandStatus {
                id: cmd.id.clone(),
                label: cmd.label.clone(),
                command: cmd.command.clone(),
                args: cmd.args.clone(),
                install_hint: cmd.install_hint.clone(),
                fallback: cmd.fallback,
                available: command_available(&cmd.command),
            })
            .collect(),
    }
}

fn primary_install_hint(preset: &LspServerPreset) -> Option<String> {
    preset
        .commands
        .iter()
        .find(|cmd| !cmd.fallback)
        .or_else(|| preset.commands.first())
        .map(|cmd| cmd.install_hint.clone())
}

fn select_available_command(
    preset: &LspServerPreset,
    preferred_command_id: Option<&str>,
    custom_command: Option<&LspCustomServerCommand>,
) -> Option<LspServerCommandPreset> {
    if let Some(command) = custom_command_to_preset(custom_command) {
        return command_available(&command.command).then_some(command);
    }
    if let Some(preferred) = preferred_command_id
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        if let Some(command) = preset
            .commands
            .iter()
            .find(|cmd| cmd.id == preferred && command_available(&cmd.command))
        {
            return Some(command.clone());
        }
    }
    preset
        .commands
        .iter()
        .find(|cmd| command_available(&cmd.command))
        .cloned()
}

fn configured_command(
    preset: &LspServerPreset,
    preferred_command_id: Option<&str>,
    custom_command: Option<&LspCustomServerCommand>,
) -> Option<LspServerCommandPreset> {
    if let Some(command) = custom_command_to_preset(custom_command) {
        return Some(command);
    }
    if let Some(preferred) = preferred_command_id
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        if let Some(command) = preset.commands.iter().find(|cmd| cmd.id == preferred) {
            return Some(command.clone());
        }
    }
    preset.commands.first().cloned()
}

fn custom_command_to_preset(
    custom_command: Option<&LspCustomServerCommand>,
) -> Option<LspServerCommandPreset> {
    let custom = custom_command?;
    let command = custom.command.trim();
    if command.is_empty() {
        return None;
    }
    let args: Vec<String> = custom
        .args
        .iter()
        .map(|arg| arg.trim())
        .filter(|arg| !arg.is_empty())
        .map(ToString::to_string)
        .collect();
    let mut hasher = DefaultHasher::new();
    command.hash(&mut hasher);
    args.hash(&mut hasher);
    let id = format!("custom-{:x}", hasher.finish());
    let label = custom
        .label
        .as_deref()
        .map(str::trim)
        .filter(|label| !label.is_empty())
        .unwrap_or("Custom")
        .to_string();
    Some(LspServerCommandPreset {
        id,
        label,
        command: command.to_string(),
        args,
        install_hint: "Check the custom language server command".into(),
        fallback: false,
    })
}

fn command_available(command: &str) -> bool {
    let command = command.trim();
    if command.is_empty() {
        return false;
    }
    let path = Path::new(command);
    if path.is_absolute() || command.contains('/') || command.contains('\\') {
        return path.is_file();
    }
    which::which(command).is_ok()
}

fn command_line(command: &str, args: &[String]) -> String {
    if args.is_empty() {
        command.to_string()
    } else {
        format!("{} {}", command, args.join(" "))
    }
}

fn message_id(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_str().and_then(|id| id.parse::<u64>().ok()))
}

fn parse_position(value: &Value) -> Option<LspPosition> {
    Some(LspPosition {
        line: value.get("line")?.as_u64()?.try_into().ok()?,
        character: value.get("character")?.as_u64()?.try_into().ok()?,
    })
}

fn parse_range(value: &Value) -> Option<LspRange> {
    Some(LspRange {
        start: parse_position(value.get("start")?)?,
        end: parse_position(value.get("end")?)?,
    })
}

fn parse_diagnostic(value: &Value) -> Option<LspDiagnostic> {
    Some(LspDiagnostic {
        range: parse_range(value.get("range")?)?,
        severity: value
            .get("severity")
            .and_then(Value::as_u64)
            .and_then(|severity| severity.try_into().ok()),
        code: value.get("code").and_then(|code| {
            code.as_str()
                .map(ToString::to_string)
                .or_else(|| code.as_i64().map(|number| number.to_string()))
        }),
        source: value
            .get("source")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        message: value.get("message")?.as_str()?.to_string(),
    })
}

fn hover_contents(value: &Value) -> Option<String> {
    let contents = value.get("contents")?;
    markup_to_string(contents)
}

fn markup_to_string(value: &Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        return Some(text.to_string());
    }
    if let Some(array) = value.as_array() {
        let parts = array
            .iter()
            .filter_map(markup_to_string)
            .collect::<Vec<_>>();
        return if parts.is_empty() {
            None
        } else {
            Some(parts.join("\n\n"))
        };
    }
    if let Some(text) = value.get("value").and_then(Value::as_str) {
        return Some(text.to_string());
    }
    if let Some(text) = value.get("language").and_then(Value::as_str) {
        let value = value.get("value").and_then(Value::as_str).unwrap_or("");
        return Some(format!("```{text}\n{value}\n```"));
    }
    None
}

/// A provider capability may be `true`, an options object, or absent/false.
fn has_provider(capabilities: &Value, key: &str) -> bool {
    match capabilities.get(key) {
        Some(Value::Bool(enabled)) => *enabled,
        Some(Value::Object(_)) => true,
        _ => false,
    }
}

fn provider_strings(capabilities: &Value, key: &str, field: &str) -> Vec<String> {
    capabilities
        .get(key)
        .and_then(|provider| provider.get(field))
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn capability_summary_from(capabilities: &Value) -> LspCapabilitySummary {
    LspCapabilitySummary {
        completion: has_provider(capabilities, "completionProvider"),
        signature_help: has_provider(capabilities, "signatureHelpProvider"),
        hover: has_provider(capabilities, "hoverProvider"),
        definition: has_provider(capabilities, "definitionProvider"),
        type_definition: has_provider(capabilities, "typeDefinitionProvider"),
        implementation: has_provider(capabilities, "implementationProvider"),
        references: has_provider(capabilities, "referencesProvider"),
        document_symbol: has_provider(capabilities, "documentSymbolProvider"),
        workspace_symbol: has_provider(capabilities, "workspaceSymbolProvider"),
        rename: has_provider(capabilities, "renameProvider"),
        formatting: has_provider(capabilities, "documentFormattingProvider"),
        range_formatting: has_provider(capabilities, "documentRangeFormattingProvider"),
        code_action: has_provider(capabilities, "codeActionProvider"),
        document_highlight: has_provider(capabilities, "documentHighlightProvider"),
        call_hierarchy: has_provider(capabilities, "callHierarchyProvider"),
        type_hierarchy: has_provider(capabilities, "typeHierarchyProvider"),
        inlay_hint: has_provider(capabilities, "inlayHintProvider"),
        completion_trigger_characters: provider_strings(
            capabilities,
            "completionProvider",
            "triggerCharacters",
        ),
        signature_trigger_characters: provider_strings(
            capabilities,
            "signatureHelpProvider",
            "triggerCharacters",
        ),
    }
}

fn parse_text_edit(value: &Value) -> Option<LspTextEdit> {
    let new_text = value.get("newText")?.as_str()?.to_string();
    // Plain TextEdit carries `range`; InsertReplaceEdit carries
    // `insert`/`replace` ranges — prefer the insert range.
    let range = value
        .get("range")
        .or_else(|| value.get("insert"))
        .or_else(|| value.get("replace"))
        .and_then(parse_range)?;
    Some(LspTextEdit { range, new_text })
}

fn parse_text_edits(value: &Value) -> Vec<LspTextEdit> {
    value
        .as_array()
        .map(|items| items.iter().filter_map(parse_text_edit).collect())
        .unwrap_or_default()
}

fn parse_workspace_edit(value: &Value) -> LspWorkspaceEdit {
    let mut document_edits: Vec<LspFileTextEdits> = Vec::new();
    if let Some(changes) = value.get("changes").and_then(Value::as_object) {
        for (uri, edits) in changes {
            document_edits.push(LspFileTextEdits {
                uri: uri.clone(),
                path: path_from_uri(uri),
                edits: parse_text_edits(edits),
            });
        }
    }
    if let Some(document_changes) = value.get("documentChanges").and_then(Value::as_array) {
        for change in document_changes {
            // TextDocumentEdit: { textDocument: { uri }, edits: [...] }
            // Skip CreateFile/RenameFile/DeleteFile for now.
            let Some(uri) = change
                .get("textDocument")
                .and_then(|doc| doc.get("uri"))
                .and_then(Value::as_str)
            else {
                continue;
            };
            let edits = change
                .get("edits")
                .map(parse_text_edits)
                .unwrap_or_default();
            if edits.is_empty() {
                continue;
            }
            if let Some(existing) = document_edits.iter_mut().find(|item| item.uri == uri) {
                existing.edits.extend(edits);
            } else {
                document_edits.push(LspFileTextEdits {
                    uri: uri.to_string(),
                    path: path_from_uri(uri),
                    edits,
                });
            }
        }
    }
    LspWorkspaceEdit { document_edits }
}

fn parse_code_action(value: &Value) -> Option<LspCodeAction> {
    // Command-only entries appear as { title, command, arguments }.
    // Full CodeAction has title + optional edit/command/kind.
    let title = value
        .get("title")
        .and_then(Value::as_str)
        .filter(|title| !title.is_empty())?
        .to_string();
    let command = value
        .get("command")
        .and_then(|command| {
            if let Some(name) = command.as_str() {
                Some(name.to_string())
            } else {
                command
                    .get("command")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
            }
        });
    let command_arguments = value
        .get("command")
        .and_then(|command| command.get("arguments"))
        .cloned()
        .or_else(|| value.get("arguments").cloned());
    let edit = value.get("edit").map(parse_workspace_edit);
    Some(LspCodeAction {
        title,
        kind: value
            .get("kind")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        is_preferred: value
            .get("isPreferred")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        edit,
        command,
        command_arguments,
        raw: value.clone(),
    })
}

fn parse_code_actions(value: &Value) -> Vec<LspCodeAction> {
    value
        .as_array()
        .map(|items| items.iter().filter_map(parse_code_action).collect())
        .unwrap_or_default()
}

fn parse_workspace_symbol(value: &Value) -> Option<LspWorkspaceSymbol> {
    let name = value.get("name")?.as_str()?.to_string();
    let kind = value
        .get("kind")
        .and_then(Value::as_u64)
        .and_then(|kind| u32::try_from(kind).ok())
        .unwrap_or(0);
    // SymbolInformation: location.uri + location.range
    // WorkspaceSymbol (3.17): location may be { uri } only; range optional.
    let (uri, range) = if let Some(location) = value.get("location") {
        let uri = location.get("uri").and_then(Value::as_str)?;
        let range = location
            .get("range")
            .and_then(parse_range)
            .or_else(|| value.get("range").and_then(parse_range))
            .unwrap_or(LspRange {
                start: LspPosition {
                    line: 0,
                    character: 0,
                },
                end: LspPosition {
                    line: 0,
                    character: 0,
                },
            });
        (uri.to_string(), range)
    } else {
        return None;
    };
    let selection_range = value
        .get("selectionRange")
        .and_then(parse_range)
        .unwrap_or_else(|| range.clone());
    let path = path_from_uri(&uri);
    Some(LspWorkspaceSymbol {
        name,
        kind,
        container_name: value
            .get("containerName")
            .and_then(Value::as_str)
            .filter(|name| !name.is_empty())
            .map(ToString::to_string),
        uri,
        path,
        range,
        selection_range,
    })
}

fn parse_workspace_symbols(value: &Value) -> Vec<LspWorkspaceSymbol> {
    value
        .as_array()
        .map(|items| items.iter().filter_map(parse_workspace_symbol).collect())
        .unwrap_or_default()
}

fn parse_completion_item(value: &Value) -> Option<LspCompletionItem> {
    let label = value.get("label")?.as_str()?.to_string();
    Some(LspCompletionItem {
        label,
        kind: value
            .get("kind")
            .and_then(Value::as_u64)
            .and_then(|kind| u32::try_from(kind).ok()),
        detail: value
            .get("detail")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        documentation: value.get("documentation").and_then(markup_to_string),
        insert_text: value
            .get("insertText")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        insert_text_format: value
            .get("insertTextFormat")
            .and_then(Value::as_u64)
            .and_then(|format| u32::try_from(format).ok()),
        filter_text: value
            .get("filterText")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        sort_text: value
            .get("sortText")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        text_edit: value.get("textEdit").and_then(parse_text_edit),
        additional_text_edits: value
            .get("additionalTextEdits")
            .and_then(Value::as_array)
            .map(|edits| edits.iter().filter_map(parse_text_edit).collect())
            .unwrap_or_default(),
        raw: value.clone(),
    })
}

/// Completion responses are either a bare `CompletionItem[]` or a
/// `CompletionList { isIncomplete, items }`.
fn parse_completion_response(value: &Value) -> (bool, Vec<LspCompletionItem>) {
    if let Some(items) = value.as_array() {
        return (false, items.iter().filter_map(parse_completion_item).collect());
    }
    if let Some(items) = value.get("items").and_then(Value::as_array) {
        let is_incomplete = value
            .get("isIncomplete")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        return (
            is_incomplete,
            items.iter().filter_map(parse_completion_item).collect(),
        );
    }
    (false, Vec::new())
}

fn parse_signature_parameter(value: &Value, signature_label: &str) -> Option<LspSignatureParameter> {
    let documentation = value.get("documentation").and_then(markup_to_string);
    match value.get("label") {
        Some(Value::String(label)) => Some(LspSignatureParameter {
            label: label.clone(),
            documentation,
            label_start: None,
            label_end: None,
        }),
        Some(Value::Array(offsets)) => {
            let start = offsets.first().and_then(Value::as_u64)?;
            let end = offsets.get(1).and_then(Value::as_u64)?;
            let label: String = signature_label
                .chars()
                .skip(usize::try_from(start).ok()?)
                .take(usize::try_from(end.saturating_sub(start)).ok()?)
                .collect();
            Some(LspSignatureParameter {
                label,
                documentation,
                label_start: u32::try_from(start).ok(),
                label_end: u32::try_from(end).ok(),
            })
        }
        _ => None,
    }
}

fn parse_signature_help(value: &Value) -> (Vec<LspSignatureInfo>, u32, u32) {
    let signatures = value
        .get("signatures")
        .and_then(Value::as_array)
        .map(|signatures| {
            signatures
                .iter()
                .filter_map(|signature| {
                    let label = signature.get("label")?.as_str()?.to_string();
                    let parameters = signature
                        .get("parameters")
                        .and_then(Value::as_array)
                        .map(|parameters| {
                            parameters
                                .iter()
                                .filter_map(|parameter| parse_signature_parameter(parameter, &label))
                                .collect()
                        })
                        .unwrap_or_default();
                    Some(LspSignatureInfo {
                        documentation: signature.get("documentation").and_then(markup_to_string),
                        parameters,
                        active_parameter: signature
                            .get("activeParameter")
                            .and_then(Value::as_u64)
                            .and_then(|active| u32::try_from(active).ok()),
                        label,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let active_signature = value
        .get("activeSignature")
        .and_then(Value::as_u64)
        .and_then(|active| u32::try_from(active).ok())
        .unwrap_or(0);
    let active_parameter = value
        .get("activeParameter")
        .and_then(Value::as_u64)
        .and_then(|active| u32::try_from(active).ok())
        .unwrap_or(0);
    (signatures, active_signature, active_parameter)
}

/// Flattens a `textDocument/documentSymbol` response. Servers reply with
/// either hierarchical `DocumentSymbol[]` (has `selectionRange`/`children`)
/// or flat `SymbolInformation[]` (has `location`); both collapse into the
/// same depth-annotated list.
fn collect_document_symbols(value: &Value, depth: u32, out: &mut Vec<LspDocumentSymbol>) {
    let Some(items) = value.as_array() else {
        return;
    };
    for item in items {
        let Some(name) = item.get("name").and_then(Value::as_str) else {
            continue;
        };
        let kind = item
            .get("kind")
            .and_then(Value::as_u64)
            .and_then(|kind| u32::try_from(kind).ok())
            .unwrap_or(0);
        if item.get("selectionRange").is_some() {
            let Some(range) = item.get("range").and_then(parse_range) else {
                continue;
            };
            let Some(selection_range) = item.get("selectionRange").and_then(parse_range) else {
                continue;
            };
            out.push(LspDocumentSymbol {
                name: name.to_string(),
                detail: item
                    .get("detail")
                    .and_then(Value::as_str)
                    .filter(|detail| !detail.is_empty())
                    .map(ToString::to_string),
                kind,
                depth,
                range,
                selection_range,
            });
            if let Some(children) = item.get("children") {
                collect_document_symbols(children, depth + 1, out);
            }
        } else if let Some(location) = item.get("location") {
            let Some(range) = location.get("range").and_then(parse_range) else {
                continue;
            };
            out.push(LspDocumentSymbol {
                name: name.to_string(),
                detail: item
                    .get("containerName")
                    .and_then(Value::as_str)
                    .filter(|container| !container.is_empty())
                    .map(ToString::to_string),
                kind,
                depth,
                range: range.clone(),
                selection_range: range,
            });
        }
    }
}

fn parse_locations(value: &Value) -> Vec<LspLocation> {
    if value.is_null() {
        return Vec::new();
    }
    if let Some(array) = value.as_array() {
        return array.iter().filter_map(parse_location).collect();
    }
    parse_location(value).into_iter().collect()
}

fn parse_location(value: &Value) -> Option<LspLocation> {
    let (uri, range) = if let Some(uri) = value.get("uri").and_then(Value::as_str) {
        (uri, parse_range(value.get("range")?)?)
    } else {
        let uri = value.get("targetUri").and_then(Value::as_str)?;
        let range = value
            .get("targetSelectionRange")
            .or_else(|| value.get("targetRange"))
            .and_then(parse_range)?;
        (uri, range)
    };
    Some(LspLocation {
        uri: uri.to_string(),
        path: path_from_uri(uri),
        range,
    })
}

fn path_from_uri(uri: &str) -> Option<String> {
    url::Url::parse(uri)
        .ok()
        .and_then(|url| url.to_file_path().ok())
        .map(|path| path.to_string_lossy().into_owned())
}

fn detect_language_id(language_id: &str) -> Option<DetectedLanguage> {
    let language_id = language_id.trim();
    let preset_id = match language_id {
        "typescript" | "typescriptreact" | "javascript" | "javascriptreact" => {
            "typescript-javascript"
        }
        "rust" => "rust",
        "python" => "python",
        "go" => "go",
        "java" => "java",
        "c" | "cpp" | "objective-c" | "objective-cpp" => "cpp",
        "kotlin" => "kotlin",
        "scala" => "scala",
        "csharp" => "csharp",
        "swift" => "swift",
        _ => return None,
    };
    Some(DetectedLanguage {
        preset_id: preset_id.to_string(),
        language_id: language_id.to_string(),
    })
}

fn detect_language_for_path(path: &Path) -> Option<DetectedLanguage> {
    let file_name = path.file_name()?.to_string_lossy().to_lowercase();
    let extension = path.extension()?.to_string_lossy().to_lowercase();
    let language_id = match extension.as_str() {
        "ts" | "mts" | "cts" => "typescript",
        "tsx" => "typescriptreact",
        "js" | "mjs" | "cjs" => "javascript",
        "jsx" => "javascriptreact",
        "rs" => "rust",
        "py" | "pyi" => "python",
        "go" => "go",
        "java" => "java",
        "c" => "c",
        "h" => {
            if file_name.ends_with(".h") {
                "cpp"
            } else {
                return None;
            }
        }
        "cc" | "cpp" | "cxx" | "hpp" | "hh" | "hxx" => "cpp",
        "kt" | "kts" => "kotlin",
        "scala" | "sc" => "scala",
        "cs" | "csx" => "csharp",
        "swift" => "swift",
        _ => return None,
    };
    detect_language_id(language_id)
}

fn find_preset(id: &str) -> Option<LspServerPreset> {
    lsp_presets().into_iter().find(|preset| preset.id == id)
}

fn cmd(
    id: &str,
    label: &str,
    command: &str,
    args: &[&str],
    install_hint: &str,
    fallback: bool,
) -> LspServerCommandPreset {
    LspServerCommandPreset {
        id: id.into(),
        label: label.into(),
        command: command.into(),
        args: args.iter().map(|arg| (*arg).into()).collect(),
        install_hint: install_hint.into(),
        fallback,
    }
}

pub fn lsp_presets() -> Vec<LspServerPreset> {
    vec![
        LspServerPreset {
            id: "typescript-javascript".into(),
            display_name: "TypeScript / JavaScript".into(),
            document_language_ids: vec![
                "typescript".into(),
                "typescriptreact".into(),
                "javascript".into(),
                "javascriptreact".into(),
            ],
            file_extensions: vec![
                "ts".into(),
                "tsx".into(),
                "mts".into(),
                "cts".into(),
                "js".into(),
                "jsx".into(),
                "mjs".into(),
                "cjs".into(),
            ],
            file_names: vec![],
            commands: vec![cmd(
                "typescript-language-server",
                "typescript-language-server",
                "typescript-language-server",
                &["--stdio"],
                "npm install -g typescript typescript-language-server",
                false,
            )],
        },
        LspServerPreset {
            id: "rust".into(),
            display_name: "Rust".into(),
            document_language_ids: vec!["rust".into()],
            file_extensions: vec!["rs".into()],
            file_names: vec![],
            commands: vec![cmd(
                "rust-analyzer",
                "rust-analyzer",
                "rust-analyzer",
                &[],
                "rustup component add rust-analyzer",
                false,
            )],
        },
        LspServerPreset {
            id: "python".into(),
            display_name: "Python".into(),
            document_language_ids: vec!["python".into()],
            file_extensions: vec!["py".into(), "pyi".into()],
            file_names: vec![],
            commands: vec![cmd(
                "pyright",
                "pyright-langserver",
                "pyright-langserver",
                &["--stdio"],
                "npm install -g pyright",
                false,
            )],
        },
        LspServerPreset {
            id: "go".into(),
            display_name: "Go".into(),
            document_language_ids: vec!["go".into()],
            file_extensions: vec!["go".into()],
            file_names: vec![],
            commands: vec![cmd(
                "gopls",
                "gopls",
                "gopls",
                &[],
                "go install golang.org/x/tools/gopls@latest",
                false,
            )],
        },
        LspServerPreset {
            id: "java".into(),
            display_name: "Java".into(),
            document_language_ids: vec!["java".into()],
            file_extensions: vec!["java".into()],
            file_names: vec![],
            commands: vec![cmd(
                "jdtls",
                "jdtls",
                "jdtls",
                &[],
                "Install Eclipse JDT LS and ensure `jdtls` is on PATH",
                false,
            )],
        },
        LspServerPreset {
            id: "cpp".into(),
            display_name: "C / C++".into(),
            document_language_ids: vec!["c".into(), "cpp".into()],
            file_extensions: vec![
                "c".into(),
                "h".into(),
                "cc".into(),
                "cpp".into(),
                "cxx".into(),
                "hpp".into(),
                "hh".into(),
                "hxx".into(),
            ],
            file_names: vec![],
            commands: vec![cmd(
                "clangd",
                "clangd",
                "clangd",
                &[],
                "Install LLVM clangd and ensure `clangd` is on PATH",
                false,
            )],
        },
        LspServerPreset {
            id: "kotlin".into(),
            display_name: "Kotlin".into(),
            document_language_ids: vec!["kotlin".into()],
            file_extensions: vec!["kt".into(), "kts".into()],
            file_names: vec![],
            commands: vec![cmd(
                "kotlin-language-server",
                "kotlin-language-server",
                "kotlin-language-server",
                &[],
                "Install kotlin-language-server and ensure it is on PATH",
                false,
            )],
        },
        LspServerPreset {
            id: "scala".into(),
            display_name: "Scala".into(),
            document_language_ids: vec!["scala".into()],
            file_extensions: vec!["scala".into(), "sc".into()],
            file_names: vec![],
            commands: vec![cmd(
                "metals",
                "Metals",
                "metals",
                &[],
                "Install Metals and ensure `metals` is on PATH",
                false,
            )],
        },
        LspServerPreset {
            id: "csharp".into(),
            display_name: "C#".into(),
            document_language_ids: vec!["csharp".into()],
            file_extensions: vec!["cs".into(), "csx".into()],
            file_names: vec![],
            commands: vec![
                cmd(
                    "csharp-ls",
                    "csharp-ls",
                    "csharp-ls",
                    &[],
                    "dotnet tool install -g csharp-ls",
                    false,
                ),
                cmd(
                    "omnisharp",
                    "OmniSharp",
                    "omnisharp",
                    &["--languageserver"],
                    "Install OmniSharp and ensure `omnisharp` is on PATH",
                    true,
                ),
            ],
        },
        LspServerPreset {
            id: "swift".into(),
            display_name: "Swift".into(),
            document_language_ids: vec!["swift".into()],
            file_extensions: vec!["swift".into()],
            file_names: vec![],
            commands: vec![cmd(
                "sourcekit-lsp",
                "SourceKit-LSP",
                "sourcekit-lsp",
                &[],
                "Install Swift toolchain and ensure `sourcekit-lsp` is on PATH",
                false,
            )],
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn flattens_hierarchical_document_symbols_with_depth() {
        let response = json!([
            {
                "name": "OpenFileState",
                "detail": "",
                "kind": 11,
                "range": { "start": { "line": 4, "character": 0 }, "end": { "line": 8, "character": 1 } },
                "selectionRange": { "start": { "line": 4, "character": 10 }, "end": { "line": 4, "character": 23 } },
                "children": [
                    {
                        "name": "path",
                        "detail": "string",
                        "kind": 7,
                        "range": { "start": { "line": 5, "character": 2 }, "end": { "line": 5, "character": 15 } },
                        "selectionRange": { "start": { "line": 5, "character": 2 }, "end": { "line": 5, "character": 6 } }
                    }
                ]
            }
        ]);

        let mut symbols = Vec::new();
        collect_document_symbols(&response, 0, &mut symbols);

        assert_eq!(symbols.len(), 2);
        assert_eq!(symbols[0].name, "OpenFileState");
        assert_eq!(symbols[0].depth, 0);
        assert_eq!(symbols[0].detail, None);
        assert_eq!(symbols[0].selection_range.start.character, 10);
        assert_eq!(symbols[1].name, "path");
        assert_eq!(symbols[1].depth, 1);
        assert_eq!(symbols[1].detail.as_deref(), Some("string"));
    }

    #[test]
    fn accepts_flat_symbol_information_responses() {
        let response = json!([
            {
                "name": "workspace_read_file",
                "kind": 12,
                "containerName": "workspace",
                "location": {
                    "uri": "file:///repo/src/workspace.rs",
                    "range": { "start": { "line": 3, "character": 0 }, "end": { "line": 12, "character": 1 } }
                }
            },
            { "name": "missing range" }
        ]);

        let mut symbols = Vec::new();
        collect_document_symbols(&response, 0, &mut symbols);

        assert_eq!(symbols.len(), 1);
        assert_eq!(symbols[0].name, "workspace_read_file");
        assert_eq!(symbols[0].kind, 12);
        assert_eq!(symbols[0].detail.as_deref(), Some("workspace"));
        assert_eq!(symbols[0].selection_range.start.line, 3);
    }

    #[test]
    fn ignores_null_and_non_array_responses() {
        let mut symbols = Vec::new();
        collect_document_symbols(&Value::Null, 0, &mut symbols);
        collect_document_symbols(&json!({ "unexpected": true }), 0, &mut symbols);
        assert!(symbols.is_empty());
    }

    #[test]
    fn summarizes_server_capabilities_across_provider_shapes() {
        let summary = capability_summary_from(&json!({
            "completionProvider": { "triggerCharacters": [".", "::"], "resolveProvider": true },
            "signatureHelpProvider": { "triggerCharacters": ["(", ","] },
            "hoverProvider": true,
            "renameProvider": { "prepareProvider": true },
            "documentFormattingProvider": false,
            "typeHierarchyProvider": null,
        }));

        assert!(summary.completion);
        assert_eq!(summary.completion_trigger_characters, vec![".", "::"]);
        assert!(summary.signature_help);
        assert_eq!(summary.signature_trigger_characters, vec!["(", ","]);
        assert!(summary.hover);
        assert!(summary.rename);
        assert!(!summary.formatting);
        assert!(!summary.type_hierarchy);
        assert!(!summary.workspace_symbol);
    }

    #[test]
    fn parses_completion_lists_and_bare_arrays() {
        let (incomplete, items) = parse_completion_response(&json!({
            "isIncomplete": true,
            "items": [
                {
                    "label": "openFile",
                    "kind": 3,
                    "detail": "(path: string) => Promise<void>",
                    "sortText": "11",
                    "insertTextFormat": 2,
                    "insertText": "openFile(${1:path})",
                    "textEdit": {
                        "newText": "openFile",
                        "insert": { "start": { "line": 2, "character": 4 }, "end": { "line": 2, "character": 8 } },
                        "replace": { "start": { "line": 2, "character": 4 }, "end": { "line": 2, "character": 10 } }
                    },
                    "additionalTextEdits": [
                        {
                            "newText": "import { openFile } from \"./files\";\n",
                            "range": { "start": { "line": 0, "character": 0 }, "end": { "line": 0, "character": 0 } }
                        }
                    ]
                },
                { "noLabel": true }
            ]
        }));

        assert!(incomplete);
        assert_eq!(items.len(), 1);
        let item = &items[0];
        assert_eq!(item.label, "openFile");
        assert_eq!(item.insert_text_format, Some(2));
        // InsertReplaceEdit prefers the insert range.
        assert_eq!(item.text_edit.as_ref().unwrap().range.end.character, 8);
        assert_eq!(item.additional_text_edits.len(), 1);
        assert!(item.raw.get("label").is_some());

        let (incomplete, items) = parse_completion_response(&json!([{ "label": "bare" }]));
        assert!(!incomplete);
        assert_eq!(items[0].label, "bare");

        let (_, empty) = parse_completion_response(&Value::Null);
        assert!(empty.is_empty());
    }

    #[test]
    fn parses_signature_help_with_offset_parameter_labels() {
        let (signatures, active_signature, active_parameter) = parse_signature_help(&json!({
            "signatures": [{
                "label": "openFile(path: string, preview: boolean): void",
                "documentation": "Opens a file.",
                "parameters": [
                    { "label": "path: string" },
                    { "label": [23, 39], "documentation": { "kind": "markdown", "value": "preview flag" } }
                ]
            }],
            "activeSignature": 0,
            "activeParameter": 1
        }));

        assert_eq!(signatures.len(), 1);
        assert_eq!(active_signature, 0);
        assert_eq!(active_parameter, 1);
        let signature = &signatures[0];
        assert_eq!(signature.parameters[0].label, "path: string");
        assert_eq!(signature.parameters[1].label, "preview: boolean");
        assert_eq!(signature.parameters[1].label_start, Some(23));
        assert_eq!(signature.parameters[1].documentation.as_deref(), Some("preview flag"));
    }

    #[test]
    fn parses_formatting_text_edit_arrays() {
        let edits = parse_text_edits(&json!([
            {
                "range": {
                    "start": { "line": 0, "character": 0 },
                    "end": { "line": 0, "character": 4 }
                },
                "newText": "  x"
            },
            { "newText": "missing range" },
            {
                "range": {
                    "start": { "line": 1, "character": 0 },
                    "end": { "line": 1, "character": 0 }
                },
                "newText": "\n"
            }
        ]));
        assert_eq!(edits.len(), 2);
        assert_eq!(edits[0].new_text, "  x");
        assert_eq!(edits[0].range.start.line, 0);
        assert_eq!(edits[1].new_text, "\n");
        assert!(parse_text_edits(&Value::Null).is_empty());
        assert!(parse_text_edits(&json!({ "not": "array" })).is_empty());
    }

    #[test]
    fn parses_workspace_symbol_information() {
        let symbols = parse_workspace_symbols(&json!([
            {
                "name": "CodeWorkspaceTab",
                "kind": 5,
                "containerName": "editor",
                "location": {
                    "uri": "file:///repo/src/CodeWorkspaceTab.tsx",
                    "range": {
                        "start": { "line": 10, "character": 0 },
                        "end": { "line": 40, "character": 1 }
                    }
                }
            },
            { "name": "no location" }
        ]));
        assert_eq!(symbols.len(), 1);
        assert_eq!(symbols[0].name, "CodeWorkspaceTab");
        assert_eq!(symbols[0].kind, 5);
        assert_eq!(symbols[0].container_name.as_deref(), Some("editor"));
        assert_eq!(symbols[0].range.start.line, 10);
    }

    #[test]
    fn parses_code_actions_and_workspace_edits() {
        let actions = parse_code_actions(&json!([
            {
                "title": "Add import",
                "kind": "quickfix",
                "isPreferred": true,
                "edit": {
                    "changes": {
                        "file:///repo/src/a.ts": [{
                            "range": {
                                "start": { "line": 0, "character": 0 },
                                "end": { "line": 0, "character": 0 }
                            },
                            "newText": "import x from 'x';\n"
                        }]
                    }
                }
            },
            {
                "title": "Organize Imports",
                "command": { "command": "source.organizeImports", "arguments": [] }
            },
            { "noTitle": true }
        ]));
        assert_eq!(actions.len(), 2);
        assert_eq!(actions[0].title, "Add import");
        assert!(actions[0].is_preferred);
        assert_eq!(actions[0].edit.as_ref().unwrap().document_edits.len(), 1);
        assert_eq!(actions[1].command.as_deref(), Some("source.organizeImports"));
    }
}
