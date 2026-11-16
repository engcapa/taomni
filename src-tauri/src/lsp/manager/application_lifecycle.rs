//! Whole-application cleanup belongs to the shared runtime, not a view.
use crate::lsp::{LspManager, LspSessionEntry};
impl LspManager {
    pub(crate) fn prune_stale_caches() {
        crate::lsp::java_runtime::prune_stale_jdtls_data_dirs();
    }
    pub(crate) async fn shutdown(&self) {
        let workspaces: Vec<_> = self
            .workspace_watchers
            .lock()
            .await
            .keys()
            .cloned()
            .collect();
        for workspace in workspaces {
            self.stop_workspace_watcher(&workspace).await;
        }
        for (_, (_, cancellation)) in self.workspace_symbol_queries.lock().await.drain() {
            cancellation.cancel();
        }
        self.workspace_symbol_resolutions.lock().await.clear();
        let sessions = std::mem::take(&mut *self.sessions.lock().await);
        for (_, session) in sessions {
            match session {
                LspSessionEntry::Starting(start) => {
                    start.cancel("Application is shutting down".into()).await
                }
                LspSessionEntry::Ready(session) => session.shutdown().await,
            }
        }
    }
}
