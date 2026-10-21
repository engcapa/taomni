use super::lifetime::AcpProcess;
use super::limits::PERMISSION_RESPONSE_FLUSH_TIMEOUT;
use super::model::AcpRuntimeError;
use super::model::AcpRuntimeEvent;
use super::requests::SharedStdin;
use super::requests::write_message;
use crate::agent::acp_bridge::protocol::AcpPermissionOption;
use crate::agent::acp_bridge::protocol::AcpPermissionOptionKind;
use crate::agent::acp_bridge::protocol::AcpPermissionRequest;
use crate::agent::acp_bridge::protocol::AcpRequestId;
use crate::agent::acp_bridge::protocol::permission_cancelled_response;
use crate::agent::acp_bridge::protocol::permission_selected_response;
use serde::Serialize;
use std::collections::BTreeSet;
use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::sync::MutexGuard as StdMutexGuard;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tokio::sync::Mutex;
use tokio::sync::broadcast;
use tokio::sync::oneshot;
use tokio::sync::watch;

pub(super) type PendingPermissionMap = Arc<StdMutex<HashMap<String, PendingPermission>>>;
pub(super) type ClosedPermissionSessions = Arc<StdMutex<HashSet<String>>>;

pub(super) struct PendingPermission {
    pub(super) session_id: String,
    pub(super) option_ids: BTreeSet<String>,
    /// `None` means a user decision or a cancellation has already been sent
    /// to the response task. Keep the entry until that task has written the
    /// RPC response so a concurrent stop can wait for the flush.
    pub(super) sender: Option<oneshot::Sender<AcpPermissionResolution>>,
    pub(super) completion: Arc<PermissionCompletion>,
}

pub(super) enum AcpPermissionResolution {
    Selected(String),
    Cancelled,
}

/// A cloneable completion signal for a permission RPC response. A watch
/// channel deliberately retains the completed state for late waiters, unlike
/// a one-shot notification that could race with a concurrent stop.
pub(super) struct PermissionCompletion {
    pub(super) sender: watch::Sender<bool>,
}

impl PermissionCompletion {
    pub(super) fn new() -> Self {
        let (sender, _) = watch::channel(false);
        Self { sender }
    }

    pub(super) fn finish(&self) {
        // `send` discards the value when no receiver exists yet. A resolver
        // can start waiting just after the response task finishes, so retain
        // the completed state for that late subscriber.
        let _ = self.sender.send_replace(true);
    }

    pub(super) async fn wait(&self) {
        let mut receiver = self.sender.subscribe();
        if *receiver.borrow() {
            return;
        }
        let _ = receiver.changed().await;
    }
}

/// A display-safe ACP permission request ready for Taomni's confirmation UI.
/// The protocol session id and raw tool arguments never leave the ACP runtime.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpPermissionPrompt {
    pub call_id: String,
    pub title: String,
    pub kind: String,
    pub options: Vec<AcpPermissionOption>,
}

impl AcpProcess {
    /// Resolve a permission request previously emitted through
    /// [`AcpRuntimeEvent::PermissionRequest`]. Both the generated call id and
    /// the option id must still match a pending request; callers cannot invent
    /// an approval for a different tool or session.
    pub async fn resolve_permission(
        &self,
        call_id: &str,
        option_id: &str,
    ) -> Result<(), AcpRuntimeError> {
        let completion = {
            let mut pending = lock_unpoisoned(&self.pending_permissions);
            let permission = pending
                .get_mut(call_id)
                .ok_or(AcpRuntimeError::PermissionNotPending)?;
            if !permission.option_ids.contains(option_id) {
                return Err(AcpRuntimeError::PermissionOptionUnavailable);
            }
            let sender = permission
                .sender
                .take()
                .ok_or(AcpRuntimeError::PermissionNotPending)?;
            sender
                .send(AcpPermissionResolution::Selected(option_id.to_string()))
                .map_err(|_| AcpRuntimeError::PermissionNotPending)?;
            permission.completion.clone()
        };
        wait_for_permission_response(&completion).await;
        Ok(())
    }

    /// Cancel one visible native-tool approval card. Unlike selecting a
    /// reject-looking option, this uses ACP's canonical `cancelled` outcome.
    pub async fn cancel_permission(&self, call_id: &str) -> Result<(), AcpRuntimeError> {
        let completion = {
            let mut pending = lock_unpoisoned(&self.pending_permissions);
            let permission = pending
                .get_mut(call_id)
                .ok_or(AcpRuntimeError::PermissionNotPending)?;
            let sender = permission
                .sender
                .take()
                .ok_or(AcpRuntimeError::PermissionNotPending)?;
            sender
                .send(AcpPermissionResolution::Cancelled)
                .map_err(|_| AcpRuntimeError::PermissionNotPending)?;
            permission.completion.clone()
        };
        wait_for_permission_response(&completion).await;
        Ok(())
    }

    pub(super) async fn open_permission_session(&self, session_id: &str) {
        let _registration = self.permission_registration.lock().await;
        lock_unpoisoned(&self.closed_permission_sessions).remove(session_id);
    }
}

pub(super) async fn spawn_permission_response(
    id: AcpRequestId,
    request: AcpPermissionRequest,
    stdin: SharedStdin,
    pending_permissions: PendingPermissionMap,
    permission_registration: Arc<Mutex<()>>,
    closed_permission_sessions: ClosedPermissionSessions,
    accepts_permissions: Arc<AtomicBool>,
    events: broadcast::Sender<AcpRuntimeEvent>,
    stopped: Arc<AtomicBool>,
    permission_timeout: Duration,
) {
    let _registration = permission_registration.lock().await;
    if !accepts_permissions.load(Ordering::SeqCst)
        || stopped.load(Ordering::SeqCst)
        || lock_unpoisoned(&closed_permission_sessions).contains(&request.session_id)
    {
        let response = permission_cancelled_response(id);
        let _ = write_message(&stdin, &response, &stopped).await;
        return;
    }

    // Taomni MCP write tools already show the audited ActionCard. Auto-select
    // an allow option here so Grok ACP does not open a second, less-detailed
    // safety gate for the same side effect.
    if request.deferred_to_mcp
        && let Some(option_id) = preferred_mcp_allow_option_id(&request.options)
    {
        let response = permission_selected_response(id, &option_id);
        let _ = write_message(&stdin, &response, &stopped).await;
        return;
    }

    let call_id = uuid::Uuid::new_v4().to_string();
    let prompt = AcpPermissionPrompt {
        call_id: call_id.clone(),
        title: request.title,
        kind: request.kind,
        options: request.options,
    };
    let option_ids = prompt
        .options
        .iter()
        .map(|option| option.option_id.clone())
        .collect();
    let (sender, receiver) = oneshot::channel();
    let completion = Arc::new(PermissionCompletion::new());
    lock_unpoisoned(&pending_permissions).insert(
        call_id.clone(),
        PendingPermission {
            session_id: request.session_id,
            option_ids,
            sender: Some(sender),
            completion: completion.clone(),
        },
    );
    // A missing UI subscriber must fail closed immediately instead of leaving
    // an agent-side request stuck until the normal timeout elapses.
    let delivered = events
        .send(AcpRuntimeEvent::PermissionRequest(prompt))
        .is_ok();
    if !delivered
        && let Some(sender) = lock_unpoisoned(&pending_permissions)
            .get_mut(&call_id)
            .and_then(|permission| permission.sender.take())
    {
        let _ = sender.send(AcpPermissionResolution::Cancelled);
    }
    drop(_registration);

    tokio::spawn(async move {
        let resolution = if delivered {
            match tokio::time::timeout(permission_timeout, receiver).await {
                Ok(Ok(resolution)) => resolution,
                Ok(Err(_)) | Err(_) => AcpPermissionResolution::Cancelled,
            }
        } else {
            AcpPermissionResolution::Cancelled
        };
        let response = match resolution {
            AcpPermissionResolution::Selected(option_id) => {
                permission_selected_response(id, &option_id)
            }
            AcpPermissionResolution::Cancelled => permission_cancelled_response(id),
        };
        let _ = write_message(&stdin, &response, &stopped).await;
        lock_unpoisoned(&pending_permissions).remove(&call_id);
        let _ = events.send(AcpRuntimeEvent::PermissionResolved { call_id });
        // Wake prompt/cancel/stop callers only after the dismissal event is
        // queued for the current stream receiver. Otherwise a fast turn exit
        // could drop that receiver before the WebView hears to remove its card.
        completion.finish();
    });
}

/// Prefer a one-shot allow for MCP-deferred prompts. Fall back to allow-always
/// only when the agent did not offer allow-once, so we never invent an option.
pub(super) fn preferred_mcp_allow_option_id(options: &[AcpPermissionOption]) -> Option<String> {
    options
        .iter()
        .find(|option| option.kind == AcpPermissionOptionKind::AllowOnce)
        .or_else(|| {
            options
                .iter()
                .find(|option| option.kind == AcpPermissionOptionKind::AllowAlways)
        })
        .map(|option| option.option_id.clone())
}

impl AcpProcess {
    pub(super) async fn cancel_permissions_for_session(&self, session_id: &str) {
        let registration = self.permission_registration.lock().await;
        lock_unpoisoned(&self.closed_permission_sessions).insert(session_id.to_string());
        let completions = take_permission_cancellations(&self.pending_permissions, |permission| {
            permission.session_id == session_id
        });
        wait_for_permission_responses(&completions).await;
        drop(registration);
    }
}

/// Mark every matching unresolved permission as cancelled and return the
/// response completions for both newly-cancelled and already-selected entries.
/// Keeping selected entries in the list makes stop wait for a click response
/// that is currently flushing to the local CLI.
pub(super) fn take_permission_cancellations(
    pending_permissions: &PendingPermissionMap,
    matches: impl Fn(&PendingPermission) -> bool,
) -> Vec<Arc<PermissionCompletion>> {
    let mut permissions = lock_unpoisoned(pending_permissions);
    permissions
        .values_mut()
        .filter(|permission| matches(permission))
        .map(|permission| {
            if let Some(sender) = permission.sender.take() {
                let _ = sender.send(AcpPermissionResolution::Cancelled);
            }
            permission.completion.clone()
        })
        .collect()
}

pub(super) async fn cancel_all_permissions(pending_permissions: &PendingPermissionMap) {
    let completions = take_permission_cancellations(pending_permissions, |_| true);
    wait_for_permission_responses(&completions).await;
}

pub(super) async fn wait_for_permission_responses(completions: &[Arc<PermissionCompletion>]) {
    if completions.is_empty() {
        return;
    }
    let _ = tokio::time::timeout(PERMISSION_RESPONSE_FLUSH_TIMEOUT, async {
        for completion in completions {
            completion.wait().await;
        }
    })
    .await;
}

pub(super) async fn wait_for_permission_response(completion: &Arc<PermissionCompletion>) {
    wait_for_permission_responses(std::slice::from_ref(completion)).await;
}

pub(super) fn clear_pending_permissions(pending_permissions: &PendingPermissionMap) {
    lock_unpoisoned(pending_permissions).clear();
}

pub(super) fn lock_unpoisoned<T>(mutex: &StdMutex<T>) -> StdMutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
