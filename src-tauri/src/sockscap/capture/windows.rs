//! Windows capture adapter scaffold (Phase 5).
//!
//! Open gate (ADR): WinDivert SOCKET/FLOW/NETWORK vs WFP ALE for app/PID;
//! global Wintun/TUN baseline. This module does not link WinDivert or install
//! drivers.

use async_trait::async_trait;

use super::{CaptureAdapter, CaptureOpResult, CapturePlan};
use crate::sockscap::types::CapturePlatform;

#[derive(Debug, Default)]
pub struct WindowsCaptureAdapter;

#[async_trait]
impl CaptureAdapter for WindowsCaptureAdapter {
    fn platform(&self) -> CapturePlatform {
        CapturePlatform::Windows
    }

    fn name(&self) -> &'static str {
        "windows-wintun-windivert-or-wfp"
    }

    fn is_implemented(&self) -> bool {
        false
    }

    async fn preflight(&self, _plan: &CapturePlan) -> CaptureOpResult {
        CaptureOpResult {
            ok: false,
            platform: CapturePlatform::Windows,
            message: "Windows capture not implemented: complete Phase 0 dual spike ADR (WinDivert vs WFP) before install".into(),
            mutated_system: false,
        }
    }

    async fn install(&self, plan: &CapturePlan) -> CaptureOpResult {
        self.preflight(plan).await
    }

    async fn uninstall(&self) -> CaptureOpResult {
        CaptureOpResult {
            ok: true,
            platform: CapturePlatform::Windows,
            message: "windows adapter: no capture rules present (scaffold uninstall no-op)".into(),
            mutated_system: false,
        }
    }
}
