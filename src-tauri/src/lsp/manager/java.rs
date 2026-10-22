use crate::lsp::JAVA_COMMAND_TIMEOUT_SECS;
use crate::lsp::JavaSessionIdentity;
use crate::lsp::LspCustomServerCommand;
use crate::lsp::LspJavaProjectModelResult;
use crate::lsp::LspManager;
use crate::lsp::LspSession;
use crate::lsp::LspSessionEntry;
use crate::lsp::ResolvedDocument;
use crate::lsp::capabilities;
use crate::lsp::java_project::parse_java_classpath_probe;
use crate::lsp::java_project::parse_java_project_list;
use crate::lsp::java_project::scan_build_file_hashes;
use crate::lsp::java_runtime::command_is_jdtls;
use crate::lsp::paths::resolve_document;
use crate::lsp::session;
use serde_json::Value;
use serde_json::json;
use std::io::Read;
use std::sync::Arc;
use std::time::Instant;
use tokio::io::AsyncReadExt;

impl LspManager {
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
    pub(in crate::lsp) async fn java_project_model(
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
    pub(in crate::lsp) async fn notify_all_jdtls(&self, method: &str, params: Value) -> usize {
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
}
