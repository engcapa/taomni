use crate::lsp::LspManager;
use crate::lsp::LspSession;
use crate::lsp::LspSessionEntry;
use crate::lsp::WorkspaceDiagnosticFile;
use crate::lsp::diagnostics;
use crate::lsp::file_path_from_uri;
use crate::lsp::session;
use std::collections::HashMap;
use std::io::Read;
use std::sync::Arc;
use tokio::io::AsyncReadExt;

impl LspManager {
    /// Refresh pull-capable servers, then collect every stored diagnostic across
    /// ready sessions for `workspace_id` (M7-C). Includes files the user never
    /// opened, de-duplicated per file (later sessions win) and sorted by path.
    /// Library / virtual (`jdt://`, non-`file:`) URIs are skipped.
    pub(in crate::lsp) async fn workspace_diagnostics(
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
}
