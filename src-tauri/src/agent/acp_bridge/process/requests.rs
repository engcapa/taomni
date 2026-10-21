use super::diagnostics::sanitize_diagnostic;
use super::diagnostics::truncate_method;
use super::lifetime::AcpProcess;
use super::model::AcpRuntimeError;
use super::permissions::lock_unpoisoned;
use crate::agent::acp_bridge::protocol::AcpNotification;
use crate::agent::acp_bridge::protocol::AcpRequest;
use crate::agent::acp_bridge::protocol::AcpRequestId;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use tokio::io::AsyncWriteExt;
use tokio::process::ChildStdin;
use tokio::sync::Mutex;
use tokio::sync::oneshot;

pub(super) type PendingMap = Arc<StdMutex<HashMap<AcpRequestId, PendingRequest>>>;
pub(super) type SharedStdin = Arc<Mutex<Option<ChildStdin>>>;

pub(super) struct PendingRequest {
    pub(super) sender: oneshot::Sender<Result<Value, AcpRuntimeError>>,
}

impl AcpProcess {
    /// Send an extension request. This keeps the runtime generic and is useful
    /// for capability-gated ACP additions without weakening inbound security.
    pub async fn request(&self, method: &str, params: Value) -> Result<Value, AcpRuntimeError> {
        let request = AcpRequest::new(self.allocate_id(), method, params);
        self.send_request(request).await
    }

    pub(super) fn allocate_id(&self) -> AcpRequestId {
        AcpRequestId::Number(self.next_id.fetch_add(1, Ordering::SeqCst))
    }

    pub(super) async fn send_request(&self, request: AcpRequest) -> Result<Value, AcpRuntimeError> {
        if self.is_stopped() {
            return Err(AcpRuntimeError::Stopped);
        }

        let id = request.id.clone();
        let method = request.method.clone();
        let (sender, receiver) = oneshot::channel();
        lock_unpoisoned(&self.pending).insert(id.clone(), PendingRequest { sender });

        if let Err(error) = write_message(&self.stdin, &request, &self.stopped).await {
            lock_unpoisoned(&self.pending).remove(&id);
            return Err(error);
        }
        self.touch();

        match tokio::time::timeout(self.request_timeout, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(AcpRuntimeError::ResponseChannelClosed),
            Err(_) => {
                lock_unpoisoned(&self.pending).remove(&id);
                Err(AcpRuntimeError::RequestTimedOut {
                    method: truncate_method(&method),
                })
            }
        }
    }

    pub(super) async fn send_notification(
        &self,
        notification: AcpNotification,
    ) -> Result<(), AcpRuntimeError> {
        write_message(&self.stdin, &notification, &self.stopped).await?;
        self.touch();
        Ok(())
    }
}

pub(super) async fn write_message<T: Serialize>(
    stdin: &SharedStdin,
    message: &T,
    stopped: &AtomicBool,
) -> Result<(), AcpRuntimeError> {
    if stopped.load(Ordering::SeqCst) {
        return Err(AcpRuntimeError::Stopped);
    }
    let mut line = serde_json::to_vec(message).map_err(|_| AcpRuntimeError::SerializeFailed)?;
    line.push(b'\n');
    let mut guard = stdin.lock().await;
    let stdin = guard.as_mut().ok_or(AcpRuntimeError::ProcessExited)?;
    stdin
        .write_all(&line)
        .await
        .map_err(|error| AcpRuntimeError::WriteFailed(sanitize_diagnostic(&error.to_string())))?;
    stdin
        .flush()
        .await
        .map_err(|error| AcpRuntimeError::WriteFailed(sanitize_diagnostic(&error.to_string())))
}

pub(super) fn fail_pending(pending: &PendingMap, error: AcpRuntimeError) {
    for (_, request) in lock_unpoisoned(pending).drain() {
        let _ = request.sender.send(Err(error.clone()));
    }
}
