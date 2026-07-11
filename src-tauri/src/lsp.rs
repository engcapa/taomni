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
        let active = if let Some(cmd) = command.as_ref() {
            let key = session_key(document, preset, cmd);
            self.sessions.lock().await.contains_key(&key.map_key())
        } else {
            false
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
        session
            .request_with_timeout("initialize", initialize_params, INITIALIZE_TIMEOUT_SECS)
            .await?;
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
}
