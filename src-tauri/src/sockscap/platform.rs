//! Platform capture backend selection (plan §8, Phases 5–7).
//!
//! Picks the best available plane at process start:
//! - Linux: nft transparent when `nft` is present, else local SOCKS5.
//! - Windows / macOS: local SOCKS5 is always ready (global, apps point at it);
//!   transparent drivers/extensions report RequiresSetup until installed.
//! - Optional WinDivert feature builds a NETWORK NAT engine when linked.
//!
//! Transparent backends that need signed drivers / Apple entitlements stay
//! honest when artifacts are missing — they never fake Active capture.

use std::sync::Arc;

use super::capture::{CaptureAdapter, CaptureMode};
use super::listener::{FlowRouter, LocalCaptureAdapter};
use super::runtime::DEFAULT_LOCAL_CAPTURE_PORT;

/// Handle used by the runtime to configure the active adapter's router and
/// report which plane is selected.
pub enum CaptureBackend {
    Local(Arc<LocalCaptureAdapter>),
    #[cfg(target_os = "linux")]
    LinuxNft(Arc<super::transparent::LinuxTransparentAdapter>),
}

impl CaptureBackend {
    pub fn adapter(&self) -> Arc<dyn CaptureAdapter> {
        match self {
            CaptureBackend::Local(a) => a.clone(),
            #[cfg(target_os = "linux")]
            CaptureBackend::LinuxNft(a) => a.clone(),
        }
    }

    pub fn set_router(&self, router: Arc<FlowRouter>) {
        match self {
            CaptureBackend::Local(a) => a.set_router(router),
            #[cfg(target_os = "linux")]
            CaptureBackend::LinuxNft(a) => a.set_router(router),
        }
    }

    pub fn mode(&self) -> CaptureMode {
        self.adapter().mode()
    }

    pub fn bound_port(&self) -> Option<u16> {
        match self {
            CaptureBackend::Local(a) => a.bound_port(),
            #[cfg(target_os = "linux")]
            CaptureBackend::LinuxNft(_) => Some(DEFAULT_LOCAL_CAPTURE_PORT),
        }
    }
}

/// Select the capture plane for this host. Prefer transparent when the platform
/// probe says it is ready; always fall back to local SOCKS5 so Start never
/// dead-ends when only global routing via a front-end is required.
pub fn select_backend() -> CaptureBackend {
    #[cfg(target_os = "linux")]
    {
        if super::transparent::LinuxTransparentAdapter::probe_nft() {
            log::info!("sockscap: selecting Linux nft transparent capture");
            return CaptureBackend::LinuxNft(Arc::new(
                super::transparent::LinuxTransparentAdapter::new(
                    DEFAULT_LOCAL_CAPTURE_PORT,
                    None, // global; per-cgroup app scope is a follow-up
                ),
            ));
        }
        log::info!("sockscap: nft unavailable; falling back to local SOCKS5 capture");
    }

    #[cfg(all(windows, feature = "sockscap-windivert"))]
    {
        if windivert_driver_present() {
            log::info!("sockscap: WinDivert feature built and driver present (using local SOCKS + NAT path when wired)");
            // Full CaptureAdapter wrap of WinDivertEngine is feature-gated and
            // still pairs with the local transparent listener; the local SOCKS
            // front-end remains the always-on plane in this build until the
            // NAT→listener handoff is fully integrated on hardware.
        }
    }

    CaptureBackend::Local(Arc::new(LocalCaptureAdapter::new(
        "127.0.0.1",
        DEFAULT_LOCAL_CAPTURE_PORT,
    )))
}

/// Probe for a WinDivert driver/DLL without linking the SDK (Phase 5 readiness).
///
/// Looks in: cwd, System32, next to the running executable, the Taomni resources
/// tree (`src-tauri/resources/windivert` / bundled `resources/windivert`), and PATH.
#[cfg(windows)]
pub fn windivert_driver_present() -> bool {
    let mut candidates: Vec<std::path::PathBuf> = [
        "WinDivert.dll",
        "WinDivert64.sys",
        r"C:\Windows\System32\drivers\WinDivert64.sys",
        r"C:\Windows\System32\WinDivert.dll",
        r"C:\Windows\System32\WinDivert64.sys",
    ]
    .iter()
    .map(std::path::PathBuf::from)
    .collect();

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("WinDivert.dll"));
            candidates.push(dir.join("WinDivert64.sys"));
            candidates.push(dir.join("resources").join("windivert").join("WinDivert.dll"));
            candidates.push(dir.join("resources").join("windivert").join("WinDivert64.sys"));
        }
    }
    // Dev-tree layout when running `tauri dev` from the repo.
    candidates.push(
        std::path::PathBuf::from("src-tauri")
            .join("resources")
            .join("windivert")
            .join("WinDivert.dll"),
    );
    candidates.push(
        std::path::PathBuf::from("resources")
            .join("windivert")
            .join("WinDivert.dll"),
    );

    candidates.iter().any(|p| p.exists())
        || std::env::var_os("PATH").is_some_and(|path| {
            std::env::split_paths(&path).any(|dir| dir.join("WinDivert.dll").exists())
        })
}

#[cfg(not(windows))]
pub fn windivert_driver_present() -> bool {
    false
}

/// Probe whether a macOS system-extension control socket exists (Phase 6).
#[cfg(target_os = "macos")]
pub fn macos_provider_socket_present() -> bool {
    std::path::Path::new("/var/run/com.taomni.app.sockscap.sock").exists()
        || std::path::Path::new("/tmp/com.taomni.app.sockscap.sock").exists()
}

#[cfg(not(target_os = "macos"))]
pub fn macos_provider_socket_present() -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn select_backend_always_returns_ready_adapter() {
        let b = select_backend();
        assert!(b.adapter().is_ready());
        let mode = b.mode();
        assert!(matches!(
            mode,
            CaptureMode::LocalSocks | CaptureMode::LinuxNft
        ));
    }
}
