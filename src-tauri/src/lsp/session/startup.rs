use crate::lsp::LspClientRequestBridge;
use crate::lsp::LspDocumentStatus;
use crate::lsp::LspLastErrorRegistry;
use crate::lsp::LspServerCommandPreset;
use crate::lsp::LspServerPreset;
use crate::lsp::LspSession;
use crate::lsp::LspSessionEntry;
use crate::lsp::LspSessionKey;
use crate::lsp::LspSessionRegistry;
use crate::lsp::LspSessionStart;
use crate::lsp::ResolvedDocument;
use crate::lsp::client_requests::merge_json_value;
use crate::lsp::java_runtime::apply_jdtls_vmargs_to_command;
use crate::lsp::java_runtime::command_is_jdtls;
use crate::lsp::java_runtime::java_home_from_binary;
use crate::lsp::java_runtime::resolve_java_for_jdtls_with_sdk;
use crate::lsp::presets::command_line;
use crate::lsp::presets::lsp_initialization_options;
use crate::lsp::session;
use crate::lsp::transport::build_lsp_server_command;
use crate::lsp::transport::initialize_timeout_secs;
use crate::lsp::transport::no_console_window;
use crate::lsp::transport::read_stderr;
use crate::lsp::transport::read_stdout;
use crate::lsp::transport::workspace_client_capabilities;
use crate::sdk::WorkspaceSdkEnvironment;
use serde_json::Value;
use serde_json::json;
use std::collections::HashMap;
use std::collections::HashSet;
use std::path::Path;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU8;
use std::sync::atomic::AtomicU64;
use tokio::sync::Mutex;
use tokio::sync::Notify;
use tokio::sync::RwLock;

impl LspSessionEntry {
    pub(in crate::lsp) fn workspace_id(&self) -> &str {
        match self {
            Self::Starting(start) => &start.workspace_id,
            Self::Ready(session) => &session.key.workspace_id,
        }
    }
}

impl LspSessionStart {
    pub(in crate::lsp) fn new(workspace_id: String) -> Self {
        Self {
            workspace_id,
            result: Mutex::new(None),
            completed: Notify::new(),
            cancellation: Mutex::new(None),
            cancelled: Notify::new(),
        }
    }

    pub(in crate::lsp) async fn wait(&self) -> Result<Arc<LspSession>, String> {
        loop {
            let completed = self.completed.notified();
            if let Some(result) = self.result.lock().await.clone() {
                return result;
            }
            completed.await;
        }
    }

    pub(in crate::lsp) async fn complete(&self, result: Result<Arc<LspSession>, String>) {
        let mut current = self.result.lock().await;
        if current.is_none() {
            *current = Some(result);
            drop(current);
            self.completed.notify_waiters();
        }
    }

    pub(in crate::lsp) async fn cancel(&self, error: String) {
        let mut cancellation = self.cancellation.lock().await;
        if cancellation.is_none() {
            *cancellation = Some(error.clone());
            drop(cancellation);
            self.cancelled.notify_waiters();
        }
        self.complete(Err(error)).await;
    }

    pub(in crate::lsp) async fn wait_cancelled(&self) -> String {
        loop {
            let cancelled = self.cancelled.notified();
            if let Some(error) = self.cancellation.lock().await.clone() {
                return error;
            }
            cancelled.await;
        }
    }
}

pub(in crate::lsp) fn session_start_error_status(
    document: &ResolvedDocument,
    preset: &LspServerPreset,
    command: &LspServerCommandPreset,
    error: String,
) -> LspDocumentStatus {
    LspDocumentStatus {
        path: document.path.to_string_lossy().into_owned(),
        uri: document.uri.clone(),
        preset_id: Some(preset.id.clone()),
        language_id: document.language_id.clone(),
        display_name: Some(preset.display_name.clone()),
        available: true,
        active: false,
        semantic_ready: false,
        selected_command_id: Some(command.id.clone()),
        selected_command: Some(command_line(&command.command, &command.args)),
        // Binary was found; this is a runtime/start failure, not "please install".
        install_hint: None,
        error: Some(error),
        capabilities: None,
    }
}

impl LspSession {
    pub(in crate::lsp) async fn merge_client_configuration(&self, patch: &Value) {
        merge_json_value(&mut *self.client_configuration.write().await, patch);
    }

    pub(in crate::lsp) async fn spawn(
        key: LspSessionKey,
        preset: LspServerPreset,
        command: LspServerCommandPreset,
        root_path: PathBuf,
        root_uri: String,
        sdk_environment: WorkspaceSdkEnvironment,
        sessions: LspSessionRegistry,
        last_errors: LspLastErrorRegistry,
        client_bridge: Arc<LspClientRequestBridge>,
        map_key: String,
        start: Arc<LspSessionStart>,
    ) -> Result<Arc<Self>, String> {
        let is_jdtls = command_is_jdtls(&command);
        let tooling_java_home = sdk_environment.tooling_java_home.as_deref().map(Path::new);
        let mut process = build_lsp_server_command(
            &command.command,
            &command.args,
            &root_path,
            tooling_java_home,
            sdk_environment.tooling_java_error.as_deref(),
        )
        .map_err(|e| format!("prepare {}: {e}", command.command))?;
        for (key, value) in &sdk_environment.environment {
            process.env(key, value);
        }
        if let Some(path) = sdk_environment.prepend_path(std::env::var_os("PATH").as_deref()) {
            process.env("PATH", path);
        }
        // Ensure jdtls wrappers (non-Windows) use the tooling JDK. The project
        // JDK is delivered independently through java.configuration.runtimes.
        // §8.20.3 W2: remember the resolved home so Project Analysis can hash
        // the JDK identity into its fingerprint.
        let resolved_java_home = if is_jdtls {
            resolve_java_for_jdtls_with_sdk(
                tooling_java_home,
                sdk_environment.tooling_java_error.as_deref(),
            )
            .ok()
            .and_then(|(java, _)| java_home_from_binary(&java))
        } else {
            None
        };
        if let Some(home) = &resolved_java_home {
            process.env("JAVA_HOME", home);
        }
        // Non-Windows launches the `jdtls` wrapper; inject JVM args via JAVA_OPTS
        // so the script's JVM picks up Settings → Language Servers vmargs.
        if is_jdtls {
            apply_jdtls_vmargs_to_command(&mut process);
        }
        let initialization_options =
            lsp_initialization_options(&preset, &command, &sdk_environment);
        let client_configuration = initialization_options
            .get("settings")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let root_name = root_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("workspace")
            .to_string();
        process
            .current_dir(&root_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        no_console_window(&mut process);
        let mut child = process
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
            root_name,
            stdin: Mutex::new(stdin),
            pending: Mutex::new(HashMap::new()),
            incoming_show_message_requests: Mutex::new(HashMap::new()),
            opened_documents: RwLock::new(HashSet::new()),
            diagnostics: RwLock::new(HashMap::new()),
            diagnostic_result_ids: RwLock::new(HashMap::new()),
            diagnostic_pull_lock: Mutex::new(()),
            diagnostic_partial_results: Mutex::new(HashMap::new()),
            diagnostic_provider_generation: AtomicU64::new(0),
            semantic_ready: AtomicBool::new(!is_jdtls),
            capabilities: RwLock::new(None),
            server_capabilities: RwLock::new(Value::Null),
            server_info: RwLock::new(None),
            tooling_java_home_used: Mutex::new(resolved_java_home),
            client_configuration: RwLock::new(client_configuration),
            work_done_progress: RwLock::new(HashMap::new()),
            dynamic_capabilities: RwLock::new(HashMap::new()),
            text_document_sync_kind: AtomicU8::new(1),
            semantic_token_types: RwLock::new(Vec::new()),
            semantic_token_modifiers: RwLock::new(Vec::new()),
            semantic_tokens_delta: RwLock::new(false),
            semantic_tokens_cache: RwLock::new(HashMap::new()),
            semantic_tokens_lock: Mutex::new(()),
            next_id: AtomicU64::new(1),
            shutting_down: AtomicBool::new(false),
            child: Mutex::new(child),
            stderr_tail: Mutex::new(String::new()),
            client_bridge,
        });

        tokio::spawn(read_stdout(
            session.clone(),
            stdout,
            sessions,
            last_errors,
            map_key,
        ));
        if let Some(stderr) = stderr {
            tokio::spawn(read_stderr(session.clone(), stderr));
        }

        let mut initialize_params = json!({
            "processId": Value::Null,
            "rootUri": session.root_uri,
            "initializationOptions": initialization_options,
            "workspaceFolders": [{
                "uri": session.root_uri,
                "name": session.root_name
            }],
            "capabilities": {
                "window": {
                    "workDoneProgress": true,
                    "showMessage": {
                        "messageActionItem": {
                            "additionalPropertiesSupport": true
                        }
                    }
                },
                "general": {
                    "staleRequestSupport": {
                        "cancel": true,
                        "retryOnContentModified": []
                    }
                },
                "textDocument": {
                    "synchronization": {
                        "dynamicRegistration": true,
                        "didSave": true
                    },
                    "hover": {
                        "dynamicRegistration": true,
                        "contentFormat": ["markdown", "plaintext"]
                    },
                    "definition": {
                        "dynamicRegistration": true,
                        "linkSupport": true
                    },
                    "typeDefinition": { "dynamicRegistration": true, "linkSupport": true },
                    "implementation": { "dynamicRegistration": true, "linkSupport": true },
                    "references": {
                        "dynamicRegistration": true
                    },
                    "completion": {
                        "dynamicRegistration": true,
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
                        "dynamicRegistration": true,
                        "contextSupport": true,
                        "signatureInformation": {
                            "documentationFormat": ["markdown", "plaintext"],
                            "parameterInformation": { "labelOffsetSupport": true },
                            "activeParameterSupport": true
                        }
                    },
                    "documentSymbol": {
                        "dynamicRegistration": true,
                        "hierarchicalDocumentSymbolSupport": true
                    },
                    "documentHighlight": { "dynamicRegistration": true },
                    "codeAction": {
                        "dynamicRegistration": true,
                        "codeActionLiteralSupport": {
                            "codeActionKind": {
                                "valueSet": [
                                    "",
                                    "quickfix",
                                    "refactor",
                                    "refactor.extract",
                                    "refactor.inline",
                                    "refactor.rewrite",
                                    "source",
                                    "source.organizeImports",
                                    "source.fixAll"
                                ]
                            }
                        },
                        "isPreferredSupport": true,
                        "dataSupport": true,
                        "resolveSupport": {
                            "properties": ["edit", "command"]
                        }
                    },
                    "formatting": { "dynamicRegistration": true },
                    "rangeFormatting": { "dynamicRegistration": true },
                    "rename": { "dynamicRegistration": true, "prepareSupport": true },
                    "callHierarchy": { "dynamicRegistration": true },
                    "typeHierarchy": { "dynamicRegistration": true },
                    "inlayHint": { "dynamicRegistration": true },
                    "selectionRange": { "dynamicRegistration": true },
                    "publishDiagnostics": {
                        "relatedInformation": true,
                        "versionSupport": true,
                        "tagSupport": { "valueSet": [1, 2] },
                        "codeDescriptionSupport": true,
                        "dataSupport": true
                    },
                    "diagnostic": {
                        "dynamicRegistration": true,
                        "relatedDocumentSupport": true
                    },
                    "semanticTokens": {
                        "dynamicRegistration": true,
                        "requests": { "full": { "delta": true }, "range": false },
                        "tokenTypes": [
                            "namespace", "type", "class", "enum", "interface", "struct", "typeParameter",
                            "parameter", "variable", "property", "enumMember", "event", "function",
                            "method", "macro", "keyword", "modifier", "comment", "string", "number",
                            "regexp", "operator", "decorator"
                        ],
                        "tokenModifiers": [
                            "declaration", "definition", "readonly", "static", "deprecated",
                            "abstract", "async", "modification", "documentation", "defaultLibrary"
                        ],
                        "formats": ["relative"],
                        "overlappingTokenSupport": false,
                        "multilineTokenSupport": true
                    }
                },
                "workspace": workspace_client_capabilities()
            }
        });
        if let Some(text_doc) = initialize_params
            .get_mut("capabilities")
            .and_then(|c| c.get_mut("textDocument"))
        {
            text_doc["declaration"] = json!({
                "dynamicRegistration": true,
                "linkSupport": true
            });
        }
        let initialize_timeout = initialize_timeout_secs(&session.command);
        let initialize_result = match tokio::select! {
            result = session.request_with_timeout(
                "initialize",
                initialize_params,
                initialize_timeout,
            ) => result,
            error = start.wait_cancelled() => {
                session.abort(&error).await;
                return Err(error);
            }
        } {
            Ok(result) => result,
            Err(error) => {
                let error = if let Some(stderr) = session.stderr_snippet().await {
                    format!("{error} ({stderr})")
                } else {
                    error
                };
                session.abort(&error).await;
                return Err(error);
            }
        };
        let server_caps = initialize_result
            .get("capabilities")
            .cloned()
            .unwrap_or(Value::Null);
        *session.server_capabilities.write().await = server_caps;
        // §8.20.3 W2: keep the provider's own identity for Project Analysis.
        *session.server_info.write().await = initialize_result.get("serverInfo").cloned();
        session.refresh_capabilities().await;
        if let Some(error) = start.cancellation.lock().await.clone() {
            session.abort(&error).await;
            return Err(error);
        }
        if let Err(error) = session.notify("initialized", json!({})).await {
            session.abort(&error).await;
            return Err(error);
        }
        Ok(session)
    }
}
