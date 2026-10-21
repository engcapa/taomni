use crate::lsp::DynamicCapabilityRegistration;
use crate::lsp::LspSession;
use crate::lsp::capabilities::capability_state_from;
use crate::lsp::client_requests::configuration_section_value;
use crate::lsp::edit_types::LspWatchedFileChange;
use crate::lsp::edit_types::LspWorkspaceFileOperation;
use crate::lsp::watcher::file_operation_filters_from;
use crate::lsp::watcher::file_operation_uri;
use crate::lsp::watcher::watch_kind_for_change;
use crate::lsp::watcher::watched_file_registration_matches;
use crate::lsp::watcher::workspace_file_operation_params;
use serde_json::Value;
use serde_json::json;
use std::collections::HashSet;
use std::io::Read;
use std::sync::atomic::Ordering;
use tokio::io::AsyncReadExt;

impl LspSession {
    pub(in crate::lsp) async fn refresh_capabilities(&self) {
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

    pub(in crate::lsp) async fn register_capability_values(
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

    pub(in crate::lsp) async fn unregister_capability_ids(&self, ids: Vec<String>) {
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

    pub(in crate::lsp) async fn workspace_file_operation_params(
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

    pub(in crate::lsp) async fn watched_file_params(
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

    pub(in crate::lsp) async fn configuration_response(
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
}
