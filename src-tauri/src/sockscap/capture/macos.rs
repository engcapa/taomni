//! macOS capture adapter scaffold (Phase 6).
//!
//! Planned: NETransparentProxyProvider system extension with audit-token app
//! identity. Blocked on Network Extension entitlement + notarization pipeline.

use async_trait::async_trait;

use super::{CaptureAdapter, CaptureOpResult, CapturePlan};
use crate::sockscap::types::CapturePlatform;

#[derive(Debug, Default)]
pub struct MacosCaptureAdapter;

#[async_trait]
impl CaptureAdapter for MacosCaptureAdapter {
    fn platform(&self) -> CapturePlatform {
        CapturePlatform::Macos
    }

    fn name(&self) -> &'static str {
        "macos-netransparentproxy"
    }

    fn is_implemented(&self) -> bool {
        false
    }

    async fn preflight(&self, _plan: &CapturePlan) -> CaptureOpResult {
        CaptureOpResult {
            ok: false,
            platform: CapturePlatform::Macos,
            message: "macOS capture not implemented: NETransparentProxyProvider entitlement required".into(),
            mutated_system: false,
        }
    }

    async fn install(&self, plan: &CapturePlan) -> CaptureOpResult {
        self.preflight(plan).await
    }

    async fn uninstall(&self) -> CaptureOpResult {
        CaptureOpResult {
            ok: true,
            platform: CapturePlatform::Macos,
            message: "macos adapter: no capture rules present (scaffold uninstall no-op)".into(),
            mutated_system: false,
        }
    }
}
