use super::*;

impl LspManager {
    pub fn new() -> Self {
        Self::with_sdk(Arc::new(SdkManager::load(
            crate::sdk::default_sdk_registry_path(),
        )))
    }

    pub fn with_sdk(sdk: Arc<SdkManager>) -> Self {
        // Drop indexes for projects that no longer exist so the cache dir does not
        // grow without bound. Off the async path — never blocks startup.
        std::thread::spawn(prune_stale_jdtls_data_dirs);
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            last_errors: Arc::new(Mutex::new(HashMap::new())),
            sdk,
            client_bridge: Arc::new(LspClientRequestBridge::new()),
            workspace_watchers: Arc::new(Mutex::new(HashMap::new())),
            local_watched_events: Arc::new(StdMutex::new(HashMap::new())),
            workspace_symbol_resolutions: Arc::new(Mutex::new(HashMap::new())),
            workspace_symbol_queries: Arc::new(Mutex::new(HashMap::new())),
            next_workspace_symbol_query_id: AtomicU64::new(1),
        }
    }

    pub fn attach_app(&self, app: AppHandle) {
        self.client_bridge.attach_app(app);
    }

    pub(super) async fn stop_workspace_watcher(&self, workspace_id: &str) {
        let handle = self.workspace_watchers.lock().await.remove(workspace_id);
        let Some(mut handle) = handle else {
            return;
        };
        if let Some(stop) = handle.stop.take() {
            let _ = stop.send(());
        }
        handle.task.abort();
    }

    pub(super) async fn start_workspace_watcher(
        &self,
        workspace_id: &str,
        roots: Vec<String>,
    ) -> Result<(), String> {
        let mut roots = roots
            .into_iter()
            .map(|root| root.trim().to_string())
            .filter(|root| !root.is_empty())
            .collect::<Vec<_>>();
        roots.sort();
        roots.dedup();
        for root in &roots {
            if !Path::new(root).is_absolute() {
                return Err(format!(
                    "workspace watcher requires an absolute root path: {root}"
                ));
            }
        }
        self.stop_workspace_watcher(workspace_id).await;
        if roots.is_empty() {
            return Ok(());
        }

        let (event_sender, mut event_receiver) = mpsc::unbounded_channel();
        let mut watcher = RecommendedWatcher::new(
            move |event| {
                let _ = event_sender.send(event);
            },
            NotifyConfig::default(),
        )
        .map_err(|error| format!("cannot initialize workspace file watcher: {error}"))?;
        let mut watched_roots = 0;
        let mut root_errors = Vec::new();
        let mut watch_targets = Vec::new();
        let mut watch_registrations: HashMap<String, (PathBuf, bool, Vec<String>)> = HashMap::new();
        for root in &roots {
            let requested = PathBuf::from(root);
            let (watch_path, recursive, filter_path) = if requested.is_dir() {
                (requested.clone(), true, requested)
            } else if requested.exists() {
                // notify accepts files on all supported backends, but recursive
                // mode is rejected by some platform watchers for a file path.
                (requested.clone(), false, requested)
            } else if let Some(parent) = requested.parent().filter(|parent| parent.is_dir()) {
                // A loose file can be deleted before the workspace opens it. Keep
                // watching its parent so a later recreate is observable, while
                // filtering sibling events below.
                (parent.to_path_buf(), false, requested)
            } else {
                root_errors.push(format!("{root}: parent directory does not exist"));
                continue;
            };
            let mut registration_key = normalized_file_operation_path(&watch_path);
            if cfg!(windows) {
                registration_key.make_ascii_lowercase();
            }
            let registration = watch_registrations
                .entry(registration_key)
                .or_insert_with(|| (watch_path, false, Vec::new()));
            registration.1 |= recursive;
            registration.2.push(root.clone());
            watch_targets.push(WorkspaceWatchTarget {
                recursive,
                filter_path,
            });
        }
        let mut watch_registrations = watch_registrations.into_values().collect::<Vec<_>>();
        watch_registrations.sort_by(|left, right| {
            normalized_file_operation_path(&left.0).cmp(&normalized_file_operation_path(&right.0))
        });
        for (watch_path, recursive, requested_roots) in watch_registrations {
            let mode = if recursive {
                RecursiveMode::Recursive
            } else {
                RecursiveMode::NonRecursive
            };
            match watcher.watch(&watch_path, mode) {
                Ok(()) => watched_roots += 1,
                Err(error) => root_errors.push(format!("{}: {error}", requested_roots.join(", "))),
            }
        }
        if watched_roots == 0 {
            return Err(format!(
                "cannot watch workspace roots: {}",
                root_errors.join("; ")
            ));
        }

        let (stop_sender, mut stop_receiver) = oneshot::channel();
        let workspace_id = workspace_id.to_string();
        let watcher_workspace_id = workspace_id.clone();
        let sessions = self.sessions.clone();
        let client_bridge = self.client_bridge.clone();
        let local_events = self.local_watched_events.clone();
        let task = tokio::spawn(async move {
            // Keep the watcher alive for the lifetime of this task.
            let _watcher = watcher;
            let mut recent_external: HashMap<(String, u8), Instant> = HashMap::new();
            loop {
                tokio::select! {
                    _ = &mut stop_receiver => break,
                    event = event_receiver.recv() => {
                        let Some(event) = event else { break; };
                        let Ok(event) = event else {
                            log::warn!("workspace file watcher failed: {event:?}");
                            continue;
                        };
                        let changes = notify_event_changes(&event);
                        if changes.is_empty() {
                            continue;
                        }
                        let changes = changes
                            .into_iter()
                            .filter(|change| {
                                workspace_watch_target_matches(&watch_targets, &change.path)
                                    && !crate::workspace::should_skip_workspace_entry_path(&change.path)
                                    && !crate::workspace::is_workspace_write_temp_path(&change.path)
                            })
                            .collect::<Vec<_>>();
                        if changes.is_empty() {
                            continue;
                        }
                        let now = Instant::now();
                        recent_external.retain(|_, seen| now.duration_since(*seen) < Duration::from_millis(250));
                        let mut forwarded = Vec::new();
                        for change in changes {
                            let key = (change.path.clone(), change.change_type);
                            let locally_emitted = local_watched_event_suppressed(
                                &local_events,
                                &watcher_workspace_id,
                                &change.path,
                                change.change_type,
                                now,
                            );
                            if locally_emitted || recent_external.contains_key(&key) {
                                continue;
                            }
                            recent_external.insert(key, now);
                            forwarded.push(change);
                        }
                        if forwarded.is_empty() {
                            continue;
                        }
                        for change in &forwarded {
                            client_bridge.emit_external_file_change(LspExternalFileChangeEvent {
                                workspace_id: watcher_workspace_id.clone(),
                                path: change.path.clone(),
                                change_type: change.change_type,
                            });
                        }
                        let _ = notify_watched_file_sessions(&sessions, &watcher_workspace_id, &forwarded).await;
                    }
                }
            }
        });
        self.workspace_watchers.lock().await.insert(
            workspace_id,
            WorkspaceWatcherHandle {
                stop: Some(stop_sender),
                task,
            },
        );
        if !root_errors.is_empty() {
            log::warn!(
                "workspace watcher started with unavailable roots: {}",
                root_errors.join("; ")
            );
        }
        Ok(())
    }

    pub(super) fn mark_local_watched_events(
        &self,
        workspace_id: &str,
        changes: &[LspWatchedFileChange],
    ) {
        let now = Instant::now();
        let snapshots = changes
            .iter()
            .filter_map(|change| {
                local_watched_snapshot(Path::new(&change.path)).map(|snapshot| (change, snapshot))
            })
            .collect::<Vec<_>>();
        let mut local = self
            .local_watched_events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        local.retain(|_, event| now.duration_since(event.at) < Duration::from_secs(3));
        for (change, snapshot) in snapshots {
            let path = normalized_file_operation_path(Path::new(&change.path));
            let mut event_types = vec![change.change_type];
            // Atomic replacement is reported as Create/Remove by some notify
            // backends even though the logical operation is Changed. Mark the
            // equivalent variants for the short local-event suppression window.
            if change.change_type == 2 {
                event_types.extend([1, 3]);
            } else {
                event_types.push(2);
            }
            for change_type in event_types {
                local.insert(
                    (workspace_id.to_string(), path.clone(), change_type),
                    LocalWatchedEvent {
                        at: now,
                        snapshot: snapshot.clone(),
                    },
                );
            }
        }
    }

    pub(super) async fn sdk_environment(
        &self,
        document: &ResolvedDocument,
    ) -> WorkspaceSdkEnvironment {
        let scope_path = document.path.parent().unwrap_or(&document.root_path);
        match self
            .sdk
            .resolve_environment(&document.root_path, scope_path)
            .await
        {
            Ok(environment) => environment,
            Err(error) => {
                log::warn!(
                    "failed to resolve SDK environment for {}: {error}",
                    document.root_path.display()
                );
                WorkspaceSdkEnvironment::passthrough(&document.root_path, scope_path)
            }
        }
    }

    pub(super) async fn document_status(
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
                semantic_ready: false,
                selected_command_id: None,
                selected_command: None,
                install_hint: None,
                error: Some("No language server preset for this file type".into()),
                capabilities: None,
            };
        };

        let sdk_environment = self.sdk_environment(document).await;

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
        let map_key = command
            .as_ref()
            .map(|cmd| session_key(document, preset, cmd, &sdk_environment).map_key());
        let (active, starting, semantic_ready, capabilities) = if let Some(cmd) = command.as_ref() {
            let key = session_key(document, preset, cmd, &sdk_environment);
            match self.sessions.lock().await.get(&key.map_key()) {
                Some(LspSessionEntry::Ready(session)) => (
                    true,
                    false,
                    session.semantic_ready.load(Ordering::SeqCst),
                    session.capabilities.read().await.clone(),
                ),
                Some(LspSessionEntry::Starting(_)) => (false, true, false, None),
                None => (false, false, false, None),
            }
        } else {
            (false, false, false, None)
        };
        let using_custom = custom_command_to_preset(custom_command).is_some();
        let binary_available = command.is_some();
        let jdtls_runtime_error = if !active && command.as_ref().is_some_and(command_is_jdtls) {
            resolve_java_for_jdtls_with_sdk(
                sdk_environment.tooling_java_home.as_deref().map(Path::new),
                sdk_environment.tooling_java_error.as_deref(),
            )
            .err()
        } else {
            None
        };
        // jdtls needs a suitable JDK as well as the wrapper on PATH.
        let available = binary_available && jdtls_runtime_error.is_none();
        let last_error = if active || starting {
            None
        } else if let Some(key) = map_key.as_ref() {
            self.last_errors.lock().await.get(key).cloned()
        } else {
            None
        };
        LspDocumentStatus {
            path: document.path.to_string_lossy().into_owned(),
            uri: document.uri.clone(),
            preset_id: Some(preset.id.clone()),
            language_id: document.language_id.clone(),
            display_name: Some(preset.display_name.clone()),
            available,
            active,
            semantic_ready,
            selected_command_id,
            selected_command,
            // Only advertise install guidance when the binary is missing. Always
            // returning install_hint made the editor pill show "Install: …" even
            // when jdtls was on PATH but the session was still starting/failed.
            // When jdtls is present but Java is too old, prefer the runtime error
            // over a generic "install jdtls" hint.
            install_hint: if binary_available {
                None
            } else if using_custom {
                Some("Check the custom language server command".into())
            } else {
                primary_install_hint(preset)
            },
            error: if active {
                None
            } else if let Some(error) = last_error {
                Some(error)
            } else if let Some(error) = jdtls_runtime_error {
                Some(error)
            } else if binary_available {
                // Binary ok, not active, no recorded failure: idle / starting.
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

    pub(super) async fn remember_error(&self, map_key: &str, error: impl Into<String>) {
        self.last_errors
            .lock()
            .await
            .insert(map_key.to_string(), error.into());
    }

    pub(super) async fn clear_error(&self, map_key: &str) {
        self.last_errors.lock().await.remove(map_key);
    }

    pub(super) async fn ensure_session(
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
        let sdk_environment = self.sdk_environment(document).await;
        let key = session_key(document, preset, &command, &sdk_environment);
        let map_key = key.map_key();
        let start = match self.claim_session(&map_key, &document.workspace_id).await {
            LspSessionClaim::Ready(session) => {
                self.clear_error(&map_key).await;
                return Ok(session);
            }
            LspSessionClaim::Wait(start) => {
                return match start.wait().await {
                    Ok(session) => {
                        self.clear_error(&map_key).await;
                        Ok(session)
                    }
                    Err(error) => {
                        self.remember_error(&map_key, error.clone()).await;
                        Err(session_start_error_status(
                            document, preset, &command, error,
                        ))
                    }
                };
            }
            LspSessionClaim::Start(start) => {
                // Clear a previous exit error so the UI can show "starting…"
                // while this attempt is in flight.
                self.clear_error(&map_key).await;
                start
            }
        };

        // Fail fast with a Settings-visible message before spawning when the
        // JDK is too old for current Eclipse JDT LS (all platforms).
        if command_is_jdtls(&command)
            && let Err(error) = resolve_java_for_jdtls_with_sdk(
                sdk_environment.tooling_java_home.as_deref().map(Path::new),
                sdk_environment.tooling_java_error.as_deref(),
            )
        {
            let _ = self
                .finish_session_start(&map_key, &start, Err(error.clone()))
                .await;
            self.remember_error(&map_key, error.clone()).await;
            return Err(session_start_error_status(
                document, preset, &command, error,
            ));
        }

        let session_root =
            lsp_session_root(&document.root_path, &sdk_environment.project_scope_path);
        let session_root_uri = match url::Url::from_directory_path(&session_root) {
            Ok(uri) => uri.to_string(),
            Err(_) => {
                let error = format!(
                    "Cannot convert SDK project scope to file URI: {}",
                    session_root.display()
                );
                let _ = self
                    .finish_session_start(&map_key, &start, Err(error.clone()))
                    .await;
                self.remember_error(&map_key, error.clone()).await;
                return Err(session_start_error_status(
                    document, preset, &command, error,
                ));
            }
        };
        let result = LspSession::spawn(
            key.clone(),
            preset.clone(),
            command.clone(),
            session_root,
            session_root_uri,
            sdk_environment,
            self.sessions.clone(),
            self.last_errors.clone(),
            self.client_bridge.clone(),
            map_key.clone(),
            start.clone(),
        )
        .await;
        let result = self.finish_session_start(&map_key, &start, result).await;
        match &result {
            Ok(_) => self.clear_error(&map_key).await,
            Err(error) => self.remember_error(&map_key, error.clone()).await,
        }
        result.map_err(|error| session_start_error_status(document, preset, &command, error))
    }

    pub(super) async fn claim_session(&self, map_key: &str, workspace_id: &str) -> LspSessionClaim {
        let mut sessions = self.sessions.lock().await;
        match sessions.get(map_key) {
            Some(LspSessionEntry::Ready(session)) => LspSessionClaim::Ready(session.clone()),
            Some(LspSessionEntry::Starting(start)) => LspSessionClaim::Wait(start.clone()),
            None => {
                let start = Arc::new(LspSessionStart::new(workspace_id.to_string()));
                sessions.insert(
                    map_key.to_string(),
                    LspSessionEntry::Starting(start.clone()),
                );
                LspSessionClaim::Start(start)
            }
        }
    }

    pub(super) async fn finish_session_start(
        &self,
        map_key: &str,
        start: &Arc<LspSessionStart>,
        result: Result<Arc<LspSession>, String>,
    ) -> Result<Arc<LspSession>, String> {
        let mut sessions = self.sessions.lock().await;
        let owns_slot = matches!(
            sessions.get(map_key),
            Some(LspSessionEntry::Starting(current)) if Arc::ptr_eq(current, start)
        );
        if owns_slot {
            match result.as_ref() {
                Ok(session) => {
                    sessions.insert(map_key.to_string(), LspSessionEntry::Ready(session.clone()));
                }
                Err(_) => {
                    sessions.remove(map_key);
                }
            }
        }
        drop(sessions);
        if !owns_slot && let Ok(session) = result.as_ref() {
            session.shutdown().await;
        }
        start.complete(result).await;
        start.wait().await
    }

    pub(super) async fn stop_workspace(&self, workspace_id: &str) -> usize {
        self.stop_workspace_watcher(workspace_id).await;
        if let Some((_, cancellation)) = self
            .workspace_symbol_queries
            .lock()
            .await
            .remove(workspace_id)
        {
            cancellation.cancel();
        }
        self.workspace_symbol_resolutions
            .lock()
            .await
            .retain(|_, batch| batch.workspace_id != workspace_id);
        let (starts, ready) = {
            let mut sessions = self.sessions.lock().await;
            let matching: Vec<String> = sessions
                .iter()
                .filter_map(|(map_key, entry)| {
                    (entry.workspace_id() == workspace_id).then(|| map_key.clone())
                })
                .collect();
            let mut starts = Vec::new();
            let mut ready = Vec::new();
            for map_key in matching {
                match sessions.remove(&map_key) {
                    Some(LspSessionEntry::Starting(start)) => starts.push(start),
                    Some(LspSessionEntry::Ready(session)) => ready.push(session),
                    None => {}
                }
            }
            (starts, ready)
        };
        let stopped = starts.len() + ready.len();
        for start in starts {
            start
                .cancel(format!("LSP workspace stopped: {workspace_id}"))
                .await;
        }
        for session in ready {
            session.shutdown().await;
        }
        stopped
    }

    pub(super) async fn active_session(
        &self,
        document: &ResolvedDocument,
        preferred_command_id: Option<&str>,
        custom_command: Option<&LspCustomServerCommand>,
    ) -> Option<Arc<LspSession>> {
        let preset = document.preset.as_ref()?;
        let command = select_available_command(preset, preferred_command_id, custom_command)?;
        let sdk_environment = self.sdk_environment(document).await;
        let key = session_key(document, preset, &command, &sdk_environment);
        match self.sessions.lock().await.get(&key.map_key()) {
            Some(LspSessionEntry::Ready(session)) => Some(session.clone()),
            Some(LspSessionEntry::Starting(_)) | None => None,
        }
    }

    /// Run a jdtls `workspace/executeCommand` on the active session for a project
    /// file (M8): the shared jdtls access path for the Java debug adapter (D2,
    /// `vscode.java.resolveClasspath` / `startDebugSession` …) and test discovery
    /// (E, `vscode.java.test.*`). Errors when no jdtls session is active.
    pub async fn execute_java_command(
        &self,
        workspace_id: String,
        root_path: Option<String>,
        file_path: String,
        command: &str,
        arguments: Vec<Value>,
        identity: JavaSessionIdentity,
    ) -> Result<Value, String> {
        let document =
            resolve_document(workspace_id, root_path, file_path, Some("java".into()), 0)?;
        // Debug + test must target the SAME jdtls session the editor uses. When a
        // custom jdtls command is configured, the default `active_session(None,
        // None)` lookup recomputes the default `jdtls` session key and misses the
        // custom one — so intelligence works while debug/test report "no active
        // Java language server". Forward the caller's command identity so the
        // session key matches the editor's.
        let session = self
            .active_session(
                &document,
                identity.preferred_command_id.as_deref(),
                identity.custom_command.as_ref(),
            )
            .await
            .ok_or_else(|| {
                "No Java language server session is active for this project; open a project file first"
                    .to_string()
            })?;
        let started = Instant::now();
        let result = session
            .request_with_timeout(
                "workspace/executeCommand",
                json!({ "command": command, "arguments": arguments }),
                JAVA_COMMAND_TIMEOUT_SECS,
            )
            .await;
        match &result {
            Ok(_) => log::info!("lsp: {command} ok in {:?}", started.elapsed()),
            Err(error) => log::warn!(
                "lsp: {command} failed after {:?}: {error}",
                started.elapsed()
            ),
        }
        result
    }

    /// §8.20.3 W2: gather provider-owned Project Analysis facts for the
    /// session that would serve this document. Never errors — unavailable
    /// probes are reported through `probe_reason` so the UI can stay honest
    /// about WHY module details are missing.
    pub(super) async fn java_project_model(
        &self,
        document: &ResolvedDocument,
        preferred_command_id: Option<&str>,
        custom_command: Option<&LspCustomServerCommand>,
    ) -> LspJavaProjectModelResult {
        let status = self
            .document_status(document, preferred_command_id, custom_command)
            .await;
        let mut result = LspJavaProjectModelResult {
            status,
            active: false,
            process_id: None,
            server_name: None,
            server_version: None,
            registered_commands: Vec::new(),
            build_files: scan_build_file_hashes(&document.root_path),
            java_home_used: None,
            java_projects: Vec::new(),
            classpath_probe: None,
            probe_reason: None,
        };
        let Some(session) = self
            .active_session(document, preferred_command_id, custom_command)
            .await
        else {
            result.probe_reason = Some("no-active-session".into());
            return result;
        };
        result.active = true;
        result.process_id = session.child.lock().await.id();
        result.java_home_used = session
            .tooling_java_home_used
            .lock()
            .await
            .clone()
            .map(|home| home.to_string_lossy().into_owned());
        if let Some(server_info) = session.server_info.read().await.as_ref() {
            result.server_name = server_info
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_owned);
            result.server_version = server_info
                .get("version")
                .and_then(Value::as_str)
                .map(str::to_owned);
        }
        // Registered executeCommand names gate every probe: a provider that
        // never registered `java.project.*` simply reports lifecycle facts.
        let registered: Vec<String> = {
            let capabilities = session.dynamic_capabilities.read().await;
            let mut commands: Vec<String> = capabilities
                .values()
                .filter(|registration| registration.method == "workspace/executeCommand")
                .flat_map(|registration| {
                    registration
                        .register_options
                        .get("commands")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default()
                })
                .filter_map(|command| command.as_str().map(str::to_owned))
                .collect();
            commands.sort();
            commands.dedup();
            commands
        };

        if registered
            .iter()
            .any(|command| command == "java.project.list")
        {
            match session
                .request_with_timeout(
                    "workspace/executeCommand",
                    json!({ "command": "java.project.list", "arguments": [] }),
                    JAVA_COMMAND_TIMEOUT_SECS,
                )
                .await
            {
                Ok(value) => result.java_projects = parse_java_project_list(&value),
                Err(error) => {
                    result.probe_reason = Some(format!("java.project.list-failed:{error}"));
                }
            }
        }

        if registered
            .iter()
            .any(|command| command == "java.project.getClasspaths")
        {
            match session
                .request_with_timeout(
                    "workspace/executeCommand",
                    json!({
                        "command": "java.project.getClasspaths",
                        "arguments": [document.uri],
                    }),
                    JAVA_COMMAND_TIMEOUT_SECS,
                )
                .await
            {
                Ok(value) => match parse_java_classpath_probe(&value) {
                    Some(mut probe) => {
                        probe.root_uri.get_or_insert_with(|| document.uri.clone());
                        result.classpath_probe = Some(probe);
                    }
                    None => {
                        result.probe_reason =
                            Some("java.project.getClasspaths-unrecognized-shape".into());
                    }
                },
                Err(error) => {
                    result.probe_reason =
                        Some(format!("java.project.getClasspaths-failed:{error}"));
                }
            }
        } else if result.probe_reason.is_none() {
            result.probe_reason = Some("command-not-registered:java.project.getClasspaths".into());
        }
        result.registered_commands = registered;
        result
    }

    /// Push a `workspace/didChangeConfiguration` to every ready jdtls session so
    /// `java.*` settings changes take effect without restarting the servers.
    pub(super) async fn notify_all_jdtls(&self, method: &str, params: Value) -> usize {
        let sessions: Vec<Arc<LspSession>> = {
            let guard = self.sessions.lock().await;
            guard
                .values()
                .filter_map(|entry| match entry {
                    LspSessionEntry::Ready(session) if command_is_jdtls(&session.command) => {
                        Some(session.clone())
                    }
                    _ => None,
                })
                .collect()
        };
        let mut notified = 0;
        for session in sessions {
            if method == "workspace/didChangeConfiguration"
                && let Some(settings) = params.get("settings")
            {
                session.merge_client_configuration(settings).await;
            }
            if session.notify(method, params.clone()).await.is_ok() {
                notified += 1;
            }
        }
        notified
    }

    pub(super) async fn cancel_work_done_progress(
        &self,
        workspace_id: &str,
        preset_id: &str,
        root_uri: &str,
        token: &Value,
    ) -> Result<bool, String> {
        if !is_progress_token(token) {
            return Err("work-done progress token must be a string or integer".into());
        }
        let sessions: Vec<Arc<LspSession>> = {
            let guard = self.sessions.lock().await;
            guard
                .values()
                .filter_map(|entry| match entry {
                    LspSessionEntry::Ready(session)
                        if session.key.workspace_id == workspace_id
                            && session.key.preset_id == preset_id
                            && session.root_uri == root_uri =>
                    {
                        Some(session.clone())
                    }
                    _ => None,
                })
                .collect()
        };
        let mut cancelled = false;
        for session in sessions {
            cancelled |= session.cancel_work_done_progress(token).await?;
        }
        Ok(cancelled)
    }

    pub(super) async fn workspace_file_operation_sessions(
        &self,
        workspace_id: &str,
    ) -> Vec<Arc<LspSession>> {
        let guard = self.sessions.lock().await;
        let mut sessions = guard
            .iter()
            .filter_map(|(key, entry)| match entry {
                LspSessionEntry::Ready(session) if session.key.workspace_id == workspace_id => {
                    Some((key.clone(), session.clone()))
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        sessions.sort_by(|left, right| left.0.cmp(&right.0));
        sessions.into_iter().map(|(_, session)| session).collect()
    }

    pub(super) async fn will_workspace_file_operation(
        &self,
        workspace_id: &str,
        operation: &LspWorkspaceFileOperation,
    ) -> Result<usize, String> {
        let method = operation.will_method();
        let sessions = self.workspace_file_operation_sessions(workspace_id).await;
        let mut requested = 0;
        let mut applied_edits = 0;
        for session in sessions {
            let Some(params) = session
                .workspace_file_operation_params(method, operation)
                .await?
            else {
                continue;
            };
            requested += 1;
            let result = session.request(method, params).await.map_err(|error| {
                format!(
                    "{} could not prepare for {}: {error}",
                    session.preset.display_name,
                    operation.label()
                )
            })?;
            if result.is_null() {
                continue;
            }
            if !result.is_object() {
                return Err(format!(
                    "{} returned an invalid {method} result",
                    session.preset.display_name
                ));
            }
            let edit = parse_workspace_edit(&result);
            if edit.operations.is_empty() {
                continue;
            }
            let response = self
                .client_bridge
                .apply_workspace_edit(
                    workspace_id,
                    Some(format!(
                        "{} before {}",
                        session.preset.display_name,
                        operation.label()
                    )),
                    edit,
                )
                .await;
            if !response.applied {
                let failed_change = response
                    .failed_change
                    .map(|index| format!(" at change {index}"))
                    .unwrap_or_default();
                let partial = (applied_edits > 0)
                    .then(|| {
                        format!("; {applied_edits} earlier server edit(s) were already applied")
                    })
                    .unwrap_or_default();
                return Err(format!(
                    "Cannot continue {}: {}{}{}",
                    operation.label(),
                    response
                        .failure_reason
                        .unwrap_or_else(|| "language-server edit was not applied".into()),
                    failed_change,
                    partial
                ));
            }
            applied_edits += 1;
        }
        Ok(requested)
    }

    pub(super) async fn did_workspace_file_operation(
        &self,
        workspace_id: &str,
        operation: &LspWorkspaceFileOperation,
    ) -> usize {
        let method = operation.did_method();
        let sessions = self.workspace_file_operation_sessions(workspace_id).await;
        let mut notified = 0;
        for session in sessions {
            let params = match session
                .workspace_file_operation_params(method, operation)
                .await
            {
                Ok(Some(params)) => params,
                Ok(None) => continue,
                Err(error) => {
                    log::warn!(
                        "cannot prepare {method} for {}: {error}",
                        session.preset.display_name
                    );
                    continue;
                }
            };
            match session.notify(method, params).await {
                Ok(()) => notified += 1,
                Err(error) => log::warn!(
                    "cannot notify {} with {method}: {error}",
                    session.preset.display_name
                ),
            }
        }
        let watched_changes = operation.watched_file_changes();
        if !watched_changes.is_empty() {
            let watched_sessions = self
                .did_change_watched_files(workspace_id, &watched_changes)
                .await;
            log::debug!(
                "lsp: forwarded {} watched-file event batch(es) after {}",
                watched_sessions,
                operation.label()
            );
        }
        notified
    }

    pub(super) async fn did_change_watched_files(
        &self,
        workspace_id: &str,
        changes: &[LspWatchedFileChange],
    ) -> usize {
        if changes.is_empty() {
            return 0;
        }
        self.mark_local_watched_events(workspace_id, changes);
        notify_watched_file_sessions(&self.sessions, workspace_id, changes).await
    }

    /// Refresh pull-capable servers, then collect every stored diagnostic across
    /// ready sessions for `workspace_id` (M7-C). Includes files the user never
    /// opened, de-duplicated per file (later sessions win) and sorted by path.
    /// Library / virtual (`jdt://`, non-`file:`) URIs are skipped.
    pub(super) async fn workspace_diagnostics(
        &self,
        workspace_id: &str,
    ) -> Vec<WorkspaceDiagnosticFile> {
        let sessions: Vec<Arc<LspSession>> = {
            let guard = self.sessions.lock().await;
            let mut sessions = guard
                .values()
                .filter_map(|entry| match entry {
                    LspSessionEntry::Ready(session) if session.key.workspace_id == workspace_id => {
                        Some(session.clone())
                    }
                    _ => None,
                })
                .collect::<Vec<_>>();
            sessions.sort_by(|left, right| left.key.map_key().cmp(&right.key.map_key()));
            sessions
        };
        let pull_results = futures::future::join_all(
            sessions
                .iter()
                .map(|session| session.pull_workspace_diagnostics()),
        )
        .await;
        for (session, result) in sessions.iter().zip(pull_results) {
            if let Err(error) = result {
                // Keep publishDiagnostics data available when a server's advertised
                // pull provider fails. This path may run on a short polling interval,
                // so avoid repeating the same failure as a warning-level toast/log.
                log::debug!(
                    "lsp: workspace/diagnostic failed for {}: {error}",
                    session.preset.display_name
                );
            }
        }
        let mut by_path: HashMap<String, WorkspaceDiagnosticFile> = HashMap::new();
        for session in sessions {
            for (uri, diagnostics) in session.diagnostics.read().await.iter() {
                if diagnostics.is_empty() {
                    continue;
                }
                let Some(path) = file_path_from_uri(uri) else {
                    continue;
                };
                by_path.insert(
                    path.clone(),
                    WorkspaceDiagnosticFile {
                        path,
                        uri: uri.clone(),
                        diagnostics: diagnostics.clone(),
                    },
                );
            }
        }
        let mut files: Vec<WorkspaceDiagnosticFile> = by_path.into_values().collect();
        files.sort_by(|a, b| a.path.cmp(&b.path));
        files
    }

    /// Query every ready language-server session in a workspace for
    /// `workspace/symbol`. The old command path queried only the session that
    /// owned the active document, which silently dropped symbols from other
    /// roots and languages in a multi-root project.
    pub(super) async fn workspace_symbols(
        &self,
        workspace_id: &str,
        query: &str,
    ) -> Result<WorkspaceSymbolsAggregation, String> {
        let query_id = self
            .next_workspace_symbol_query_id
            .fetch_add(1, Ordering::SeqCst);
        let cancellation = {
            let mut queries = self.workspace_symbol_queries.lock().await;
            begin_workspace_symbol_query(&mut queries, workspace_id, query_id)
        };
        let sessions: Vec<Arc<LspSession>> = {
            let guard = self.sessions.lock().await;
            let mut sessions = guard
                .values()
                .filter_map(|entry| match entry {
                    LspSessionEntry::Ready(session) if session.key.workspace_id == workspace_id => {
                        Some(session.clone())
                    }
                    _ => None,
                })
                .collect::<Vec<_>>();
            sessions.sort_by(|left, right| left.key.map_key().cmp(&right.key.map_key()));
            sessions
        };

        let session_count = sessions.len() as u32;
        let provider_limit_reached = sessions.len() > MAX_WORKSPACE_SYMBOL_PROVIDERS;

        let capability_checks = sessions
            .into_iter()
            .take(MAX_WORKSPACE_SYMBOL_PROVIDERS)
            .map(|session| async move {
                let capabilities = session.capabilities.read().await;
                let capabilities = capabilities.as_ref()?;
                capabilities
                    .workspace_symbol
                    .then_some((session.clone(), capabilities.workspace_symbol_resolve))
            });
        let capable = futures::future::join_all(capability_checks)
            .await
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
        let provider_count = capable.len() as u32;
        // `capable` is collected only from the bounded session prefix, so all
        // other ready sessions (including sessions without the capability and
        // sessions beyond the fan-out limit) are intentionally skipped.
        let skipped_provider_count = session_count.saturating_sub(provider_count);
        let responses = futures::future::join_all(
            capable
                .into_iter()
                .take(MAX_WORKSPACE_SYMBOL_PROVIDERS)
                .map(|(session, supports_resolve)| {
                    let cancellation = cancellation.clone();
                    async move {
                        let label = session.preset.display_name.clone();
                        let result = session
                            .request_with_cancellation(
                                "workspace/symbol",
                                json!({ "query": query }),
                                &cancellation,
                            )
                            .await;
                        (label, session.key.map_key(), supports_resolve, result)
                    }
                }),
        )
        .await;
        let mut aggregation = aggregate_workspace_symbol_responses(
            responses,
            session_count,
            provider_count,
            skipped_provider_count,
            provider_limit_reached,
        );
        // Serialize the latest-query check with replacement so an old query
        // cannot pass the check and then populate the resolve cache after a
        // newer query starts.
        let mut queries = self.workspace_symbol_queries.lock().await;
        let is_latest = queries
            .get(workspace_id)
            .is_some_and(|(current_id, _)| *current_id == query_id);
        if cancellation.is_cancelled() || !is_latest {
            return Err("Workspace symbol query was superseded by a newer query".into());
        }
        self.cache_workspace_symbol_resolutions(workspace_id, &mut aggregation)
            .await;
        queries.remove(workspace_id);
        Ok(aggregation)
    }

    pub(super) async fn cache_workspace_symbol_resolutions(
        &self,
        workspace_id: &str,
        aggregation: &mut WorkspaceSymbolsAggregation,
    ) {
        if !aggregation
            .symbols
            .iter()
            .any(|symbol| symbol.raw.is_some())
        {
            return;
        }

        let sessions = {
            let sessions = self.sessions.lock().await;
            sessions
                .iter()
                .filter_map(|(key, entry)| match entry {
                    LspSessionEntry::Ready(session) if session.key.workspace_id == workspace_id => {
                        Some((key.clone(), Arc::downgrade(session)))
                    }
                    _ => None,
                })
                .collect::<HashMap<_, _>>()
        };
        let batch_id = uuid::Uuid::new_v4().simple().to_string();
        let mut bytes = 0usize;
        let mut entries = HashMap::new();
        let mut skipped = 0usize;
        for (index, symbol) in aggregation.symbols.iter_mut().enumerate() {
            let Some(raw) = symbol.raw.take() else {
                continue;
            };
            let Some(provider_session_key) = symbol.provider_session_key.take() else {
                skipped += 1;
                continue;
            };
            let raw_bytes = match serde_json::to_vec(&raw) {
                Ok(value) => value.len(),
                Err(_) => {
                    skipped += 1;
                    continue;
                }
            };
            let Some(session) = sessions.get(&provider_session_key) else {
                skipped += 1;
                continue;
            };
            if raw_bytes > MAX_WORKSPACE_SYMBOL_RAW_BYTES
                || bytes.saturating_add(raw_bytes) > MAX_WORKSPACE_SYMBOL_RESOLUTION_BATCH_BYTES
            {
                skipped += 1;
                continue;
            }
            let entry_id = index.to_string();
            entries.insert(
                entry_id.clone(),
                WorkspaceSymbolResolutionEntry {
                    session: session.clone(),
                    raw,
                },
            );
            bytes += raw_bytes;
            symbol.resolve_token = Some(format!("{batch_id}:{entry_id}"));
        }
        if entries.is_empty() {
            if skipped > 0 {
                push_workspace_symbol_diagnostic(
                    &mut aggregation.diagnostics,
                    "Workspace symbol resolve payloads exceeded the bounded cache".into(),
                );
                aggregation.complete = false;
                aggregation.truncated = true;
            }
            return;
        }

        let now = Instant::now();
        let mut batches = self.workspace_symbol_resolutions.lock().await;
        prune_workspace_symbol_resolution_batches(&mut batches, now);
        batches.insert(
            batch_id,
            WorkspaceSymbolResolutionBatch {
                workspace_id: workspace_id.to_string(),
                created_at: now,
                bytes,
                entries,
            },
        );
        prune_workspace_symbol_resolution_batches(&mut batches, now);
        if skipped > 0 {
            push_workspace_symbol_diagnostic(
                &mut aggregation.diagnostics,
                format!("{skipped} workspace symbol resolve payloads exceeded the bounded cache"),
            );
            aggregation.complete = false;
            aggregation.truncated = true;
        }
    }

    pub(super) async fn resolve_workspace_symbol(
        &self,
        workspace_id: &str,
        resolve_token: &str,
    ) -> Result<LspWorkspaceSymbol, String> {
        let (batch_id, entry_id) = parse_workspace_symbol_resolve_token(resolve_token)?;
        let entry = {
            let now = Instant::now();
            let mut batches = self.workspace_symbol_resolutions.lock().await;
            prune_workspace_symbol_resolution_batches(&mut batches, now);
            let batch = batches
                .get(batch_id)
                .ok_or_else(|| "Workspace symbol resolve token expired".to_string())?;
            if batch.workspace_id != workspace_id {
                return Err("Workspace symbol resolve token belongs to another workspace".into());
            }
            batch
                .entries
                .get(entry_id)
                .cloned()
                .ok_or_else(|| "Workspace symbol resolve token is invalid".to_string())?
        };
        let session = entry
            .session
            .upgrade()
            .ok_or_else(|| "Workspace symbol provider session is no longer active".to_string())?;
        if session.key.workspace_id != workspace_id {
            return Err("Workspace symbol provider session changed".into());
        }
        let resolved = session
            .request("workspaceSymbol/resolve", entry.raw.clone())
            .await?;
        let merged = merge_workspace_symbol_values(&entry.raw, &resolved);
        let symbol = parse_workspace_symbol(&merged)
            .ok_or_else(|| "workspaceSymbol/resolve returned an invalid symbol".to_string())?;
        if !symbol.resolved {
            return Err("workspaceSymbol/resolve did not return a source range".into());
        }
        Ok(symbol)
    }
}
