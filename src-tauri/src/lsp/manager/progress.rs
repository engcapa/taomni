use crate::lsp::LspManager;
use crate::lsp::LspSession;
use crate::lsp::LspSessionEntry;
use crate::lsp::client_requests::is_progress_token;
use crate::lsp::session;
use serde_json::Value;
use std::sync::Arc;

impl LspManager {
    pub(in crate::lsp) async fn cancel_work_done_progress(
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
}
