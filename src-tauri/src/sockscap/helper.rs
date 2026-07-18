//! Privileged-helper control protocol (plan §4.1 PrivilegedHelper, §9).
//!
//! The privileged helper installs/revokes capture rules, creates devices and
//! passes handles — it never holds proxy/SSH credentials. It does a version
//! handshake + caller-signature check with the main process, sends heartbeats,
//! and on the main process disappearing it fails open (revokes temporary rules,
//! restores direct networking). This module defines the versioned, serializable
//! control messages and the pure handshake/heartbeat logic; the actual IPC
//! transport (named pipe / Unix socket) and OS-level caller-signature check are
//! platform integration wired with each capture backend (§5-7).

use serde::{Deserialize, Serialize};

/// Wire-protocol version. Bump on any breaking message change; the handshake
/// requires an exact match so a stale helper binary can't misinterpret a newer
/// app (or vice versa).
pub const HELPER_PROTOCOL_VERSION: u32 = 1;

/// Messages the main app sends to the helper.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case", tag = "type")]
pub enum AppToHelper {
    /// First message: negotiate protocol version and identify the caller.
    Hello {
        protocol_version: u32,
        /// Opaque caller identity token the helper verifies out-of-band
        /// (code-signature / audit-token). Never a secret.
        caller_token: String,
    },
    /// Liveness ping; the helper fails open if these stop (plan §9).
    Heartbeat { seq: u64 },
    /// Install capture rules for an opaque, pre-validated plan id.
    InstallCapture { plan_id: String },
    /// Revoke all installed capture rules and restore direct networking.
    RevokeCapture,
    /// Graceful shutdown request.
    Shutdown,
}

/// Messages the helper sends back to the main app.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case", tag = "type")]
pub enum HelperToApp {
    /// Handshake accepted.
    Welcome { protocol_version: u32 },
    /// Handshake rejected (version mismatch or caller not authorized).
    Rejected { reason: String },
    HeartbeatAck { seq: u64 },
    Installed { plan_id: String },
    Revoked,
    Error { message: String },
}

/// Outcome of validating a `Hello` against this build.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HandshakeOutcome {
    Accept,
    Reject(String),
}

/// Validate a handshake: exact protocol-version match and a non-empty caller
/// token (the OS-level signature/audit-token check is performed by the platform
/// layer before this and reflected in `caller_authorized`).
pub fn evaluate_handshake(
    protocol_version: u32,
    caller_token: &str,
    caller_authorized: bool,
) -> HandshakeOutcome {
    if protocol_version != HELPER_PROTOCOL_VERSION {
        return HandshakeOutcome::Reject(format!(
            "protocol version mismatch: helper={HELPER_PROTOCOL_VERSION}, app={protocol_version}"
        ));
    }
    if caller_token.trim().is_empty() {
        return HandshakeOutcome::Reject("empty caller token".into());
    }
    if !caller_authorized {
        return HandshakeOutcome::Reject("caller signature not authorized".into());
    }
    HandshakeOutcome::Accept
}

/// Tracks heartbeat liveness. If no heartbeat arrives within `timeout`, the
/// helper should fail open (revoke capture, restore direct) — silence is
/// treated as the main process being gone (plan §9, §16.6-23).
#[derive(Debug, Clone)]
pub struct HeartbeatMonitor {
    timeout_ms: u64,
    last_seen_ms: u64,
}

impl HeartbeatMonitor {
    pub fn new(timeout_ms: u64, now_ms: u64) -> HeartbeatMonitor {
        HeartbeatMonitor {
            timeout_ms,
            last_seen_ms: now_ms,
        }
    }

    pub fn on_heartbeat(&mut self, now_ms: u64) {
        self.last_seen_ms = now_ms;
    }

    /// True when the peer is considered gone and the helper must fail open.
    pub fn is_expired(&self, now_ms: u64) -> bool {
        now_ms.saturating_sub(self.last_seen_ms) > self.timeout_ms
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handshake_accepts_matching_version_and_authorized_caller() {
        assert_eq!(
            evaluate_handshake(HELPER_PROTOCOL_VERSION, "token", true),
            HandshakeOutcome::Accept
        );
    }

    #[test]
    fn handshake_rejects_version_mismatch() {
        assert!(matches!(
            evaluate_handshake(HELPER_PROTOCOL_VERSION + 1, "token", true),
            HandshakeOutcome::Reject(_)
        ));
    }

    #[test]
    fn handshake_rejects_unauthorized_or_empty_caller() {
        assert!(matches!(
            evaluate_handshake(HELPER_PROTOCOL_VERSION, "token", false),
            HandshakeOutcome::Reject(_)
        ));
        assert!(matches!(
            evaluate_handshake(HELPER_PROTOCOL_VERSION, "  ", true),
            HandshakeOutcome::Reject(_)
        ));
    }

    #[test]
    fn heartbeat_expiry_triggers_fail_open() {
        let mut hb = HeartbeatMonitor::new(1000, 0);
        assert!(!hb.is_expired(500));
        assert!(hb.is_expired(1500)); // silence past timeout
        hb.on_heartbeat(2000);
        assert!(!hb.is_expired(2500));
    }

    #[test]
    fn messages_round_trip_json() {
        let msg = AppToHelper::Hello {
            protocol_version: HELPER_PROTOCOL_VERSION,
            caller_token: "abc".into(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert_eq!(serde_json::from_str::<AppToHelper>(&json).unwrap(), msg);

        let reply = HelperToApp::Welcome {
            protocol_version: HELPER_PROTOCOL_VERSION,
        };
        let json = serde_json::to_string(&reply).unwrap();
        assert_eq!(serde_json::from_str::<HelperToApp>(&json).unwrap(), reply);
    }
}
