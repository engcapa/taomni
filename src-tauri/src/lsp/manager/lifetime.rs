use crate::lsp::LspClientRequestBridge;
use crate::lsp::LspCustomServerCommand;
use crate::lsp::LspDocumentStatus;
use crate::lsp::LspManager;
use crate::lsp::LspSession;
use crate::lsp::LspSessionClaim;
use crate::lsp::LspSessionEntry;
use crate::lsp::LspSessionStart;
use crate::lsp::ResolvedDocument;
use crate::lsp::java_runtime::command_is_jdtls;
use crate::lsp::java_runtime::prune_stale_jdtls_data_dirs;
use crate::lsp::java_runtime::resolve_java_for_jdtls_with_sdk;
use crate::lsp::paths::lsp_session_root;
use crate::lsp::paths::session_key;
use crate::lsp::presets::select_available_command;
use crate::lsp::session;
use crate::lsp::session::session_start_error_status;
use crate::sdk::SdkManager;
use crate::sdk::WorkspaceSdkEnvironment;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::sync::atomic::AtomicU64;
use tauri::AppHandle;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

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

    pub(in crate::lsp) async fn sdk_environment(
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

    pub(in crate::lsp) async fn ensure_session(
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

    pub(in crate::lsp) async fn claim_session(
        &self,
        map_key: &str,
        workspace_id: &str,
    ) -> LspSessionClaim {
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

    pub(in crate::lsp) async fn finish_session_start(
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

    pub(in crate::lsp) async fn stop_workspace(&self, workspace_id: &str) -> usize {
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

    pub(in crate::lsp) async fn active_session(
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
}
