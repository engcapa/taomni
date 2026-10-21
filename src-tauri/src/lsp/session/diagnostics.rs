use crate::lsp::LspSession;
use crate::lsp::WORKSPACE_DIAGNOSTIC_TIMEOUT_SECS;
use crate::lsp::capabilities::workspace_diagnostic_provider_options;
use crate::lsp::client_requests::progress_token_key;
use crate::lsp::diagnostics;
use crate::lsp::diagnostics::apply_workspace_diagnostic_report;
use crate::lsp::diagnostics::merge_workspace_diagnostic_partial_results;
use crate::lsp::edits::parse_workspace_edit;
use serde_json::Value;
use serde_json::json;
use std::io::Read;
use std::sync::atomic::Ordering;
use tokio::io::AsyncReadExt;

impl LspSession {
    /// Pull project diagnostics when the server implements LSP 3.17's
    /// `workspace/diagnostic`. Push diagnostics remain authoritative for
    /// servers without this provider, and remain as a fallback if a pull fails.
    pub(in crate::lsp) async fn pull_workspace_diagnostics(&self) -> Result<bool, String> {
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

    pub(in crate::lsp) async fn apply_server_workspace_edit(
        &self,
        params: Option<&Value>,
    ) -> Value {
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
}
