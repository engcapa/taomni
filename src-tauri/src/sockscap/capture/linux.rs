//! Linux capture adapter (Phase 7 intent, Phase 0 probe-backed scaffold).
//!
//! Planned path (design plan §8 / §13 Phase 7):
//! - Global: TUN
//! - App group / PID: cgroup v2 + nftables socket cgroup match + fwmark policy routing
//! - Managed launch: user/network namespace fallback
//!
//! This scaffold only probes host readiness and refuses install. It never
//! writes nft rules or routes.

use async_trait::async_trait;

use super::{CaptureAdapter, CaptureOpResult, CapturePlan};
use crate::sockscap::capabilities::probe_capabilities;
use crate::sockscap::types::{CapturePlatform, SupportLevel};

#[derive(Debug, Default)]
pub struct LinuxCaptureAdapter;

#[async_trait]
impl CaptureAdapter for LinuxCaptureAdapter {
    fn platform(&self) -> CapturePlatform {
        CapturePlatform::Linux
    }

    fn name(&self) -> &'static str {
        "linux-cgroup-nft-tun"
    }

    fn is_implemented(&self) -> bool {
        false
    }

    async fn preflight(&self, plan: &CapturePlan) -> CaptureOpResult {
        let caps = probe_capabilities();
        let mut notes = Vec::new();
        for item in &caps.items {
            if matches!(
                item.id.as_str(),
                "tun_device" | "cgroup_v2" | "nft_or_fwmark" | "admin_privileges"
            ) {
                notes.push(format!("{}: {} ({:?})", item.name, item.detail, item.level));
            }
        }
        if plan.profiles.is_empty() {
            notes.push("no profiles in plan".into());
        }
        let has_hard_block = caps.items.iter().any(|i| {
            i.id == "capture_plane" && matches!(i.level, SupportLevel::NotImplemented)
        });
        CaptureOpResult {
            ok: false,
            platform: CapturePlatform::Linux,
            message: if has_hard_block {
                format!(
                    "Linux capture adapter not implemented yet. Host probes: {}",
                    notes.join(" | ")
                )
            } else {
                format!("Linux capture preflight incomplete: {}", notes.join(" | "))
            },
            mutated_system: false,
        }
    }

    async fn install(&self, plan: &CapturePlan) -> CaptureOpResult {
        // Refuse before any nft/ip/tun mutation.
        self.preflight(plan).await
    }

    async fn uninstall(&self) -> CaptureOpResult {
        // When real install lands: delete taomni-sockscap nft table, fwmark
        // rules, move PIDs back, destroy TUN. Today: no-op success.
        CaptureOpResult {
            ok: true,
            platform: CapturePlatform::Linux,
            message: "linux adapter: no capture rules present (scaffold uninstall no-op)".into(),
            mutated_system: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn linux_uninstall_is_safe_noop() {
        let a = LinuxCaptureAdapter;
        let r = a.uninstall().await;
        assert!(r.ok);
        assert!(!r.mutated_system);
    }
}
