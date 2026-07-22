//! Platform capture plane.
//!
//! Phase 1: capability reporting + recover stub only.
//! Phase 2+: WinDivert (Windows), cgroup/nft or TUN (Linux), NE/utun (macOS).

use serde::{Deserialize, Serialize};

// Re-export for orchestrator without circular path noise.
pub use super::SocksCapCapabilities;

/// Describe what this build/OS can do today.
pub fn capabilities() -> SocksCapCapabilities {
    #[cfg(target_os = "windows")]
    {
        SocksCapCapabilities {
            platform: "windows".into(),
            global_tcp: true,
            app_filter: true,
            capture_backend: "windivert-helper".into(),
            notes: vec![
                "Windows: elevated sockscap-helper + WinDivert FLOW/NETWORK. Place WinDivert.dll next to the helper.".into(),
            ],
            privileged_required: true,
        }
    }
    #[cfg(target_os = "linux")]
    {
        SocksCapCapabilities {
            platform: "linux".into(),
            global_tcp: false,
            app_filter: false,
            capture_backend: "nft-cgroup-planned".into(),
            notes: vec![
                "Linux cgroup/nft or TUN capture is planned; rules/egress engine is available now."
                    .into(),
            ],
            privileged_required: true,
        }
    }
    #[cfg(target_os = "macos")]
    {
        SocksCapCapabilities {
            platform: "macos".into(),
            global_tcp: false,
            app_filter: false,
            capture_backend: "network-extension-planned".into(),
            notes: vec![
                "macOS Network Extension / utun is planned; rules/egress engine is available now."
                    .into(),
            ],
            privileged_required: true,
        }
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        SocksCapCapabilities {
            platform: std::env::consts::OS.into(),
            global_tcp: false,
            app_filter: false,
            capture_backend: "unsupported".into(),
            notes: vec!["Unsupported platform for SocksCap capture.".into()],
            privileged_required: false,
        }
    }
}

/// Undo any residual OS capture state (no-op until capture is implemented).
pub async fn recover_system() -> Result<(), String> {
    Ok(())
}

/// Future trait for platform adapters.
#[allow(async_fn_in_trait)]
pub trait CapturePlane: Send + Sync {
    async fn preflight(&self) -> Result<SocksCapCapabilities, String>;
    async fn stop(&self) -> Result<(), String>;
    async fn recover(&self) -> Result<(), String>;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturePlan {
    pub global: bool,
    pub app_paths: Vec<String>,
}
