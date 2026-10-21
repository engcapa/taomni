use crate::lsp::LspManager;
use crate::lsp::LspSession;
use crate::lsp::LspSessionEntry;
use crate::lsp::edit_types::LspWorkspaceFileOperation;
use crate::lsp::edits::parse_workspace_edit;
use crate::lsp::session;
use std::sync::Arc;

impl LspManager {
    pub(in crate::lsp) async fn workspace_file_operation_sessions(
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

    pub(in crate::lsp) async fn will_workspace_file_operation(
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

    pub(in crate::lsp) async fn did_workspace_file_operation(
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
}
