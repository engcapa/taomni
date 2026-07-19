//! Read-only platform capability probes for Sockscap.
//!
//! Probe first, fail fast, and never pretend a mode works when its installed
//! adapter is incomplete. These probes do not install drivers, launch the
//! privileged helper, load extensions, or mutate host networking.

use super::types::{CapabilitiesReport, CapabilityItem, CapturePlatform, SupportLevel};

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

    // Source contracts and host prerequisites are not proof that a signed or
    // privileged adapter is installed and wired into the product runtime.
    let can_start_global = false;
    let can_start_app_group = false;
    let can_attach_pid = false;

    let summary = build_summary(platform, &items);

    CapabilitiesReport {
        platform,
        items,
        can_start_global,
        can_start_app_group,
        can_attach_pid,
        summary,
        capture_implemented: false,
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
            "{platform_name}: host probe complete; release capture remains disabled until installed adapter gates pass ({}).",
            not_impl.join(", ")
        )
    } else if !unsupported.is_empty() {
        format!(
            "{platform_name}: missing capabilities: {}.",
            unsupported.join(", ")
        )
    } else {
        format!(
            "{platform_name}: host probes look healthy; installed capture adapter is not enabled."
        )
    }
}

fn probe_admin_privileges() -> CapabilityItem {
    #[cfg(target_os = "linux")]
    {
        let euid = libc_euid();
        if euid == 0 {
            return CapabilityItem {
                id: "admin_privileges".into(),
                name: "Elevated privileges".into(),
                level: SupportLevel::Supported,
                detail: "Running as root (euid=0).".into(),
                required_for_start: true,
            };
        }
        // CAP_NET_ADMIN is the real requirement; without libcap we only report
        // whether we are root. Helper will re-check at install time.
        return CapabilityItem {
            id: "admin_privileges".into(),
            name: "Elevated privileges".into(),
            level: SupportLevel::Degraded,
            detail: format!(
                "euid={euid}; CAP_NET_ADMIN / polkit helper required for capture install."
            ),
            required_for_start: true,
        };
    }

    #[cfg(target_os = "windows")]
    {
        CapabilityItem {
            id: "admin_privileges".into(),
            name: "Elevated privileges".into(),
            level: SupportLevel::Unknown,
            detail: "Windows elevation probe deferred to helper (Phase 5).".into(),
            required_for_start: true,
        }
    }

    #[cfg(target_os = "macos")]
    {
        CapabilityItem {
            id: "admin_privileges".into(),
            name: "System extension approval".into(),
            level: SupportLevel::Unknown,
            detail:
                "macOS NETransparentProxyProvider entitlement + user approval required (Phase 6)."
                    .into(),
            required_for_start: true,
        }
    }

    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    {
        CapabilityItem {
            id: "admin_privileges".into(),
            name: "Elevated privileges".into(),
            level: SupportLevel::Unsupported,
            detail: "Unsupported platform.".into(),
            required_for_start: true,
        }
    }
}

#[cfg(target_os = "linux")]
fn libc_euid() -> u32 {
    // Avoid adding a libc crate dep just for geteuid; use the raw syscall via
    // nix is also not required — std has no euid, so call libc if linked, else
    // parse /proc/self/status.
    if let Ok(status) = std::fs::read_to_string("/proc/self/status") {
        for line in status.lines() {
            if let Some(rest) = line.strip_prefix("Uid:") {
                // Uid: real effective saved fs
                let parts: Vec<&str> = rest.split_whitespace().collect();
                if parts.len() >= 2 {
                    if let Ok(euid) = parts[1].parse::<u32>() {
                        return euid;
                    }
                }
            }
        }
    }
    1
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
            detail: "Wintun packaging + install probe lands with Phase 0 Windows spike / Phase 5."
                .into(),
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
            detail: "WinDivert SOCKET/FLOW or WFP ALE will provide PID ownership (Phase 0 ADR)."
                .into(),
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
                detail: "cgroup v2 is present and the Linux transaction supports PID/start-token moves for new connections; product launcher/client wiring is still gated.".into(),
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
    #[cfg(target_os = "linux")]
    {
        let installed_policy =
            std::path::Path::new(super::capture::unix_transport::INSTALLED_HELPER_POLICY).is_file();
        return CapabilityItem {
            id: "privileged_helper".into(),
            name: "Privileged helper".into(),
            level: if installed_policy {
                SupportLevel::Degraded
            } else {
                SupportLevel::NotImplemented
            },
            detail: if installed_policy {
                "Authenticated Linux helper policy is present, but the product launcher/client and userspace TUN pump are not wired; start remains blocked."
                    .into()
            } else {
                "Root-only Linux helper, SO_PEERCRED/SHA-256 authentication, HMAC protocol, heartbeat, and recovery transactions are compiled; the root-owned release policy, launcher/client, and TUN pump are not installed/wired."
                    .into()
            },
            required_for_start: true,
        };
    }

    #[cfg(target_os = "windows")]
    {
        return CapabilityItem {
            id: "privileged_helper".into(),
            name: "Signed helper / driver".into(),
            level: SupportLevel::NotImplemented,
            detail: "No release-signed Windows helper/provider package is installed; the signed-artifact manifest gate remains disabled."
                .into(),
            required_for_start: true,
        };
    }

    #[cfg(target_os = "macos")]
    {
        return CapabilityItem {
            id: "privileged_helper".into(),
            name: "Network Extension provider".into(),
            level: SupportLevel::NotImplemented,
            detail: "No entitled, Developer-ID-signed, notarized Network Extension is installed; release verification remains disabled."
                .into(),
            required_for_start: true,
        };
    }

    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    {
        CapabilityItem {
            id: "privileged_helper".into(),
            name: "Privileged helper".into(),
            level: SupportLevel::Unsupported,
            detail: "Unsupported platform.".into(),
            required_for_start: true,
        }
    }
}

fn probe_egress_connectors() -> CapabilityItem {
    CapabilityItem {
        id: "egress_connectors".into(),
        name: "Egress connectors".into(),
        level: SupportLevel::Supported,
        detail: "DIRECT, SOCKS5 TCP, HTTP CONNECT, and pooled SSH direct-tcpip connectors are compiled; the full real-server compatibility matrix remains a release gate.".into(),
        required_for_start: false,
    }
}

fn probe_capture_plane_status() -> CapabilityItem {
    #[cfg(target_os = "linux")]
    let detail = "Linux cgroup v2+nft+fwmark/TUN planning, execution, receipt cleanup, and authenticated root helper are compiled, but no installed client adapter/TUN pump is attached to the product orchestrator.";
    #[cfg(target_os = "windows")]
    let detail = "Windows source/signature gates exist, but Wintun plus WinDivert/WFP adapter selection and signed provider integration are not implemented.";
    #[cfg(target_os = "macos")]
    let detail = "macOS entitlement/signing gates exist, but the Swift NETransparentProxyProvider target and Rust bridge are not implemented or enrolled.";
    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    let detail = "No capture implementation is available for this platform.";
    CapabilityItem {
        id: "capture_plane".into(),
        name: "Capture plane".into(),
        level: SupportLevel::NotImplemented,
        detail: detail.into(),
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
        assert!(!report.capture_implemented);
        // Source scaffolding must never be mistaken for an installed adapter.
        assert!(!report.can_start_global);
        assert!(!report.can_start_app_group);
        assert!(!report.can_attach_pid);
        assert!(matches!(
            report.platform,
            CapturePlatform::Windows | CapturePlatform::Macos | CapturePlatform::Linux
        ));
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
    fn capture_plane_item_is_not_implemented() {
        let report = probe_capabilities();
        let capture = report
            .items
            .iter()
            .find(|i| i.id == "capture_plane")
            .expect("capture_plane item");
        assert_eq!(capture.level, SupportLevel::NotImplemented);
        assert!(capture.required_for_start);
    }
}
