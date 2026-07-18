//! Privileged-helper control protocol (plan §4.1 PrivilegedHelper, §9).
//!
//! The privileged helper installs/revokes capture rules and holds WinDivert —
//! it never holds proxy/SSH credentials. Version handshake + heartbeats; if
//! the main process disappears the helper fails open (revokes capture).
//!
//! Transport on Windows: named pipe JSON-lines (one JSON object per line).

use serde::{Deserialize, Serialize};

/// Wire-protocol version. Bump on any breaking message change.
pub const HELPER_PROTOCOL_VERSION: u32 = 2;

/// Process-filter payload for Windows transparent capture.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case", tag = "kind")]
pub enum ProcessFilterSpec {
    /// Divert all outbound TCP (global profile).
    All,
    /// Match executable full path or file name (case-insensitive).
    Executables { paths: Vec<String> },
    /// Match runtime PIDs.
    Pids { pids: Vec<u32> },
}

/// Messages the main app sends to the helper.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case", tag = "type")]
pub enum AppToHelper {
    /// First message: negotiate protocol version and identify the caller.
    Hello {
        protocol_version: u32,
        /// Opaque caller identity (never a secret).
        caller_token: String,
    },
    /// Liveness ping; the helper fails open if these stop (plan §9).
    Heartbeat { seq: u64 },
    /// Install WinDivert NAT toward `listen_port` with the given filter.
    InstallCapture {
        plan_id: String,
        listen_port: u16,
        filter: ProcessFilterSpec,
        /// Directory containing WinDivert.dll + WinDivert64.sys (bundled).
        windivert_dir: String,
    },
    /// Revoke capture and restore direct networking.
    RevokeCapture,
    /// Look up original destination for a NAT'd peer source port.
    LookupConntrack { sport: u16 },
    /// Graceful shutdown.
    Shutdown,
}

/// Messages the helper sends back to the main app.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case", tag = "type")]
pub enum HelperToApp {
    Welcome { protocol_version: u32 },
    Rejected { reason: String },
    HeartbeatAck { seq: u64 },
    Installed { plan_id: String },
    Revoked,
    ConntrackHit {
        sport: u16,
        dst: String,
        dport: u16,
        pid: Option<u32>,
        exe: Option<String>,
    },
    ConntrackMiss { sport: u16 },
    Error { message: String },
}

/// Outcome of validating a `Hello` against this build.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HandshakeOutcome {
    Accept,
    Reject(String),
}

/// Validate a handshake: exact protocol-version match and a non-empty caller
/// token. OS-level signature checks can set `caller_authorized = false`.
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
/// helper should fail open (revoke capture, restore direct).
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
        assert!(hb.is_expired(1500));
        hb.on_heartbeat(2000);
        assert!(!hb.is_expired(2500));
    }

    #[test]
    fn messages_round_trip_json() {
        let msg = AppToHelper::InstallCapture {
            plan_id: "p1".into(),
            listen_port: 1080,
            filter: ProcessFilterSpec::All,
            windivert_dir: r"C:\app\windivert".into(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert_eq!(serde_json::from_str::<AppToHelper>(&json).unwrap(), msg);

        let reply = HelperToApp::ConntrackHit {
            sport: 12345,
            dst: "1.2.3.4".into(),
            dport: 443,
            pid: Some(99),
            exe: Some(r"C:\a.exe".into()),
        };
        let json = serde_json::to_string(&reply).unwrap();
        assert_eq!(serde_json::from_str::<HelperToApp>(&json).unwrap(), reply);
    }
}
