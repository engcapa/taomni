use super::*;

impl LspSessionEntry {
    pub(super) fn workspace_id(&self) -> &str {
        match self {
            Self::Starting(start) => &start.workspace_id,
            Self::Ready(session) => &session.key.workspace_id,
        }
    }
}

impl LspSessionStart {
    pub(super) fn new(workspace_id: String) -> Self {
        Self {
            workspace_id,
            result: Mutex::new(None),
            completed: Notify::new(),
            cancellation: Mutex::new(None),
            cancelled: Notify::new(),
        }
    }

    pub(super) async fn wait(&self) -> Result<Arc<LspSession>, String> {
        loop {
            let completed = self.completed.notified();
            if let Some(result) = self.result.lock().await.clone() {
                return result;
            }
            completed.await;
        }
    }

    pub(super) async fn complete(&self, result: Result<Arc<LspSession>, String>) {
        let mut current = self.result.lock().await;
        if current.is_none() {
            *current = Some(result);
            drop(current);
            self.completed.notify_waiters();
        }
    }

    pub(super) async fn cancel(&self, error: String) {
        let mut cancellation = self.cancellation.lock().await;
        if cancellation.is_none() {
            *cancellation = Some(error.clone());
            drop(cancellation);
            self.cancelled.notify_waiters();
        }
        self.complete(Err(error)).await;
    }

    pub(super) async fn wait_cancelled(&self) -> String {
        loop {
            let cancelled = self.cancelled.notified();
            if let Some(error) = self.cancellation.lock().await.clone() {
                return error;
            }
            cancelled.await;
        }
    }
}

pub(super) fn session_start_error_status(
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
    pub(super) async fn merge_client_configuration(&self, patch: &Value) {
        merge_json_value(&mut *self.client_configuration.write().await, patch);
    }

    pub(super) async fn spawn(
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

    pub(super) async fn refresh_capabilities(&self) {
        let server_capabilities = self.server_capabilities.read().await.clone();
        let mut registrations = self
            .dynamic_capabilities
            .read()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        registrations.sort_by(|left, right| left.id.cmp(&right.id));
        let (summary, token_types, token_modifiers, semantic_delta) =
            capability_state_from(&server_capabilities, &registrations);
        self.text_document_sync_kind
            .store(summary.text_document_sync_kind, Ordering::SeqCst);
        *self.capabilities.write().await = Some(summary);
        *self.semantic_token_types.write().await = token_types;
        *self.semantic_token_modifiers.write().await = token_modifiers;
        *self.semantic_tokens_delta.write().await = semantic_delta;
        self.semantic_tokens_cache.write().await.clear();
    }

    pub(super) async fn register_capability_values(
        &self,
        registrations: Vec<DynamicCapabilityRegistration>,
    ) {
        if registrations.is_empty() {
            return;
        }
        let resets_diagnostic_results = registrations
            .iter()
            .any(|registration| registration.method == "workspace/diagnostic");
        let mut current = self.dynamic_capabilities.write().await;
        for registration in registrations {
            current.insert(registration.id.clone(), registration);
        }
        drop(current);
        if resets_diagnostic_results {
            self.diagnostic_provider_generation
                .fetch_add(1, Ordering::SeqCst);
            self.diagnostic_result_ids.write().await.clear();
        }
        self.refresh_capabilities().await;
    }

    pub(super) async fn unregister_capability_ids(&self, ids: Vec<String>) {
        if ids.is_empty() {
            return;
        }
        let mut current = self.dynamic_capabilities.write().await;
        let mut resets_diagnostic_results = false;
        for id in ids {
            if current
                .remove(&id)
                .is_some_and(|registration| registration.method == "workspace/diagnostic")
            {
                resets_diagnostic_results = true;
            }
        }
        drop(current);
        if resets_diagnostic_results {
            self.diagnostic_provider_generation
                .fetch_add(1, Ordering::SeqCst);
            self.diagnostic_result_ids.write().await.clear();
        }
        self.refresh_capabilities().await;
    }

    pub(super) async fn workspace_file_operation_params(
        &self,
        method: &str,
        operation: &LspWorkspaceFileOperation,
    ) -> Result<Option<Value>, String> {
        let server_capabilities = self.server_capabilities.read().await.clone();
        let registrations = self
            .dynamic_capabilities
            .read()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        let Some(filters) =
            file_operation_filters_from(&server_capabilities, &registrations, method)
        else {
            return Ok(None);
        };
        workspace_file_operation_params(&self.root_uri, operation, &filters)
    }

    pub(super) async fn watched_file_params(
        &self,
        changes: &[LspWatchedFileChange],
    ) -> Result<Option<Value>, String> {
        let registrations = self
            .dynamic_capabilities
            .read()
            .await
            .values()
            .filter(|registration| registration.method == "workspace/didChangeWatchedFiles")
            .cloned()
            .collect::<Vec<_>>();
        if registrations.is_empty() {
            return Ok(None);
        }

        let mut events = Vec::new();
        let mut seen = HashSet::new();
        for change in changes {
            let Some(watch_kind) = watch_kind_for_change(change.change_type) else {
                return Err(format!(
                    "workspace/didChangeWatchedFiles has invalid file change type {}",
                    change.change_type
                ));
            };
            let uri = file_operation_uri(&change.path)?;
            if !registrations.iter().any(|registration| {
                watched_file_registration_matches(registration, &self.root_uri, &uri, watch_kind)
            }) {
                continue;
            }
            if seen.insert((uri.clone(), change.change_type)) {
                events.push(json!({ "uri": uri, "type": change.change_type }));
            }
        }
        Ok((!events.is_empty()).then(|| json!({ "changes": events })))
    }

    /// Pull project diagnostics when the server implements LSP 3.17's
    /// `workspace/diagnostic`. Push diagnostics remain authoritative for
    /// servers without this provider, and remain as a fallback if a pull fails.
    pub(super) async fn pull_workspace_diagnostics(&self) -> Result<bool, String> {
        let provider = {
            let server_capabilities = self.server_capabilities.read().await.clone();
            let registrations = self
                .dynamic_capabilities
                .read()
                .await
                .values()
                .cloned()
                .collect::<Vec<_>>();
            workspace_diagnostic_provider_options(&server_capabilities, &registrations)
        };
        let Some(provider) = provider else {
            return Ok(false);
        };

        // The Problems panel polls this command. If the prior pull is still in
        // flight, serve its cached data instead of queuing another project-wide
        // request behind it.
        let Ok(_guard) = self.diagnostic_pull_lock.try_lock() else {
            return Ok(false);
        };
        let provider_generation = self.diagnostic_provider_generation.load(Ordering::SeqCst);
        let mut previous_result_ids = self
            .diagnostic_result_ids
            .read()
            .await
            .iter()
            .map(|(uri, value)| json!({ "uri": uri, "value": value }))
            .collect::<Vec<_>>();
        previous_result_ids.sort_by(|left, right| {
            left.get("uri")
                .and_then(Value::as_str)
                .cmp(&right.get("uri").and_then(Value::as_str))
        });
        let mut params = json!({ "previousResultIds": previous_result_ids });
        if let Some(identifier) = provider.get("identifier").and_then(Value::as_str) {
            params["identifier"] = json!(identifier);
        }
        let partial_token = format!(
            "workspace-diagnostic:{}",
            self.next_id.fetch_add(1, Ordering::SeqCst)
        );
        let partial_token_key = progress_token_key(&json!(partial_token));
        self.diagnostic_partial_results
            .lock()
            .await
            .insert(partial_token_key.clone(), Vec::new());
        params["partialResultToken"] = json!(partial_token);
        let response = self
            .request_with_timeout(
                "workspace/diagnostic",
                params,
                WORKSPACE_DIAGNOSTIC_TIMEOUT_SECS,
            )
            .await;
        let partial_items = self
            .diagnostic_partial_results
            .lock()
            .await
            .remove(&partial_token_key)
            .unwrap_or_default();
        let response = merge_workspace_diagnostic_partial_results(response?, partial_items)?;
        if self.diagnostic_provider_generation.load(Ordering::SeqCst) != provider_generation {
            return Ok(false);
        }
        let mut diagnostics = self.diagnostics.write().await;
        let mut result_ids = self.diagnostic_result_ids.write().await;
        apply_workspace_diagnostic_report(&response, &mut diagnostics, &mut result_ids)?;
        Ok(true)
    }

    pub(super) async fn apply_server_workspace_edit(&self, params: Option<&Value>) -> Value {
        let Some(edit_value) = params.and_then(|value| value.get("edit")) else {
            return json!({
                "applied": false,
                "failureReason": "workspace/applyEdit request did not include an edit"
            });
        };
        let label = params
            .and_then(|value| value.get("label"))
            .and_then(Value::as_str)
            .map(ToString::to_string);
        let response = self
            .client_bridge
            .apply_workspace_edit(
                &self.key.workspace_id,
                label,
                parse_workspace_edit(edit_value),
            )
            .await;
        serde_json::to_value(response).unwrap_or_else(|error| {
            json!({
                "applied": false,
                "failureReason": format!("Cannot serialize WorkspaceEdit result: {error}")
            })
        })
    }

    pub(super) async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        let payload = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        });
        self.write_message(&payload).await
    }

    pub(super) async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        self.request_with_timeout(method, params, REQUEST_TIMEOUT_SECS)
            .await
    }

    pub(super) async fn request_with_cancellation(
        &self,
        method: &str,
        params: Value,
        cancellation: &CancellationToken,
    ) -> Result<Value, String> {
        if cancellation.is_cancelled() {
            return Err(format!("language server request cancelled: {method}"));
        }
        self.request_with_timeout_and_cancellation(
            method,
            params,
            REQUEST_TIMEOUT_SECS,
            Some(cancellation),
        )
        .await
    }

    pub(super) async fn request_with_timeout(
        &self,
        method: &str,
        params: Value,
        timeout_secs: u64,
    ) -> Result<Value, String> {
        self.request_with_timeout_and_cancellation(method, params, timeout_secs, None)
            .await
    }

    pub(super) async fn request_with_timeout_and_cancellation(
        &self,
        method: &str,
        params: Value,
        timeout_secs: u64,
        cancellation: Option<&CancellationToken>,
    ) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (sender, receiver) = oneshot::channel();
        let document_uri = request_document_uri(&params).map(ToString::to_string);
        self.pending.lock().await.insert(
            id,
            PendingResponse {
                sender,
                document_uri,
            },
        );
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
        let response = tokio::time::timeout(Duration::from_secs(timeout_secs), receiver);
        tokio::pin!(response);
        let outcome = if let Some(cancellation) = cancellation {
            tokio::select! {
                biased;
                result = &mut response => result,
                _ = cancellation.cancelled() => {
                    if self.pending.lock().await.remove(&id).is_some() {
                        let _ = self.notify("$/cancelRequest", json!({ "id": id })).await;
                    }
                    return Err(format!("language server request cancelled: {method}"));
                }
            }
        } else {
            response.await
        };
        match outcome {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(format!("language server closed request {method}")),
            Err(_) => {
                if self.pending.lock().await.remove(&id).is_some() {
                    let _ = self.notify("$/cancelRequest", json!({ "id": id })).await;
                }
                Err(format!("language server request timed out: {method}"))
            }
        }
    }

    pub(super) async fn cancel_document_requests(&self, uri: &str, reason: &str) {
        let cancelled = {
            let mut pending = self.pending.lock().await;
            take_pending_for_document(&mut *pending, uri)
        };
        for (id, response) in cancelled {
            let _ = response.sender.send(Err(reason.to_string()));
            let _ = self.notify("$/cancelRequest", json!({ "id": id })).await;
        }
    }

    pub(super) async fn write_message(&self, payload: &Value) -> Result<(), String> {
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

    pub(super) async fn send_server_result(&self, response_id: Value, result: Value) {
        let _ = self
            .write_message(&json!({
                "jsonrpc": "2.0",
                "id": response_id,
                "result": result,
            }))
            .await;
    }

    pub(super) async fn send_server_error(
        &self,
        response_id: Value,
        code: i64,
        message: impl Into<String>,
    ) {
        let _ = self
            .write_message(&json!({
                "jsonrpc": "2.0",
                "id": response_id,
                "error": {
                    "code": code,
                    "message": message.into()
                }
            }))
            .await;
    }

    pub(super) async fn configuration_response(
        &self,
        params: Option<&Value>,
    ) -> Result<Value, String> {
        let items = params
            .and_then(|value| value.get("items"))
            .and_then(Value::as_array)
            .ok_or_else(|| "workspace/configuration requires an items array".to_string())?;
        let configuration = self.client_configuration.read().await.clone();
        Ok(Value::Array(
            items
                .iter()
                .map(|item| {
                    let section = item.get("section").and_then(Value::as_str);
                    configuration_section_value(&configuration, section)
                })
                .collect(),
        ))
    }

    pub(super) async fn register_work_done_progress(
        &self,
        params: Option<&Value>,
    ) -> Result<Value, String> {
        let token = params
            .and_then(|value| value.get("token"))
            .filter(|token| is_progress_token(token))
            .cloned()
            .ok_or_else(|| {
                "window/workDoneProgress/create requires a string or integer token".to_string()
            })?;
        let key = progress_token_key(&token);
        let mut progress = self.work_done_progress.write().await;
        if progress.contains_key(&key) {
            return Err(format!(
                "work-done progress token '{key}' is already registered"
            ));
        }
        progress.insert(
            key,
            WorkDoneProgressState {
                token,
                cancellable: false,
                title: None,
            },
        );
        Ok(Value::Null)
    }

    pub(super) async fn handle_progress_notification(&self, params: Option<&Value>) {
        let Some(params) = params else {
            return;
        };
        let Some(token) = params
            .get("token")
            .filter(|token| is_progress_token(token))
            .cloned()
        else {
            return;
        };
        let Some(value) = params.get("value") else {
            return;
        };
        let key = progress_token_key(&token);
        if let Some(items) = value.get("items").and_then(Value::as_array) {
            let mut partial_results = self.diagnostic_partial_results.lock().await;
            if let Some(collected) = partial_results.get_mut(&key) {
                collected.extend(items.iter().cloned());
                return;
            }
        }
        let Some(kind) = value.get("kind").and_then(Value::as_str) else {
            return;
        };
        if !matches!(kind, "begin" | "report" | "end") {
            return;
        }
        let mut progress = self.work_done_progress.write().await;
        let (title, message, percentage, cancellable) = match kind {
            "begin" => {
                let title = value
                    .get("title")
                    .and_then(Value::as_str)
                    .map(ToString::to_string);
                let cancellable = value
                    .get("cancellable")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                progress.insert(
                    key.clone(),
                    WorkDoneProgressState {
                        token: token.clone(),
                        cancellable,
                        title: title.clone(),
                    },
                );
                (
                    title,
                    progress_message(value),
                    progress_percentage(value),
                    cancellable,
                )
            }
            "report" => {
                let state = progress
                    .entry(key.clone())
                    .or_insert_with(|| WorkDoneProgressState {
                        token: token.clone(),
                        cancellable: false,
                        title: None,
                    });
                if let Some(cancellable_value) = value.get("cancellable").and_then(Value::as_bool) {
                    state.cancellable = cancellable_value;
                }
                let title = state.title.clone();
                (
                    title,
                    progress_message(value),
                    progress_percentage(value),
                    state.cancellable,
                )
            }
            "end" => {
                let state = progress.remove(&key);
                (
                    state.as_ref().and_then(|state| state.title.clone()),
                    progress_message(value),
                    progress_percentage(value),
                    state
                        .as_ref()
                        .map(|state| state.cancellable)
                        .unwrap_or(false),
                )
            }
            _ => return,
        };
        drop(progress);
        self.client_bridge
            .emit_work_done_progress(LspWorkDoneProgressEvent {
                workspace_id: self.key.workspace_id.clone(),
                preset_id: self.key.preset_id.clone(),
                server_label: self.preset.display_name.clone(),
                root_uri: self.root_uri.clone(),
                token,
                kind: kind.to_string(),
                title,
                message,
                percentage,
                cancellable,
            });
    }

    pub(super) async fn cancel_work_done_progress(&self, token: &Value) -> Result<bool, String> {
        let key = progress_token_key(token);
        let mut progress = self.work_done_progress.write().await;
        let Some(state) = progress.get_mut(&key) else {
            return Ok(false);
        };
        if !state.cancellable {
            return Ok(false);
        }
        state.cancellable = false;
        let token = state.token.clone();
        drop(progress);
        self.notify("window/workDoneProgress/cancel", json!({ "token": token }))
            .await?;
        Ok(true)
    }

    pub(super) async fn handle_message(self: &Arc<Self>, message: Value) {
        if let Some(response_id) = message.get("id").cloned() {
            // Response to one of our requests.
            if message.get("method").is_none() {
                let pending_id = response_id
                    .as_u64()
                    .or_else(|| response_id.as_str().and_then(|id| id.parse::<u64>().ok()));
                let pending = if let Some(id) = pending_id {
                    self.pending.lock().await.remove(&id)
                } else {
                    None
                };
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

            let method = message.get("method").and_then(Value::as_str).unwrap_or("");
            let params = message.get("params").cloned();
            match method {
                "workspace/applyEdit" => {
                    let session = Arc::clone(self);
                    tokio::spawn(async move {
                        let result = session.apply_server_workspace_edit(params.as_ref()).await;
                        session.send_server_result(response_id, result).await;
                    });
                }
                "window/showMessageRequest" => {
                    let Some(request) = parse_show_message_request(params.as_ref()) else {
                        self.send_server_error(
                            response_id,
                            JSON_RPC_INVALID_PARAMS,
                            "window/showMessageRequest has invalid params",
                        )
                        .await;
                        return;
                    };
                    let Some(server_id) = json_rpc_id_key(&response_id) else {
                        self.send_server_error(
                            response_id,
                            -32600,
                            "Server request id must be a string or number",
                        )
                        .await;
                        return;
                    };
                    let (frontend_id, receiver) =
                        match self.client_bridge.start_show_message_request(
                            &self.key.workspace_id,
                            &self.preset.display_name,
                            request.message_type,
                            request.message,
                            request.actions,
                        ) {
                            Ok(value) => value,
                            Err(error) => {
                                self.send_server_error(response_id, JSON_RPC_INTERNAL_ERROR, error)
                                    .await;
                                return;
                            }
                        };
                    let duplicate = self
                        .incoming_show_message_requests
                        .lock()
                        .await
                        .insert(server_id.clone(), frontend_id.clone());
                    if duplicate.is_some() {
                        self.client_bridge
                            .cancel_show_message(&frontend_id, "Duplicate server request id");
                        self.send_server_error(
                            response_id,
                            -32600,
                            "A server request with this id is already pending",
                        )
                        .await;
                        return;
                    }
                    let session = Arc::clone(self);
                    tokio::spawn(async move {
                        let result = session
                            .client_bridge
                            .wait_for_show_message(&frontend_id, receiver)
                            .await;
                        let owns_request = session
                            .incoming_show_message_requests
                            .lock()
                            .await
                            .remove(&server_id)
                            .is_some_and(|id| id == frontend_id);
                        if !owns_request {
                            return;
                        }
                        match result {
                            Ok(value) => {
                                session
                                    .send_server_result(response_id, value.unwrap_or(Value::Null))
                                    .await
                            }
                            Err(error) => {
                                session
                                    .send_server_error(response_id, LSP_REQUEST_CANCELLED, error)
                                    .await
                            }
                        }
                    });
                }
                "client/registerCapability" => {
                    let result =
                        match parse_dynamic_capability_registrations_checked(params.as_ref()) {
                            Ok(registrations) => {
                                self.register_capability_values(registrations).await;
                                Ok(Value::Null)
                            }
                            Err(error) => Err(error),
                        };
                    match result {
                        Ok(value) => self.send_server_result(response_id, value).await,
                        Err(error) => {
                            self.send_server_error(response_id, JSON_RPC_INVALID_PARAMS, error)
                                .await
                        }
                    }
                }
                "client/unregisterCapability" => {
                    match parse_dynamic_capability_unregistrations_checked(params.as_ref()) {
                        Ok(ids) => {
                            self.unregister_capability_ids(ids).await;
                            self.send_server_result(response_id, Value::Null).await;
                        }
                        Err(error) => {
                            self.send_server_error(response_id, JSON_RPC_INVALID_PARAMS, error)
                                .await;
                        }
                    }
                }
                "workspace/configuration" => {
                    match self.configuration_response(params.as_ref()).await {
                        Ok(value) => self.send_server_result(response_id, value).await,
                        Err(error) => {
                            self.send_server_error(response_id, JSON_RPC_INVALID_PARAMS, error)
                                .await
                        }
                    }
                }
                "workspace/workspaceFolders" => {
                    self.send_server_result(
                        response_id,
                        json!([{ "uri": self.root_uri, "name": self.root_name }]),
                    )
                    .await;
                }
                "window/workDoneProgress/create" => {
                    match self.register_work_done_progress(params.as_ref()).await {
                        Ok(value) => self.send_server_result(response_id, value).await,
                        Err(error) => {
                            self.send_server_error(response_id, JSON_RPC_INVALID_PARAMS, error)
                                .await
                        }
                    }
                }
                "workspace/diagnostic/refresh" => {
                    self.client_bridge
                        .emit_diagnostics_refresh(LspDiagnosticsRefreshEvent {
                            workspace_id: self.key.workspace_id.clone(),
                            preset_id: self.key.preset_id.clone(),
                            root_uri: self.root_uri.clone(),
                        });
                    self.send_server_result(response_id, Value::Null).await;
                }
                "workspace/semanticTokens/refresh"
                | "workspace/inlayHint/refresh"
                | "workspace/codeLens/refresh"
                | "workspace/foldingRange/refresh"
                | "workspace/inlineValue/refresh" => {
                    self.send_server_result(response_id, Value::Null).await;
                }
                _ => {
                    self.send_server_error(
                        response_id,
                        JSON_RPC_METHOD_NOT_FOUND,
                        format!("Unsupported language server request: {method}"),
                    )
                    .await;
                }
            }
            return;
        }

        let Some(method) = message.get("method").and_then(Value::as_str) else {
            return;
        };
        let params = message.get("params");
        if method == "$/cancelRequest" {
            let Some(cancel_id) = params.and_then(|value| value.get("id")).cloned() else {
                return;
            };
            let Some(server_id) = json_rpc_id_key(&cancel_id) else {
                return;
            };
            let frontend_id = self
                .incoming_show_message_requests
                .lock()
                .await
                .remove(&server_id);
            if let Some(frontend_id) = frontend_id {
                self.client_bridge
                    .cancel_show_message(&frontend_id, "Cancelled by the language server");
                self.send_server_error(cancel_id, LSP_REQUEST_CANCELLED, "Request cancelled")
                    .await;
            }
            return;
        }
        if method == "$/progress" {
            self.handle_progress_notification(params).await;
            return;
        }
        if method == "language/status" {
            if command_is_jdtls(&self.command)
                && language_status_is_service_ready(params)
                && !self.semantic_ready.swap(true, Ordering::SeqCst)
            {
                // The existing refresh channel re-queries open documents and
                // carries the updated provider status back to the renderer.
                self.client_bridge
                    .emit_diagnostics_refresh(LspDiagnosticsRefreshEvent {
                        workspace_id: self.key.workspace_id.clone(),
                        preset_id: self.key.preset_id.clone(),
                        root_uri: self.root_uri.clone(),
                    });
            }
            return;
        }
        if method == "window/showMessage" {
            if let Some(notification) = parse_show_message_notification(params) {
                self.client_bridge.emit_show_message(LspShowMessageEvent {
                    workspace_id: self.key.workspace_id.clone(),
                    server_label: self.preset.display_name.clone(),
                    message_type: notification.message_type,
                    message: notification.message,
                });
            }
            return;
        }
        if method == "textDocument/publishDiagnostics" {
            let Some(params) = params else {
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
            let changed = {
                let mut stored = self.diagnostics.write().await;
                store_diagnostics(&mut stored, uri, diagnostics)
            };
            if changed {
                // Push-style servers never send `workspace/diagnostic/refresh`,
                // and the frontend only re-pulls on that event, a document
                // edit, or a fresh open. A publish that lands after the
                // post-open poll (cold Maven/Gradle import, workspace sweep)
                // would otherwise never reach the open editor's gutter or the
                // Problems panel, so mirror the pull-refresh signal here.
                self.client_bridge
                    .emit_diagnostics_refresh(LspDiagnosticsRefreshEvent {
                        workspace_id: self.key.workspace_id.clone(),
                        preset_id: self.key.preset_id.clone(),
                        root_uri: self.root_uri.clone(),
                    });
            }
        }
    }

    pub(super) async fn stderr_snippet(&self) -> Option<String> {
        let tail = self.stderr_tail.lock().await;
        let trimmed = tail.trim();
        if trimmed.is_empty() {
            None
        } else {
            // Keep the error toast readable; full log is still in debug logs.
            let snippet: String = trimmed
                .chars()
                .rev()
                .take(400)
                .collect::<String>()
                .chars()
                .rev()
                .collect();
            Some(snippet)
        }
    }

    pub(super) async fn shutdown(&self) {
        if self.shutting_down.swap(true, Ordering::SeqCst) {
            return;
        }
        let _ = self
            .request_with_timeout("shutdown", Value::Null, SHUTDOWN_TIMEOUT_SECS)
            .await;
        let _ = self.notify("exit", Value::Null).await;
        let _ = self.stdin.lock().await.shutdown().await;

        let mut child = self.child.lock().await;
        if tokio::time::timeout(Duration::from_secs(EXIT_TIMEOUT_SECS), child.wait())
            .await
            .is_err()
        {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        self.fail_pending("language server stopped").await;
    }

    pub(super) async fn abort(&self, error: &str) {
        self.shutting_down.store(true, Ordering::SeqCst);
        let _ = self.stdin.lock().await.shutdown().await;
        let mut child = self.child.lock().await;
        let _ = child.kill().await;
        let _ = child.wait().await;
        drop(child);
        self.fail_pending(error).await;
    }

    pub(super) async fn fail_pending(&self, error: &str) {
        let pending = std::mem::take(&mut *self.pending.lock().await);
        for response in pending.into_values() {
            let _ = response.sender.send(Err(error.to_string()));
        }
        let incoming = std::mem::take(&mut *self.incoming_show_message_requests.lock().await);
        for frontend_id in incoming.into_values() {
            self.client_bridge.cancel_show_message(&frontend_id, error);
        }
    }
}
