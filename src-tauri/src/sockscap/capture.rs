//! CaptureAdapter boundary (plan §4.1).
//!
//! The single traffic-interception plane. Real platform adapters plug in here
//! in the vertical phases: Windows Wintun/WinDivert/WFP (§5), macOS
//! NETransparentProxyProvider system extension (§6), Linux cgroup v2 + nftables
//! + fwmark / managed-launch netns (§7). Each requires signed drivers /
//! entitlements / privileged helpers that can't be produced in a pure code
//! session — see `claudedocs/sockscap-adr/` for the technology-selection gates.
//!
//! Until an adapter is installed, [`NoopCaptureAdapter`] reports the platform's
//! honest capabilities and refuses to install, so the orchestrator can exercise
//! its full lifecycle (prepare → fail cleanly → recover) and the UI can show
//! accurate capability/degradation instead of pretending to capture.

use async_trait::async_trait;

use super::capability::Capabilities;

/// The platform capture plane. The adapter only handles capture, process
/// identity and the raw target — product rules live in the PolicyEngine
/// (plan §4.1).
#[async_trait]
pub trait CaptureAdapter: Send + Sync {
    /// Honest capabilities for this platform/build.
    fn capabilities(&self) -> Capabilities;

    /// Whether the backend (driver / extension / helper) is present and ready
    /// to install capture rules right now.
    fn is_ready(&self) -> bool;

    /// Install capture rules and start delivering flows. Must be paired with a
    /// later `uninstall` (or a recovery-journal cleanup on crash).
    async fn install(&self) -> Result<(), String>;

    /// Remove capture rules and restore direct networking. Should be safe to
    /// call even if `install` partially failed (fail-open, plan §9).
    async fn uninstall(&self) -> Result<(), String>;
}

/// The default adapter used until a real platform backend is installed. Reports
/// capabilities but cannot capture.
pub struct NoopCaptureAdapter {
    caps: Capabilities,
}

impl NoopCaptureAdapter {
    pub fn new() -> NoopCaptureAdapter {
        NoopCaptureAdapter {
            caps: super::capability::detect(),
        }
    }
}

impl Default for NoopCaptureAdapter {
    fn default() -> Self {
        NoopCaptureAdapter::new()
    }
}

#[async_trait]
impl CaptureAdapter for NoopCaptureAdapter {
    fn capabilities(&self) -> Capabilities {
        self.caps.clone()
    }

    fn is_ready(&self) -> bool {
        false
    }

    async fn install(&self) -> Result<(), String> {
        Err("capture backend not installed on this platform build".into())
    }

    async fn uninstall(&self) -> Result<(), String> {
        // Nothing installed — restoring direct networking is a no-op.
        Ok(())
    }
}
