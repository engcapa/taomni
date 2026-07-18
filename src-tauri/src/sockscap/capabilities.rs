//! Platform capability probes for Sockscap Phase 0.
//!
//! Design plan §2.1 / §8 / §13 Phase 0: probe first, fail fast, never pretend a
//! mode works when the host cannot support it. These probes are intentionally
//! read-only — they do not install drivers, load kernel modules, or mutate
//! routing tables.

use super::types::{
    CapabilitiesReport, CapabilityItem, CapturePlatform, SupportLevel,
};

/// Probe the current host and return a structured capability report.
pub fn probe_capabilities() -> CapabilitiesReport {
    let platform = CapturePlatform::current();
    let mut items = Vec::new();

    items.push(probe_admin_privileges());
    items.push(probe_tun_device());
    items.push(probe_process_identity());
    items.push(probe_pid_attach());
    items.push(probe_nft_or_equivalent());
    items.push(probe_cgroup_v2());
    items.push(probe_helper_channel());
    items.push(probe_egress_connectors());
    items.push(probe_capture_plane_status());

    let capture_implemented = crate::sockscap::capture::current_adapter().is_implemented();

    // Global start feasibility: capture code path exists AND host tools look ok.
    let can_start_global = capture_implemented
        && items.iter().any(|i| {
            i.id == "tun_device"
                || i.id == "nft_or_fwmark"
                || i.id == "admin_privileges"
        });

    // Still require privileges for real install; UI uses can_start_* as soft hints.
    let can_start_global = capture_implemented && {
        #[cfg(target_os = "linux")]
        {
            which::which("nft").is_ok()
        }
        #[cfg(not(target_os = "linux"))]
        {
            false
        }
    };

    let can_start_app_group = can_start_global; // cgroup narrowing still best-effort
    let can_attach_pid = false;

    let summary = if capture_implemented {
        format!(
            "{}: capture adapter '{}' is implemented; install still requires privileges and preflight.",
            match platform {
                CapturePlatform::Windows => "Windows",
                CapturePlatform::Macos => "macOS",
                CapturePlatform::Linux => "Linux",
                CapturePlatform::Unknown => "Unknown",
            },
            crate::sockscap::capture::current_adapter().name()
        )
    } else {
        build_summary(platform, &items)
    };

    // Refresh capture_plane item to match adapter readiness.
    for item in &mut items {
        if item.id == "capture_plane" {
            if capture_implemented {
                item.level = SupportLevel::Degraded;
                item.detail = format!(
                    "Adapter '{}' is implemented; privileged install required for Active.",
                    crate::sockscap::capture::current_adapter().name()
                );
            }
        }
    }

    CapabilitiesReport {
        platform,
        items,
        can_start_global,
        can_start_app_group,
        can_attach_pid,
        summary,
        capture_implemented,
    }
}

fn build_summary(platform: CapturePlatform, items: &[CapabilityItem]) -> String {
    let unsupported: Vec<&str> = items
        .iter()
        .filter(|i| matches!(i.level, SupportLevel::Unsupported))
        .map(|i| i.name.as_str())
        .collect();
    let not_impl: Vec<&str> = items
        .iter()
        .filter(|i| matches!(i.level, SupportLevel::NotImplemented))
        .map(|i| i.name.as_str())
        .collect();

    let platform_name = match platform {
        CapturePlatform::Windows => "Windows",
        CapturePlatform::Macos => "macOS",
        CapturePlatform::Linux => "Linux",
        CapturePlatform::Unknown => "Unknown platform",
    };

    if !not_impl.is_empty() {
        format!(
            "{platform_name}: Phase 0 capability probe complete. Capture plane not yet implemented ({}).",
            not_impl.join(", ")
        )
    } else if !unsupported.is_empty() {
        format!(
            "{platform_name}: missing capabilities: {}.",
            unsupported.join(", ")
        )
    } else {
        format!("{platform_name}: host probes look healthy; waiting for capture adapter.")
    }
}

fn probe_admin_privileges() -> CapabilityItem {
    use crate::sockscap::elevate::{
        elevation_prompt_available, elevation_status_detail, is_currently_elevated,
    };

    if is_currently_elevated() {
        return CapabilityItem {
            id: "admin_privileges".into(),
            name: "Elevated privileges".into(),
            level: SupportLevel::Supported,
            detail: elevation_status_detail(),
            // Not required at process start — only at Sockscap Start.
            required_for_start: false,
        };
    }

    if elevation_prompt_available() {
        return CapabilityItem {
            id: "admin_privileges".into(),
            name: "On-demand elevation".into(),
            level: SupportLevel::Supported,
            detail: format!(
                "{} Taomni stays unprivileged until you start Sockscap.",
                elevation_status_detail()
            ),
            // Prompt happens at start; preflight must not block the whole app.
            required_for_start: false,
        };
    }

    CapabilityItem {
        id: "admin_privileges".into(),
        name: "Elevated privileges".into(),
        level: SupportLevel::Unsupported,
        detail: elevation_status_detail(),
        required_for_start: true,
    }
}


fn probe_tun_device() -> CapabilityItem {
    #[cfg(target_os = "linux")]
    {
        let path = std::path::Path::new("/dev/net/tun");
        if path.exists() {
            CapabilityItem {
                id: "tun_device".into(),
                name: "TUN device".into(),
                level: SupportLevel::Supported,
                detail: "/dev/net/tun is present.".into(),
                required_for_start: true,
            }
        } else {
            CapabilityItem {
                id: "tun_device".into(),
                name: "TUN device".into(),
                level: SupportLevel::Unsupported,
                detail: "/dev/net/tun is missing; global TUN capture cannot start.".into(),
                required_for_start: true,
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        CapabilityItem {
            id: "tun_device".into(),
            name: "Wintun / TUN".into(),
            level: SupportLevel::NotImplemented,
            detail: "Wintun packaging + install probe lands with Phase 0 Windows spike / Phase 5.".into(),
            required_for_start: true,
        }
    }

    #[cfg(target_os = "macos")]
    {
        CapabilityItem {
            id: "tun_device".into(),
            name: "utun / Network Extension".into(),
            level: SupportLevel::NotImplemented,
            detail: "Prefer NETransparentProxyProvider over raw utun (design plan §8).".into(),
            required_for_start: true,
        }
    }

    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    {
        CapabilityItem {
            id: "tun_device".into(),
            name: "TUN device".into(),
            level: SupportLevel::Unsupported,
            detail: "Unsupported platform.".into(),
            required_for_start: true,
        }
    }
}

fn probe_process_identity() -> CapabilityItem {
    #[cfg(target_os = "linux")]
    {
        CapabilityItem {
            id: "process_identity".into(),
            name: "Process identity".into(),
            level: SupportLevel::Supported,
            detail: "Executable path + cgroup membership available via /proc.".into(),
            required_for_start: false,
        }
    }

    #[cfg(target_os = "windows")]
    {
        CapabilityItem {
            id: "process_identity".into(),
            name: "Process identity".into(),
            level: SupportLevel::NotImplemented,
            detail: "WinDivert SOCKET/FLOW or WFP ALE will provide PID ownership (Phase 0 ADR).".into(),
            required_for_start: false,
        }
    }

    #[cfg(target_os = "macos")]
    {
        CapabilityItem {
            id: "process_identity".into(),
            name: "Process identity".into(),
            level: SupportLevel::NotImplemented,
            detail: "sourceAppAuditToken + code signing identity (Phase 6).".into(),
            required_for_start: false,
        }
    }

    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    {
        CapabilityItem {
            id: "process_identity".into(),
            name: "Process identity".into(),
            level: SupportLevel::Unsupported,
            detail: "Unsupported platform.".into(),
            required_for_start: false,
        }
    }
}

fn probe_pid_attach() -> CapabilityItem {
    #[cfg(target_os = "linux")]
    {
        let cgroup = probe_cgroup_v2_available();
        if cgroup {
            CapabilityItem {
                id: "pid_attach".into(),
                name: "Running PID attach".into(),
                level: SupportLevel::Degraded,
                detail: "cgroup v2 present; PID attach will move the process into a managed cgroup for new connections only.".into(),
                required_for_start: false,
            }
        } else {
            CapabilityItem {
                id: "pid_attach".into(),
                name: "Running PID attach".into(),
                level: SupportLevel::Unsupported,
                detail: "cgroup v2 unavailable; degrade to global or managed-launch netns.".into(),
                required_for_start: false,
            }
        }
    }

    #[cfg(not(target_os = "linux"))]
    {
        CapabilityItem {
            id: "pid_attach".into(),
            name: "Running PID attach".into(),
            level: SupportLevel::NotImplemented,
            detail: "Platform PID attach adapter not implemented in Phase 0 scaffold.".into(),
            required_for_start: false,
        }
    }
}

fn probe_nft_or_equivalent() -> CapabilityItem {
    #[cfg(target_os = "linux")]
    {
        let nft = which_bin("nft");
        let ip = which_bin("ip");
        match (nft, ip) {
            (true, true) => CapabilityItem {
                id: "nft_or_fwmark".into(),
                name: "nftables + iproute2".into(),
                level: SupportLevel::Supported,
                detail: "`nft` and `ip` found on PATH.".into(),
                required_for_start: false,
            },
            (nft_ok, ip_ok) => CapabilityItem {
                id: "nft_or_fwmark".into(),
                name: "nftables + iproute2".into(),
                level: SupportLevel::Degraded,
                detail: format!(
                    "nft={}, ip={}; app-group mode needs both for cgroup match + fwmark policy routing.",
                    if nft_ok { "yes" } else { "no" },
                    if ip_ok { "yes" } else { "no" }
                ),
                required_for_start: false,
            },
        }
    }

    #[cfg(target_os = "windows")]
    {
        CapabilityItem {
            id: "nft_or_fwmark".into(),
            name: "WFP / WinDivert".into(),
            level: SupportLevel::NotImplemented,
            detail: "Windows filter plane selection is a Phase 0 ADR open gate.".into(),
            required_for_start: false,
        }
    }

    #[cfg(target_os = "macos")]
    {
        CapabilityItem {
            id: "nft_or_fwmark".into(),
            name: "Network Extension filter".into(),
            level: SupportLevel::NotImplemented,
            detail: "NETransparentProxyProvider is the planned filter plane.".into(),
            required_for_start: false,
        }
    }

    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    {
        CapabilityItem {
            id: "nft_or_fwmark".into(),
            name: "Packet filter".into(),
            level: SupportLevel::Unsupported,
            detail: "Unsupported platform.".into(),
            required_for_start: false,
        }
    }
}

fn probe_cgroup_v2() -> CapabilityItem {
    #[cfg(target_os = "linux")]
    {
        if probe_cgroup_v2_available() {
            CapabilityItem {
                id: "cgroup_v2".into(),
                name: "cgroup v2".into(),
                level: SupportLevel::Supported,
                detail: "cgroup2 filesystem is mounted.".into(),
                required_for_start: false,
            }
        } else {
            CapabilityItem {
                id: "cgroup_v2".into(),
                name: "cgroup v2".into(),
                level: SupportLevel::Unsupported,
                detail: "cgroup v2 not detected; app-group / PID modes unavailable.".into(),
                required_for_start: false,
            }
        }
    }

    #[cfg(not(target_os = "linux"))]
    {
        CapabilityItem {
            id: "cgroup_v2".into(),
            name: "cgroup v2".into(),
            level: SupportLevel::Unsupported,
            detail: "Linux-only capability.".into(),
            required_for_start: false,
        }
    }
}

#[cfg(target_os = "linux")]
fn probe_cgroup_v2_available() -> bool {
    // Controllers file exists only on cgroup2 mounts.
    std::path::Path::new("/sys/fs/cgroup/cgroup.controllers").exists()
        || std::fs::read_to_string("/proc/filesystems")
            .map(|s| s.contains("cgroup2"))
            .unwrap_or(false)
}

fn probe_helper_channel() -> CapabilityItem {
    CapabilityItem {
        id: "privileged_helper".into(),
        name: "Privileged helper".into(),
        level: SupportLevel::NotImplemented,
        detail: "Helper binary, version handshake, caller signature check, and heartbeat are Phase 0/5-7 work.".into(),
        required_for_start: true,
    }
}

fn probe_egress_connectors() -> CapabilityItem {
    // Egress connectors themselves are pure userspace and do not need capture.
    // Phase 2 implements them; Phase 0 only asserts the dependency surface.
    CapabilityItem {
        id: "egress_connectors".into(),
        name: "Egress connectors".into(),
        level: SupportLevel::Degraded,
        detail: "DIRECT/SOCKS5/HTTP CONNECT/SSH Jump planned; implementation starts in Phase 2. Existing proxy:: + tunnel:: code is reusable.".into(),
        required_for_start: false,
    }
}

fn probe_capture_plane_status() -> CapabilityItem {
    CapabilityItem {
        id: "capture_plane".into(),
        name: "Capture plane".into(),
        level: SupportLevel::NotImplemented,
        detail: "Single system capture plane not installed in this build. Phase 0 gate must complete before Active.".into(),
        required_for_start: true,
    }
}

fn which_bin(name: &str) -> bool {
    which::which(name).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_returns_report_for_current_platform() {
        let report = probe_capabilities();
        assert!(!report.items.is_empty());
        assert!(matches!(
            report.platform,
            CapturePlatform::Windows | CapturePlatform::Macos | CapturePlatform::Linux
        ));
        // Linux with nft present reports capture_implemented; others may not.
        #[cfg(target_os = "linux")]
        {
            if which::which("nft").is_ok() {
                assert!(report.capture_implemented);
            }
        }
    }

    #[test]
    fn every_item_has_id_and_detail() {
        let report = probe_capabilities();
        for item in &report.items {
            assert!(!item.id.is_empty());
            assert!(!item.name.is_empty());
            assert!(!item.detail.is_empty());
        }
    }

    #[test]
    fn capture_plane_item_is_present() {
        let report = probe_capabilities();
        let capture = report
            .items
            .iter()
            .find(|i| i.id == "capture_plane")
            .expect("capture_plane item");
        assert!(capture.required_for_start);
        #[cfg(not(target_os = "linux"))]
        {
            assert_eq!(capture.level, SupportLevel::NotImplemented);
        }
    }
}
