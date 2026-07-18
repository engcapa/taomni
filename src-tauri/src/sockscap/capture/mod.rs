//! Platform capture adapters (Phases 5–7).
//!
//! Design plan §4.1 CaptureAdapter: capture identity + original destination only.
//! Product rules stay in PolicyEngine / FlowEngine.

pub mod linux;
pub mod macos;
pub mod windows;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, OnceLock};

use crate::sockscap::types::{CapturePlatform, RoutingProfileDraft};

/// What the adapter was asked to install.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturePlan {
    pub profiles: Vec<RoutingProfileDraft>,
    /// Hard-bypass endpoints that must never re-enter capture.
    pub bypass_hosts: Vec<String>,
}

/// Result of an install/uninstall attempt.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureOpResult {
    pub ok: bool,
    pub platform: CapturePlatform,
    pub message: String,
    /// True when the adapter mutated system network state.
    pub mutated_system: bool,
}

/// Capture plane interface shared by Windows / macOS / Linux backends.
#[async_trait]
pub trait CaptureAdapter: Send + Sync {
    fn platform(&self) -> CapturePlatform;
    fn name(&self) -> &'static str;

    /// Whether this build can install real capture rules on the current host.
    fn is_implemented(&self) -> bool;

    async fn preflight(&self, plan: &CapturePlan) -> CaptureOpResult;

    /// Install capture rules. Must be transactional: on failure leave no residue.
    async fn install(&self, plan: &CapturePlan) -> CaptureOpResult;

    /// Revoke all rules installed by this adapter instance / recovery journal.
    async fn uninstall(&self) -> CaptureOpResult;
}

/// Process-wide adapter so install state survives start/stop across calls.
pub fn current_adapter() -> Arc<dyn CaptureAdapter> {
    #[cfg(target_os = "windows")]
    {
        static A: OnceLock<Arc<windows::WindowsCaptureAdapter>> = OnceLock::new();
        return A
            .get_or_init(|| Arc::new(windows::WindowsCaptureAdapter::default()))
            .clone();
    }
    #[cfg(target_os = "macos")]
    {
        static A: OnceLock<Arc<macos::MacosCaptureAdapter>> = OnceLock::new();
        return A
            .get_or_init(|| Arc::new(macos::MacosCaptureAdapter::default()))
            .clone();
    }
    #[cfg(target_os = "linux")]
    {
        static A: OnceLock<Arc<linux::LinuxCaptureAdapter>> = OnceLock::new();
        return A
            .get_or_init(|| Arc::new(linux::LinuxCaptureAdapter::default()))
            .clone();
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        static A: OnceLock<Arc<UnsupportedAdapter>> = OnceLock::new();
        A.get_or_init(|| Arc::new(UnsupportedAdapter)).clone()
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
struct UnsupportedAdapter;

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
#[async_trait]
impl CaptureAdapter for UnsupportedAdapter {
    fn platform(&self) -> CapturePlatform {
        CapturePlatform::Unknown
    }
    fn name(&self) -> &'static str {
        "unsupported"
    }
    fn is_implemented(&self) -> bool {
        false
    }
    async fn preflight(&self, _plan: &CapturePlan) -> CaptureOpResult {
        CaptureOpResult {
            ok: false,
            platform: CapturePlatform::Unknown,
            message: "platform not supported".into(),
            mutated_system: false,
        }
    }
    async fn install(&self, plan: &CapturePlan) -> CaptureOpResult {
        self.preflight(plan).await
    }
    async fn uninstall(&self) -> CaptureOpResult {
        CaptureOpResult {
            ok: true,
            platform: CapturePlatform::Unknown,
            message: "nothing to uninstall".into(),
            mutated_system: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn current_adapter_install_without_privilege_does_not_mutate() {
        let adapter = current_adapter();
        let plan = CapturePlan {
            profiles: vec![],
            bypass_hosts: vec!["127.0.0.1".into()],
        };
        let inst = adapter.install(&plan).await;
        if !inst.ok {
            assert!(!inst.mutated_system);
        }
        let un = adapter.uninstall().await;
        assert!(un.ok);
    }

    #[test]
    fn adapter_is_singleton() {
        let a = current_adapter();
        let b = current_adapter();
        assert_eq!(a.name(), b.name());
    }
}
