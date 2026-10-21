use crate::lsp::LspCustomServerCommand;
use crate::lsp::LspDocumentStatus;
use crate::lsp::LspManager;
use crate::lsp::LspSessionEntry;
use crate::lsp::ResolvedDocument;
use crate::lsp::capabilities;
use crate::lsp::java_runtime::command_is_jdtls;
use crate::lsp::java_runtime::resolve_java_for_jdtls_with_sdk;
use crate::lsp::paths::session_key;
use crate::lsp::presets::cmd;
use crate::lsp::presets::command_line;
use crate::lsp::presets::configured_command;
use crate::lsp::presets::custom_command_to_preset;
use crate::lsp::presets::primary_install_hint;
use crate::lsp::presets::select_available_command;
use crate::lsp::session;
use std::io::Read;
use std::path::Path;
use std::sync::atomic::Ordering;
use tokio::io::AsyncReadExt;

impl LspManager {
    pub(in crate::lsp) async fn document_status(
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

    pub(in crate::lsp) async fn remember_error(&self, map_key: &str, error: impl Into<String>) {
        self.last_errors
            .lock()
            .await
            .insert(map_key.to_string(), error.into());
    }

    pub(in crate::lsp) async fn clear_error(&self, map_key: &str) {
        self.last_errors.lock().await.remove(map_key);
    }
}
