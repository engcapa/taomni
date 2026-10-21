use crate::lsp::EXIT_TIMEOUT_SECS;
use crate::lsp::LspSession;
use crate::lsp::SHUTDOWN_TIMEOUT_SECS;
use serde_json::Value;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tokio::io::AsyncWriteExt;

impl LspSession {
    pub(in crate::lsp) async fn stderr_snippet(&self) -> Option<String> {
        let tail = self.stderr_tail.lock().await;
        let trimmed = tail.trim();
        if trimmed.is_empty() {
            None
        } else {
            // Keep the error toast readable; full log is still in debug logs.
            let snippet: String = trimmed
                .chars()
                .rev()
                .take(400)
                .collect::<String>()
                .chars()
                .rev()
                .collect();
            Some(snippet)
        }
    }

    pub(in crate::lsp) async fn shutdown(&self) {
        if self.shutting_down.swap(true, Ordering::SeqCst) {
            return;
        }
        let _ = self
            .request_with_timeout("shutdown", Value::Null, SHUTDOWN_TIMEOUT_SECS)
            .await;
        let _ = self.notify("exit", Value::Null).await;
        let _ = self.stdin.lock().await.shutdown().await;

        let mut child = self.child.lock().await;
        if tokio::time::timeout(Duration::from_secs(EXIT_TIMEOUT_SECS), child.wait())
            .await
            .is_err()
        {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        self.fail_pending("language server stopped").await;
    }

    pub(in crate::lsp) async fn abort(&self, error: &str) {
        self.shutting_down.store(true, Ordering::SeqCst);
        let _ = self.stdin.lock().await.shutdown().await;
        let mut child = self.child.lock().await;
        let _ = child.kill().await;
        let _ = child.wait().await;
        drop(child);
        self.fail_pending(error).await;
    }

    pub(in crate::lsp) async fn fail_pending(&self, error: &str) {
        let pending = std::mem::take(&mut *self.pending.lock().await);
        for response in pending.into_values() {
            let _ = response.sender.send(Err(error.to_string()));
        }
        let incoming = std::mem::take(&mut *self.incoming_show_message_requests.lock().await);
        for frontend_id in incoming.into_values() {
            self.client_bridge.cancel_show_message(&frontend_id, error);
        }
    }
}
