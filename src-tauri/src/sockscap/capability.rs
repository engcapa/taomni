//! Platform capability detection (plan §8 capability matrix, §12
//! `sockscap_capabilities`).
//!
//! Honestly reports what the current platform can do so the UI never pretends
//! to support a mode it can't (plan §8: "Linux 若能力探测不满足…UI 不假装支持").
//! This is a best-effort probe: the real, authoritative checks (WinDivert/WFP
//! driver present and signed, macOS system-extension approved, cgroup v2 +
//! nft + iproute2 available) land with the platform vertical phases (§5-7).
//! Until then, capture that needs a driver/extension reports `RequiresSetup`,
//! and Linux app/PID capture degrades to `Degraded` when cgroup v2 is absent.

use serde::Serialize;

/// How well a capture scope is supported on this platform right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CaptureSupport {
    /// Usable now.
    Supported,
    /// Needs a one-time privileged install / approval (driver, system
    /// extension, polkit).
    RequiresSetup,
    /// Works in a reduced form (e.g. Linux without cgroup v2 → global or
    /// managed-launch only).
    Degraded,
    /// Not available on this platform.
    Unsupported,
}

/// The capability report returned by `sockscap_capabilities`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub platform: String,
    pub global_capture: CaptureSupport,
    pub app_capture: CaptureSupport,
    pub pid_capture: CaptureSupport,
    /// Whether child processes can be followed reliably.
    pub child_follow: bool,
    /// Left-clicking the tray icon can toggle show/hide (plan §8: Tauri's tray
    /// click event is unsupported on Linux — menu fallback there).
    pub tray_left_click_toggle: bool,
    /// Any capture mode needs elevation / signed driver / entitlement.
    pub requires_privilege: bool,
    /// Human notes / warnings for the UI.
    pub notes: Vec<String>,
}

/// Detect capabilities for the current platform.
pub fn detect() -> Capabilities {
    #[cfg(target_os = "windows")]
    {
        detect_windows()
    }
    #[cfg(target_os = "macos")]
    {
        detect_macos()
    }
    #[cfg(target_os = "linux")]
    {
        detect_linux(cgroup_v2_present())
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        Capabilities {
            platform: "unknown".into(),
            global_capture: CaptureSupport::Unsupported,
            app_capture: CaptureSupport::Unsupported,
            pid_capture: CaptureSupport::Unsupported,
            child_follow: false,
            tray_left_click_toggle: false,
            requires_privilege: false,
            notes: vec!["unsupported platform".into()],
        }
    }
}

#[cfg(target_os = "windows")]
fn detect_windows() -> Capabilities {
    let divert = super::platform::windivert_driver_present();
    let mut notes = vec![
        "Global routing via local SOCKS5 front-end is available without a driver (point apps at 127.0.0.1:1080)".into(),
    ];
    if divert {
        notes.push("WinDivert driver/DLL detected — transparent app/PID capture can be enabled with a signed build".into());
    } else {
        notes.push("Transparent app/PID capture requires a signed WinDivert/WFP driver (not installed)".into());
    }
    Capabilities {
        platform: "windows".into(),
        // Local SOCKS front-end: global is Supported; transparent still needs driver.
        global_capture: CaptureSupport::Supported,
        app_capture: if divert {
            CaptureSupport::RequiresSetup
        } else {
            CaptureSupport::RequiresSetup
        },
        pid_capture: CaptureSupport::RequiresSetup,
        child_follow: true,
        tray_left_click_toggle: true,
        requires_privilege: !divert, // local socks doesn't need admin; transparent does
        notes,
    }
}

#[cfg(target_os = "macos")]
fn detect_macos() -> Capabilities {
    let provider = super::platform::macos_provider_socket_present();
    let mut notes = vec![
        "Global routing via local SOCKS5 front-end is available (point apps at 127.0.0.1:1080)".into(),
    ];
    if provider {
        notes.push("Sockscap Network Extension control socket present".into());
    } else {
        notes.push("Transparent app capture requires approving the Network Extension (NETransparentProxyProvider)".into());
    }
    Capabilities {
        platform: "macos".into(),
        global_capture: CaptureSupport::Supported,
        app_capture: CaptureSupport::RequiresSetup,
        pid_capture: CaptureSupport::RequiresSetup,
        child_follow: true,
        tray_left_click_toggle: true,
        requires_privilege: true,
        notes,
    }
}

/// Linux capability, parameterized on cgroup-v2 availability for testability.
#[cfg(target_os = "linux")]
fn detect_linux(cgroup_v2: bool) -> Capabilities {
    linux_caps(cgroup_v2)
}

/// Pure Linux capability computation (also unit-tested off-Linux).
pub fn linux_caps(cgroup_v2: bool) -> Capabilities {
    let (app, pid, mut notes) = if cgroup_v2 {
        (
            CaptureSupport::RequiresSetup,
            CaptureSupport::RequiresSetup,
            vec!["cgroup v2 detected; app/PID capture needs CAP_NET_ADMIN + nftables".into()],
        )
    } else {
        (
            CaptureSupport::Degraded,
            CaptureSupport::Unsupported,
            vec![
                "cgroup v2 not detected; PID attach unavailable — falling back to global or \
                 managed-launch (network namespace)"
                    .into(),
            ],
        )
    };
    notes.push("Global routing via local SOCKS5 front-end is always available".into());
    notes.push("Tray left-click toggle not supported on Linux; use the tray menu".into());
    Capabilities {
        platform: "linux".into(),
        // Local SOCKS front-end always works; nft transparent is a bonus when ready.
        global_capture: CaptureSupport::Supported,
        app_capture: app,
        pid_capture: pid,
        child_follow: cgroup_v2,
        tray_left_click_toggle: false,
        requires_privilege: true,
        notes,
    }
}

/// Best-effort cgroup-v2 detection: the unified hierarchy exposes
/// `cgroup.controllers` at the mount root.
#[cfg(target_os = "linux")]
fn cgroup_v2_present() -> bool {
    std::path::Path::new("/sys/fs/cgroup/cgroup.controllers").exists()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_reports_a_platform() {
        let caps = detect();
        assert!(!caps.platform.is_empty());
    }

    #[test]
    fn linux_without_cgroup_v2_degrades_pid_capture() {
        let caps = linux_caps(false);
        assert_eq!(caps.pid_capture, CaptureSupport::Unsupported);
        assert_eq!(caps.app_capture, CaptureSupport::Degraded);
        assert!(!caps.child_follow);
        assert!(!caps.tray_left_click_toggle);
    }

    #[test]
    fn linux_with_cgroup_v2_enables_app_capture_setup() {
        let caps = linux_caps(true);
        assert_eq!(caps.app_capture, CaptureSupport::RequiresSetup);
        assert_eq!(caps.pid_capture, CaptureSupport::RequiresSetup);
        assert!(caps.child_follow);
    }
}
