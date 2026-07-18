//! Core Sockscap domain types shared across phases.
//!
//! These types intentionally mirror the design plan §5 / §9 / §12. Persistence
//! (sockscap.db) lands in Phase 3; Phase 0 only needs the serializable shapes
//! for capability/status IPC and unit tests.

use serde::{Deserialize, Serialize};

/// Engine lifecycle states (design plan §9).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EngineState {
    Disabled,
    Preparing,
    Active,
    Degraded,
    Stopping,
    RecoveryRequired,
    /// Waiting for user input (SSH MFA, host-key confirmation, vault unlock).
    UserActionRequired,
}

impl Default for EngineState {
    fn default() -> Self {
        Self::Disabled
    }
}

/// How a routing profile selects traffic.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProfileScope {
    Global,
    Applications,
    RuntimeProcesses,
}

/// Upstream egress kind. DIRECT is a rule action, never an egress kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EgressKind {
    ProxySession,
    SshJump,
}

/// Final routing action for a flow.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum RouteAction {
    #[default]
    Direct,
    Proxy,
    Block,
}

/// When egress fails (proxy down, SSH disconnect, vault locked).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EgressFailureAction {
    /// Fail open: fall back to DIRECT.
    FailOpen,
    /// Fail closed: BLOCK the flow.
    FailClosed,
}

impl Default for EgressFailureAction {
    fn default() -> Self {
        // Design decision §16.2 #4: global default is fail-open.
        Self::FailOpen
    }
}

/// DNS handling mode for a profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DnsMode {
    SystemCapture,
    VirtualDns,
    StrictProxy,
}

impl Default for DnsMode {
    fn default() -> Self {
        Self::SystemCapture
    }
}

/// UDP / QUIC policy when the selected egress cannot carry UDP.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UdpPolicy {
    /// Use SOCKS5 UDP ASSOCIATE when the upstream supports it.
    ProxyIfSupported,
    Direct,
    Block,
}

impl Default for UdpPolicy {
    fn default() -> Self {
        // Design decision §16.2 #6: TCP-only upstreams default BLOCK for UDP/QUIC.
        Self::Block
    }
}

/// Source of the hostname used for rule matching (design plan §4.1 DomainAttribution).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HostnameSource {
    PlatformRemoteHostname,
    FakeIpDnsMap,
    TlsSni,
    HttpHost,
    IpOnly,
    Unknown,
}

/// Platform the capture adapter is running on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CapturePlatform {
    Windows,
    Macos,
    Linux,
    Unknown,
}

impl CapturePlatform {
    pub fn current() -> Self {
        #[cfg(target_os = "windows")]
        {
            Self::Windows
        }
        #[cfg(target_os = "macos")]
        {
            Self::Macos
        }
        #[cfg(target_os = "linux")]
        {
            Self::Linux
        }
        #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
        {
            Self::Unknown
        }
    }
}

/// Support level for a platform capability.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SupportLevel {
    /// Fully supported on this host.
    Supported,
    /// Partial / degraded; UI must explain the limitation.
    Degraded,
    /// Not available; feature must be hidden or refused.
    Unsupported,
    /// Not yet implemented in this build (Phase 0 scaffold).
    NotImplemented,
    /// Probe did not run or timed out.
    Unknown,
}

/// One discrete capability probe result.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityItem {
    pub id: String,
    pub name: String,
    pub level: SupportLevel,
    pub detail: String,
    /// True when missing this capability blocks engine start for the requested mode.
    pub required_for_start: bool,
}

/// Aggregate platform capability report returned by `sockscap_capabilities`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilitiesReport {
    pub platform: CapturePlatform,
    pub items: Vec<CapabilityItem>,
    /// True when at least global TCP capture is feasible on this host.
    pub can_start_global: bool,
    /// True when application-group capture is feasible without silent fallback.
    pub can_start_app_group: bool,
    /// True when attaching a running PID is feasible.
    pub can_attach_pid: bool,
    /// Human-readable summary for UI banners.
    pub summary: String,
    /// Phase 0: capture is never actually installed yet.
    pub capture_implemented: bool,
}

/// Lightweight engine status snapshot for UI / tray.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    pub state: EngineState,
    pub message: String,
    pub active_profile_ids: Vec<String>,
    pub last_error: Option<String>,
    pub recovery_required: bool,
    /// Phase 0: always false until capture adapters land.
    pub capture_active: bool,
}

impl Default for EngineStatus {
    fn default() -> Self {
        Self {
            state: EngineState::Disabled,
            message: "Sockscap engine is disabled".into(),
            active_profile_ids: Vec::new(),
            last_error: None,
            recovery_required: false,
            capture_active: false,
        }
    }
}

/// Minimal routing-profile shape used by preflight conflict checks in Phase 0.
/// Full CRUD + sockscap.db persistence lands in Phase 1/3.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingProfileDraft {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    /// Lower number = higher priority (design plan §5).
    pub priority: u32,
    pub scope: ProfileScope,
    pub app_selectors: Vec<String>,
    pub include_children: bool,
    pub egress_kind: Option<EgressKind>,
    pub egress_ref_id: Option<String>,
    pub egress_failure_action: EgressFailureAction,
    pub default_action: RouteAction,
    pub dns_mode: DnsMode,
    pub unknown_domain_action: RouteAction,
    pub udp_policy: UdpPolicy,
}

impl Default for RoutingProfileDraft {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            enabled: true,
            priority: 100,
            scope: ProfileScope::Applications,
            app_selectors: Vec::new(),
            include_children: true,
            egress_kind: None,
            egress_ref_id: None,
            egress_failure_action: EgressFailureAction::default(),
            default_action: RouteAction::Direct,
            dns_mode: DnsMode::default(),
            unknown_domain_action: RouteAction::Direct,
            udp_policy: UdpPolicy::default(),
        }
    }
}

/// Result of validating a set of profiles for conflicts (design plan §5 / §16.4).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileConflict {
    pub profile_a: String,
    pub profile_b: String,
    pub reason: String,
}

/// Detect configuration conflicts without touching the system network stack.
pub fn detect_profile_conflicts(profiles: &[RoutingProfileDraft]) -> Vec<ProfileConflict> {
    let enabled: Vec<&RoutingProfileDraft> = profiles.iter().filter(|p| p.enabled).collect();
    let mut conflicts = Vec::new();

    let globals: Vec<&&RoutingProfileDraft> = enabled
        .iter()
        .filter(|p| p.scope == ProfileScope::Global)
        .collect();
    if globals.len() > 1 {
        for i in 0..globals.len() {
            for j in (i + 1)..globals.len() {
                conflicts.push(ProfileConflict {
                    profile_a: globals[i].id.clone(),
                    profile_b: globals[j].id.clone(),
                    reason: "at most one enabled global routing profile is allowed".into(),
                });
            }
        }
    }

    // Same priority + overlapping app selectors is forbidden.
    for i in 0..enabled.len() {
        for j in (i + 1)..enabled.len() {
            let a = enabled[i];
            let b = enabled[j];
            if a.scope != ProfileScope::Applications || b.scope != ProfileScope::Applications {
                continue;
            }
            if a.priority != b.priority {
                continue;
            }
            let overlap = a
                .app_selectors
                .iter()
                .any(|sa| b.app_selectors.iter().any(|sb| sa == sb));
            if overlap {
                conflicts.push(ProfileConflict {
                    profile_a: a.id.clone(),
                    profile_b: b.id.clone(),
                    reason: format!(
                        "application selectors overlap at the same priority {}",
                        a.priority
                    ),
                });
            }
        }
    }

    conflicts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_two_enabled_global_profiles() {
        let profiles = vec![
            RoutingProfileDraft {
                id: "g1".into(),
                name: "Global A".into(),
                enabled: true,
                scope: ProfileScope::Global,
                ..Default::default()
            },
            RoutingProfileDraft {
                id: "g2".into(),
                name: "Global B".into(),
                enabled: true,
                scope: ProfileScope::Global,
                priority: 200,
                ..Default::default()
            },
        ];
        let conflicts = detect_profile_conflicts(&profiles);
        assert_eq!(conflicts.len(), 1);
        assert!(conflicts[0].reason.contains("global"));
    }

    #[test]
    fn allows_disabled_second_global() {
        let profiles = vec![
            RoutingProfileDraft {
                id: "g1".into(),
                enabled: true,
                scope: ProfileScope::Global,
                ..Default::default()
            },
            RoutingProfileDraft {
                id: "g2".into(),
                enabled: false,
                scope: ProfileScope::Global,
                ..Default::default()
            },
        ];
        assert!(detect_profile_conflicts(&profiles).is_empty());
    }

    #[test]
    fn rejects_same_priority_selector_overlap() {
        let profiles = vec![
            RoutingProfileDraft {
                id: "a".into(),
                enabled: true,
                priority: 10,
                scope: ProfileScope::Applications,
                app_selectors: vec!["/usr/bin/curl".into()],
                ..Default::default()
            },
            RoutingProfileDraft {
                id: "b".into(),
                enabled: true,
                priority: 10,
                scope: ProfileScope::Applications,
                app_selectors: vec!["/usr/bin/curl".into(), "/usr/bin/wget".into()],
                ..Default::default()
            },
        ];
        let conflicts = detect_profile_conflicts(&profiles);
        assert_eq!(conflicts.len(), 1);
        assert!(conflicts[0].reason.contains("overlap"));
    }

    #[test]
    fn allows_overlap_at_different_priority() {
        let profiles = vec![
            RoutingProfileDraft {
                id: "a".into(),
                enabled: true,
                priority: 10,
                scope: ProfileScope::Applications,
                app_selectors: vec!["/usr/bin/curl".into()],
                ..Default::default()
            },
            RoutingProfileDraft {
                id: "b".into(),
                enabled: true,
                priority: 20,
                scope: ProfileScope::Applications,
                app_selectors: vec!["/usr/bin/curl".into()],
                ..Default::default()
            },
        ];
        assert!(detect_profile_conflicts(&profiles).is_empty());
    }

    #[test]
    fn platform_current_is_known_on_desktop() {
        let p = CapturePlatform::current();
        assert!(matches!(
            p,
            CapturePlatform::Windows | CapturePlatform::Macos | CapturePlatform::Linux
        ));
    }
}
