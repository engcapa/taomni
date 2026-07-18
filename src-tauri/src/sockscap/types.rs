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

/// Platform identity represented by an application selector.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AppSelectorKind {
    ExecutablePath,
    MacosSigningIdentity,
    LinuxCgroup,
}

/// Persistent application identity. Runtime PIDs deliberately use a separate
/// type so a short-lived PID can never be mistaken for a remembered app.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSelector {
    pub kind: AppSelectorKind,
    pub value: String,
}

impl AppSelector {
    pub fn executable_path(value: impl Into<String>) -> Self {
        Self {
            kind: AppSelectorKind::ExecutablePath,
            value: value.into(),
        }
    }

    pub fn matches(&self, kind: Option<AppSelectorKind>, identity: &str) -> bool {
        if kind.is_some_and(|expected| expected != self.kind) {
            return false;
        }
        match self.kind {
            AppSelectorKind::ExecutablePath if cfg!(target_os = "windows") => {
                self.value.eq_ignore_ascii_case(identity)
            }
            _ => self.value == identity,
        }
    }
}

/// A runtime process selector is valid only for the exact process incarnation.
/// `process_start_time` is the platform-reported monotonic/epoch token used to
/// guard against PID reuse; zero is never accepted for an enabled profile.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProcessSelector {
    pub pid: u32,
    pub process_start_time: u64,
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

/// How non-loopback LAN/private/link-local destinations are handled. Engine,
/// helper, loopback, and upstream endpoints remain hard bypasses regardless.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalNetworkAction {
    Direct,
    Rules,
    Block,
}

impl Default for LocalNetworkAction {
    fn default() -> Self {
        Self::Direct
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LocalNetworkPolicy {
    pub lan_action: LocalNetworkAction,
}

/// Non-secret SSH pooling knobs stored with a profile. Credentials and host-key
/// trust remain in the main session database / Vault boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshPoolOptions {
    pub max_control_connections: u16,
    pub max_channels_per_connection: u32,
    pub keepalive_seconds: u64,
    pub connect_timeout_seconds: u64,
}

impl Default for SshPoolOptions {
    fn default() -> Self {
        Self {
            max_control_connections: 2,
            max_channels_per_connection: 128,
            keepalive_seconds: 30,
            connect_timeout_seconds: 15,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StatsCollectionMode {
    Persisted,
    SessionOnly,
    Disabled,
}

impl Default for StatsCollectionMode {
    fn default() -> Self {
        Self::Persisted
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsPrivacy {
    pub collection_mode: StatsCollectionMode,
    pub minute_retention_days: u16,
    pub hourly_retention_days: u16,
    pub domain_aggregation_enabled: bool,
    pub domain_retention_days: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CustomRuleKind {
    DomainSuffix,
    DomainExact,
    DomainKeyword,
    IpCidr,
}

/// Ordered manual override. Enabled rules are compiled in vector order and use
/// first-match semantics before subscription exceptions/proxy entries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomRuleDraft {
    pub id: String,
    pub enabled: bool,
    pub action: RouteAction,
    pub kind: CustomRuleKind,
    pub pattern: String,
}

impl Default for StatsPrivacy {
    fn default() -> Self {
        Self {
            collection_mode: StatsCollectionMode::Persisted,
            minute_retention_days: 7,
            hourly_retention_days: 90,
            domain_aggregation_enabled: false,
            domain_retention_days: 7,
        }
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingProfileDraft {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    /// Lower number = higher priority (design plan §5).
    pub priority: u32,
    pub scope: ProfileScope,
    pub app_selectors: Vec<AppSelector>,
    pub runtime_processes: Vec<RuntimeProcessSelector>,
    pub include_children: bool,
    pub egress_kind: Option<EgressKind>,
    pub egress_ref_id: Option<String>,
    pub egress_failure_action: EgressFailureAction,
    pub ssh_pool_options: SshPoolOptions,
    pub rule_source_ids: Vec<String>,
    pub custom_rules: Vec<CustomRuleDraft>,
    pub default_action: RouteAction,
    pub dns_mode: DnsMode,
    pub unknown_domain_action: RouteAction,
    pub udp_policy: UdpPolicy,
    pub local_network_policy: LocalNetworkPolicy,
    pub stats_privacy: StatsPrivacy,
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
            runtime_processes: Vec::new(),
            include_children: true,
            egress_kind: None,
            egress_ref_id: None,
            egress_failure_action: EgressFailureAction::default(),
            ssh_pool_options: SshPoolOptions::default(),
            rule_source_ids: Vec::new(),
            custom_rules: Vec::new(),
            default_action: RouteAction::Direct,
            dns_mode: DnsMode::default(),
            unknown_domain_action: RouteAction::Direct,
            udp_policy: UdpPolicy::default(),
            local_network_policy: LocalNetworkPolicy::default(),
            stats_privacy: StatsPrivacy::default(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileValidationIssue {
    pub profile_id: String,
    pub field: String,
    pub message: String,
}

/// Validate profile invariants that do not require database/session access.
pub fn validate_profile_draft(profile: &RoutingProfileDraft) -> Vec<ProfileValidationIssue> {
    let mut issues = Vec::new();
    let mut issue = |field: &str, message: &str| {
        issues.push(ProfileValidationIssue {
            profile_id: profile.id.clone(),
            field: field.to_string(),
            message: message.to_string(),
        });
    };

    if profile.id.is_empty()
        || profile.id.len() > 128
        || !profile
            .id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        issue(
            "id",
            "profile id must be 1-128 ASCII letters, digits, '-' or '_'",
        );
    }
    if profile.name.trim().is_empty() || profile.name.chars().count() > 128 {
        issue("name", "profile name must be 1-128 characters");
    }

    match profile.scope {
        ProfileScope::Global => {
            if !profile.app_selectors.is_empty() || !profile.runtime_processes.is_empty() {
                issue(
                    "scope",
                    "global profile cannot carry application or runtime selectors",
                );
            }
        }
        ProfileScope::Applications if profile.enabled && profile.app_selectors.is_empty() => {
            issue(
                "appSelectors",
                "enabled application profile requires at least one selector",
            );
        }
        ProfileScope::RuntimeProcesses
            if profile.enabled && profile.runtime_processes.is_empty() =>
        {
            issue(
                "runtimeProcesses",
                "enabled runtime profile requires at least one PID/start-time selector",
            );
        }
        _ => {}
    }

    if profile.scope != ProfileScope::Applications && !profile.app_selectors.is_empty() {
        issue(
            "appSelectors",
            "application selectors are only valid for application scope",
        );
    }
    if profile.scope != ProfileScope::RuntimeProcesses && !profile.runtime_processes.is_empty() {
        issue(
            "runtimeProcesses",
            "runtime selectors are only valid for runtime-process scope",
        );
    }

    for selector in &profile.app_selectors {
        if selector.value.trim().is_empty() || selector.value.len() > 4096 {
            issue(
                "appSelectors",
                "application selector must be non-empty and at most 4096 bytes",
            );
        }
    }
    for selector in &profile.runtime_processes {
        if selector.pid == 0 || selector.process_start_time == 0 {
            issue(
                "runtimeProcesses",
                "runtime selector requires a non-zero PID and process start time",
            );
        }
    }

    if profile.ssh_pool_options.max_control_connections == 0
        || profile.ssh_pool_options.max_control_connections > 16
        || profile.ssh_pool_options.max_channels_per_connection == 0
        || profile.ssh_pool_options.max_channels_per_connection > 4096
        || profile.ssh_pool_options.keepalive_seconds == 0
        || profile.ssh_pool_options.keepalive_seconds > 3600
        || profile.ssh_pool_options.connect_timeout_seconds == 0
        || profile.ssh_pool_options.connect_timeout_seconds > 300
    {
        issue(
            "sshPoolOptions",
            "SSH pool limits or timeouts are outside safe bounds",
        );
    }

    let mut unique_sources = std::collections::HashSet::new();
    for source_id in &profile.rule_source_ids {
        if source_id.is_empty()
            || source_id.len() > 128
            || !source_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            issue(
                "ruleSourceIds",
                "rule source ids must use 1-128 safe ASCII identifier characters",
            );
        }
        if !unique_sources.insert(source_id) {
            issue(
                "ruleSourceIds",
                "rule source ids must be unique and ordered",
            );
        }
    }

    let mut unique_rule_ids = std::collections::HashSet::new();
    for rule in &profile.custom_rules {
        if rule.id.is_empty()
            || rule.id.len() > 128
            || !rule
                .id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            issue(
                "customRules",
                "custom rule ids must use 1-128 safe ASCII identifier characters",
            );
        }
        if !unique_rule_ids.insert(&rule.id) {
            issue("customRules", "custom rule ids must be unique");
        }
        if rule.pattern.trim().is_empty() || rule.pattern.len() > 4096 {
            issue(
                "customRules",
                "custom rule pattern must be non-empty and at most 4096 bytes",
            );
        }
    }

    if profile.stats_privacy.domain_aggregation_enabled
        && profile.stats_privacy.domain_retention_days == 0
    {
        issue(
            "statsPrivacy.domainRetentionDays",
            "domain retention must be non-zero when domain aggregation is enabled",
        );
    }

    issues
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

    for i in 0..enabled.len() {
        for j in (i + 1)..enabled.len() {
            if enabled[i].id == enabled[j].id {
                conflicts.push(ProfileConflict {
                    profile_a: enabled[i].id.clone(),
                    profile_b: enabled[j].id.clone(),
                    reason: "enabled routing profile ids must be unique".into(),
                });
            }
        }
    }

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

    // The same process incarnation at the same priority is ambiguous.
    for i in 0..enabled.len() {
        for j in (i + 1)..enabled.len() {
            let a = enabled[i];
            let b = enabled[j];
            if a.scope != ProfileScope::RuntimeProcesses
                || b.scope != ProfileScope::RuntimeProcesses
                || a.priority != b.priority
            {
                continue;
            }
            if a.runtime_processes
                .iter()
                .any(|left| b.runtime_processes.iter().any(|right| left == right))
            {
                conflicts.push(ProfileConflict {
                    profile_a: a.id.clone(),
                    profile_b: b.id.clone(),
                    reason: format!(
                        "runtime PID/start-time selectors overlap at the same priority {}",
                        a.priority
                    ),
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
            let overlap = a.app_selectors.iter().any(|sa| {
                b.app_selectors
                    .iter()
                    .any(|sb| sa.kind == sb.kind && sa.matches(Some(sb.kind), &sb.value))
            });
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
                app_selectors: vec![AppSelector::executable_path("/usr/bin/curl")],
                ..Default::default()
            },
            RoutingProfileDraft {
                id: "b".into(),
                enabled: true,
                priority: 10,
                scope: ProfileScope::Applications,
                app_selectors: vec![
                    AppSelector::executable_path("/usr/bin/curl"),
                    AppSelector::executable_path("/usr/bin/wget"),
                ],
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
                app_selectors: vec![AppSelector::executable_path("/usr/bin/curl")],
                ..Default::default()
            },
            RoutingProfileDraft {
                id: "b".into(),
                enabled: true,
                priority: 20,
                scope: ProfileScope::Applications,
                app_selectors: vec![AppSelector::executable_path("/usr/bin/curl")],
                ..Default::default()
            },
        ];
        assert!(detect_profile_conflicts(&profiles).is_empty());
    }

    #[test]
    fn runtime_selector_requires_process_start_time() {
        let profile = RoutingProfileDraft {
            id: "runtime".into(),
            name: "Runtime".into(),
            scope: ProfileScope::RuntimeProcesses,
            runtime_processes: vec![RuntimeProcessSelector {
                pid: 42,
                process_start_time: 0,
            }],
            ..Default::default()
        };
        let issues = validate_profile_draft(&profile);
        assert!(issues.iter().any(|issue| issue.field == "runtimeProcesses"));
    }

    #[test]
    fn detects_same_priority_runtime_overlap() {
        let selector = RuntimeProcessSelector {
            pid: 42,
            process_start_time: 123,
        };
        let profiles = vec![
            RoutingProfileDraft {
                id: "runtime-a".into(),
                name: "Runtime A".into(),
                scope: ProfileScope::RuntimeProcesses,
                priority: 10,
                runtime_processes: vec![selector.clone()],
                ..Default::default()
            },
            RoutingProfileDraft {
                id: "runtime-b".into(),
                name: "Runtime B".into(),
                scope: ProfileScope::RuntimeProcesses,
                priority: 10,
                runtime_processes: vec![selector],
                ..Default::default()
            },
        ];
        assert!(
            detect_profile_conflicts(&profiles)
                .iter()
                .any(|conflict| { conflict.reason.contains("PID/start-time") })
        );
    }

    #[test]
    fn stats_privacy_defaults_match_design() {
        let privacy = StatsPrivacy::default();
        assert_eq!(privacy.collection_mode, StatsCollectionMode::Persisted);
        assert_eq!(privacy.minute_retention_days, 7);
        assert_eq!(privacy.hourly_retention_days, 90);
        assert!(!privacy.domain_aggregation_enabled);
        assert_eq!(privacy.domain_retention_days, 7);
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
