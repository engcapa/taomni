//! Privileged helper interface (design plan §4.1 PrivilegedHelper).
//!
//! The helper is a narrow, elevated process that only installs/revokes capture
//! rules and device state. It must never hold proxy passwords.
//!
//! This module is the in-process contract + recovery journal helpers used until
//! a separate polkit/setuid helper binary ships. The main engine calls the same
//! `HelperOps` surface whether the work is in-process (dev) or over IPC (prod).

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use super::capture::{CaptureOpResult, CapturePlan};
use super::db::{clear_recovery_journal, read_recovery_journal};

/// Protocol version for helper ↔ main handshake.
pub const HELPER_PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperHello {
    pub protocol_version: u32,
    pub helper_name: String,
    pub platform: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperHelloAck {
    pub ok: bool,
    pub protocol_version: u32,
    pub message: String,
}

/// Operations the privileged helper exposes.
#[async_trait::async_trait]
pub trait HelperOps: Send + Sync {
    async fn hello(&self) -> HelperHello;
    async fn install_capture(&self, plan: &CapturePlan) -> CaptureOpResult;
    async fn uninstall_capture(&self) -> CaptureOpResult;
    /// Fail-open: revoke capture even if main is dead.
    async fn emergency_recover(&self) -> CaptureOpResult;
}

/// In-process helper used today (same process as the UI when running as root).
pub struct InProcessHelper;

#[async_trait::async_trait]
impl HelperOps for InProcessHelper {
    async fn hello(&self) -> HelperHello {
        HelperHello {
            protocol_version: HELPER_PROTOCOL_VERSION,
            helper_name: "in-process".into(),
            platform: std::env::consts::OS.into(),
        }
    }

    async fn install_capture(&self, plan: &CapturePlan) -> CaptureOpResult {
        super::capture::current_adapter().install(plan).await
    }

    async fn uninstall_capture(&self) -> CaptureOpResult {
        super::capture::current_adapter().uninstall().await
    }

    async fn emergency_recover(&self) -> CaptureOpResult {
        self.uninstall_capture().await
    }
}

/// Handshake check used by main before trusting a helper connection.
pub fn acknowledge_hello(hello: &HelperHello) -> HelperHelloAck {
    if hello.protocol_version != HELPER_PROTOCOL_VERSION {
        return HelperHelloAck {
            ok: false,
            protocol_version: HELPER_PROTOCOL_VERSION,
            message: format!(
                "helper protocol mismatch: got {}, want {}",
                hello.protocol_version, HELPER_PROTOCOL_VERSION
            ),
        };
    }
    HelperHelloAck {
        ok: true,
        protocol_version: HELPER_PROTOCOL_VERSION,
        message: format!("hello ok ({})", hello.helper_name),
    }
}

/// On startup: if recovery journal says Active, attempt fail-open cleanup.
pub fn startup_recovery_pass(sockscap_db: &rusqlite::Connection) -> Result<String, String> {
    match read_recovery_journal(sockscap_db).map_err(|e| e.to_string())? {
        Some(j) if j.marker == "active" || j.state == "Active" || j.marker == "preparing" => {
            let helper = InProcessHelper;
            let result = tauri::async_runtime::block_on(helper.emergency_recover());
            let _ = clear_recovery_journal(sockscap_db);
            if result.ok {
                Ok(format!(
                    "startup recovery cleaned leftover capture: {}",
                    result.message
                ))
            } else {
                Err(format!(
                    "startup recovery failed: {} (manual recover required)",
                    result.message
                ))
            }
        }
        _ => Ok("no leftover capture marker".into()),
    }
}

/// Future on-disk helper binary path (packaging places it next to the app).
pub fn helper_binary_path(app_data: &Path) -> PathBuf {
    app_data.join("helpers").join("taomni-sockscap-helper")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hello_ack_accepts_matching_version() {
        let h = HelperHello {
            protocol_version: HELPER_PROTOCOL_VERSION,
            helper_name: "test".into(),
            platform: "linux".into(),
        };
        let ack = acknowledge_hello(&h);
        assert!(ack.ok);
    }

    #[test]
    fn hello_ack_rejects_mismatch() {
        let h = HelperHello {
            protocol_version: 999,
            helper_name: "old".into(),
            platform: "linux".into(),
        };
        let ack = acknowledge_hello(&h);
        assert!(!ack.ok);
    }

    #[tokio::test]
    async fn in_process_helper_hello() {
        let h = InProcessHelper.hello().await;
        assert_eq!(h.protocol_version, HELPER_PROTOCOL_VERSION);
    }
}
