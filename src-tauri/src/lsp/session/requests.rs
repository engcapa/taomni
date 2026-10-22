use crate::lsp::LspSession;
use crate::lsp::PendingResponse;
use crate::lsp::REQUEST_TIMEOUT_SECS;
use crate::lsp::protocol::request_document_uri;
use crate::lsp::protocol::take_pending_for_document;
use serde_json::Value;
use serde_json::json;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

impl LspSession {
    pub(in crate::lsp) async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        let payload = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        });
        self.write_message(&payload).await
    }

    pub(in crate::lsp) async fn request(
        &self,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        self.request_with_timeout(method, params, REQUEST_TIMEOUT_SECS)
            .await
    }

    pub(in crate::lsp) async fn request_with_cancellation(
        &self,
        method: &str,
        params: Value,
        cancellation: &CancellationToken,
    ) -> Result<Value, String> {
        if cancellation.is_cancelled() {
            return Err(format!("language server request cancelled: {method}"));
        }
        self.request_with_timeout_and_cancellation(
            method,
            params,
            REQUEST_TIMEOUT_SECS,
            Some(cancellation),
        )
        .await
    }

    pub(in crate::lsp) async fn request_with_timeout(
        &self,
        method: &str,
        params: Value,
        timeout_secs: u64,
    ) -> Result<Value, String> {
        self.request_with_timeout_and_cancellation(method, params, timeout_secs, None)
            .await
    }

    pub(in crate::lsp) async fn request_with_timeout_and_cancellation(
        &self,
        method: &str,
        params: Value,
        timeout_secs: u64,
        cancellation: Option<&CancellationToken>,
    ) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (sender, receiver) = oneshot::channel();
        let document_uri = request_document_uri(&params).map(ToString::to_string);
        self.pending.lock().await.insert(
            id,
            PendingResponse {
                sender,
                document_uri,
            },
        );
        let payload = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        });
        if let Err(error) = self.write_message(&payload).await {
            self.pending.lock().await.remove(&id);
            return Err(error);
        }
        let response = tokio::time::timeout(Duration::from_secs(timeout_secs), receiver);
        tokio::pin!(response);
        let outcome = if let Some(cancellation) = cancellation {
            tokio::select! {
                biased;
                result = &mut response => result,
                _ = cancellation.cancelled() => {
                    if self.pending.lock().await.remove(&id).is_some() {
                        let _ = self.notify("$/cancelRequest", json!({ "id": id })).await;
                    }
                    return Err(format!("language server request cancelled: {method}"));
                }
            }
        } else {
            response.await
        };
        match outcome {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(format!("language server closed request {method}")),
            Err(_) => {
                if self.pending.lock().await.remove(&id).is_some() {
                    let _ = self.notify("$/cancelRequest", json!({ "id": id })).await;
                }
                Err(format!("language server request timed out: {method}"))
            }
        }
    }

    pub(in crate::lsp) async fn cancel_document_requests(&self, uri: &str, reason: &str) {
        let cancelled = {
            let mut pending = self.pending.lock().await;
            take_pending_for_document(&mut *pending, uri)
        };
        for (id, response) in cancelled {
            let _ = response.sender.send(Err(reason.to_string()));
            let _ = self.notify("$/cancelRequest", json!({ "id": id })).await;
        }
    }

    pub(in crate::lsp) async fn write_message(&self, payload: &Value) -> Result<(), String> {
        let body =
            serde_json::to_vec(payload).map_err(|e| format!("serialize LSP message: {e}"))?;
        let header = format!("Content-Length: {}\r\n\r\n", body.len());
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(header.as_bytes())
            .await
            .map_err(|e| format!("write LSP header: {e}"))?;
        stdin
            .write_all(&body)
            .await
            .map_err(|e| format!("write LSP body: {e}"))?;
        stdin
            .flush()
            .await
            .map_err(|e| format!("flush LSP message: {e}"))
    }

    pub(in crate::lsp) async fn send_server_result(&self, response_id: Value, result: Value) {
        let _ = self
            .write_message(&json!({
                "jsonrpc": "2.0",
                "id": response_id,
                "result": result,
            }))
            .await;
    }

    pub(in crate::lsp) async fn send_server_error(
        &self,
        response_id: Value,
        code: i64,
        message: impl Into<String>,
    ) {
        let _ = self
            .write_message(&json!({
                "jsonrpc": "2.0",
                "id": response_id,
                "error": {
                    "code": code,
                    "message": message.into()
                }
            }))
            .await;
    }
}
