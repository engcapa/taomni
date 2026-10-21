use crate::servers::engine::LogEmitter;
use serde::Serialize;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::Mutex;
use tauri::AppHandle;
use tauri::Emitter;
use tauri::Manager;
use tokio_util::sync::CancellationToken;

pub(super) const CONTROL_APPROVAL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Pending local approvals are registered by the dedicated RDP server thread
/// and resolved by the main-window command handler.
#[derive(Default)]
pub(crate) struct ApprovalBroker {
    pub(super) pending: Mutex<HashMap<String, std::sync::mpsc::Sender<bool>>>,
}

impl ApprovalBroker {
    pub(super) fn register(&self, request_id: String) -> std::sync::mpsc::Receiver<bool> {
        let (tx, rx) = std::sync::mpsc::channel();
        if let Ok(mut pending) = self.pending.lock() {
            pending.insert(request_id, tx);
        }
        rx
    }

    pub(crate) fn resolve(&self, request_id: &str, approved: bool) -> bool {
        let sender = self
            .pending
            .lock()
            .ok()
            .and_then(|mut pending| pending.remove(request_id));
        sender.is_some_and(|sender| sender.send(approved).is_ok())
    }

    pub(super) fn cancel(&self, request_id: &str) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(request_id);
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ConnectionApprovalRequest {
    pub(super) request_id: String,
    pub(super) peer: String,
    pub(super) timeout_seconds: u64,
    pub(super) expires_at: i64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RdpSessionEvent {
    pub(super) state: &'static str,
    pub(super) peer: String,
    pub(super) view_only: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) reason: Option<String>,
}

#[derive(Clone, Copy, Default, PartialEq, Eq)]
pub(super) enum ControlDecision {
    #[default]
    Unknown,
    Awaiting,
    Approved,
    Denied,
}

#[derive(Default)]
pub(super) struct ControlGateState {
    pub(super) peer: Option<SocketAddr>,
    pub(super) decision: ControlDecision,
    pub(super) request_id: Option<String>,
}

/// Input injection gate shared by the connection lifecycle handler and the
/// input handler. The prompt is raised on the first post-authentication input
/// event, not on raw TCP accept, so unauthenticated network probes cannot spam
/// local consent dialogs.
pub(crate) struct ControlGate {
    pub(super) app: AppHandle,
    pub(super) log: LogEmitter,
    pub(super) approvals: Arc<ApprovalBroker>,
    pub(super) cancel: CancellationToken,
    pub(super) state: Mutex<ControlGateState>,
}

impl ControlGate {
    pub(super) fn begin_session(&self, peer: SocketAddr) {
        if let Ok(mut state) = self.state.lock() {
            state.peer = Some(peer);
            state.decision = ControlDecision::Unknown;
        }
    }

    pub(super) fn end_session(&self) {
        let request_id = self.state.lock().ok().and_then(|mut state| {
            state.peer = None;
            state.decision = ControlDecision::Denied;
            state.request_id.take()
        });
        if let Some(request_id) = request_id {
            self.approvals.cancel(&request_id);
        }
    }

    /// Return immediately with the current control decision. The first input
    /// event starts a background approval waiter and is dropped; it must never
    /// block IronRDP's single-threaded connection reactor while mstsc is still
    /// completing activation.
    pub(crate) fn ensure_approved(self: &Arc<Self>) -> bool {
        let (peer, request_id) = {
            let Ok(mut state) = self.state.lock() else {
                return false;
            };
            match state.decision {
                ControlDecision::Approved => return true,
                ControlDecision::Denied | ControlDecision::Awaiting => return false,
                ControlDecision::Unknown => {
                    state.decision = ControlDecision::Awaiting;
                    let Some(peer) = state.peer else {
                        state.decision = ControlDecision::Denied;
                        return false;
                    };
                    let request_id = uuid::Uuid::new_v4().to_string();
                    state.request_id = Some(request_id.clone());
                    (peer, request_id)
                }
            }
        };

        let receiver = self.approvals.register(request_id.clone());
        let request = ConnectionApprovalRequest {
            request_id: request_id.clone(),
            peer: peer.to_string(),
            timeout_seconds: CONTROL_APPROVAL_TIMEOUT.as_secs(),
            expires_at: crate::servers::now_ms() + CONTROL_APPROVAL_TIMEOUT.as_millis() as i64,
        };
        self.log.line(format!(
            "RDP control attempt from {peer}; waiting up to {}s for local approval",
            CONTROL_APPROVAL_TIMEOUT.as_secs()
        ));

        let delivered = self
            .app
            .emit_to("main", "server://rdp/connection-request", request)
            .is_ok();
        if !delivered {
            self.approvals.cancel(&request_id);
            self.complete_approval(peer, &request_id, false);
            self.log.line(
                "RDP control denied because the local approval prompt could not be delivered",
            );
            return false;
        }

        let gate = Arc::clone(self);
        let waiter_request_id = request_id.clone();
        if let Err(error) = std::thread::Builder::new()
            .name("rdp-control-approval".to_string())
            .spawn(move || {
                let approved = gate.wait_for_approval(&waiter_request_id, &receiver);
                gate.approvals.cancel(&waiter_request_id);
                gate.complete_approval(peer, &waiter_request_id, approved);
            })
        {
            self.approvals.cancel(&request_id);
            self.complete_approval(peer, &request_id, false);
            self.log.line(format!(
                "RDP control denied because the approval waiter could not start: {error}"
            ));
        }

        false
    }

    pub(super) fn complete_approval(&self, peer: SocketAddr, request_id: &str, approved: bool) {
        let applied = self
            .state
            .lock()
            .ok()
            .filter(|state| {
                state.peer == Some(peer) && state.request_id.as_deref() == Some(request_id)
            })
            .map(|mut state| {
                state.request_id = None;
                state.decision = if approved {
                    ControlDecision::Approved
                } else {
                    ControlDecision::Denied
                };
                true
            })
            .unwrap_or(false);
        if applied {
            self.log.line(format!(
                "RDP control from {peer} {}",
                if approved {
                    "approved locally"
                } else {
                    "denied, cancelled, or timed out"
                }
            ));
        }
    }

    pub(super) fn wait_for_approval(
        &self,
        request_id: &str,
        receiver: &std::sync::mpsc::Receiver<bool>,
    ) -> bool {
        let deadline = std::time::Instant::now() + CONTROL_APPROVAL_TIMEOUT;
        loop {
            if self.cancel.is_cancelled() {
                self.approvals.cancel(request_id);
                return false;
            }
            let now = std::time::Instant::now();
            if now >= deadline {
                self.approvals.cancel(request_id);
                return false;
            }
            let slice = deadline
                .saturating_duration_since(now)
                .min(std::time::Duration::from_millis(250));
            match receiver.recv_timeout(slice) {
                Ok(approved) => return approved,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return false,
            }
        }
    }
}
