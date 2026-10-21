use super::approval::ControlGate;
use super::approval::RdpSessionEvent;
use crate::servers::engine::LogEmitter;
use ironrdp::server::ConnectionHandler;
use ironrdp::server::PostConnectionAction;
use std::net::SocketAddr;
use std::sync::Arc;
use tauri::AppHandle;
use tauri::Emitter;

pub(super) struct ConnectionPolicy {
    pub(super) app: AppHandle,
    pub(super) log: LogEmitter,
    pub(super) control_gate: Option<Arc<ControlGate>>,
    pub(super) view_only: bool,
    pub(super) active: bool,
}

impl ConnectionPolicy {
    pub(super) fn emit_session(
        &self,
        state: &'static str,
        peer: SocketAddr,
        duration: Option<std::time::Duration>,
        reason: Option<String>,
    ) {
        let _ = self.app.emit(
            "server://rdp/session",
            RdpSessionEvent {
                state,
                peer: peer.to_string(),
                view_only: self.view_only,
                duration_ms: duration.map(|value| value.as_millis() as u64),
                reason,
            },
        );
    }

    pub(super) fn reject_busy(&self, peer: SocketAddr, active_peer: Option<SocketAddr>) {
        self.log.line(format!(
            "RDP rejected {peer}: single-client session{} is already active",
            active_peer
                .map(|value| format!(" from {value}"))
                .unwrap_or_default()
        ));
        self.emit_session(
            "rejected",
            peer,
            None,
            Some("single-client session already active".to_string()),
        );
    }
}

impl ConnectionHandler for ConnectionPolicy {
    fn on_accept(&mut self, peer: SocketAddr) -> bool {
        // IronRDP owns one display/input/channel state machine. The vendored
        // accept loop also invokes `on_busy` for sockets arriving while this
        // session is running; keep this guard for direct/manual callers.
        if self.active {
            self.reject_busy(peer, None);
            return false;
        }

        self.active = true;
        if let Some(gate) = &self.control_gate {
            gate.begin_session(peer);
        }
        self.log.line(format!(
            "RDP client connection from {peer} ({})",
            if self.view_only {
                "view-only"
            } else if self.control_gate.is_some() {
                "control requires local approval"
            } else {
                "unattended control"
            }
        ));
        self.emit_session("connecting", peer, None, None);
        true
    }

    fn on_busy(&mut self, peer: SocketAddr, active_peer: SocketAddr) {
        self.reject_busy(peer, Some(active_peer));
    }

    fn on_disconnected(
        &mut self,
        peer: SocketAddr,
        duration: std::time::Duration,
        error: Option<&anyhow::Error>,
    ) -> PostConnectionAction {
        self.active = false;
        if let Some(gate) = &self.control_gate {
            gate.end_session();
        }
        let reason = error.map(|error| format!("{error:#}"));
        self.log.line(format!(
            "RDP client {peer} disconnected after {:.1}s{}",
            duration.as_secs_f64(),
            reason
                .as_deref()
                .map(|value| format!(": {value}"))
                .unwrap_or_default()
        ));
        self.emit_session("disconnected", peer, Some(duration), reason);
        PostConnectionAction::Continue
    }
}

/// The only production security mode: NLA/CredSSP over TLS.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum SecurityMode {
    Hybrid,
}

impl SecurityMode {
    pub(super) fn parse(s: &str) -> Result<Self, String> {
        match s.trim().to_ascii_lowercase().as_str() {
            "" | "hybrid" | "nla" => Ok(SecurityMode::Hybrid),
            other => Err(format!(
                "RDP security mode '{other}' is disabled: production server requires NLA/CredSSP over TLS"
            )),
        }
    }
}
