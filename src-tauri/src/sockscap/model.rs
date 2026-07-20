//! Sockscap configuration data model (plan §5, §6, §16).
//!
//! These are the persisted, user-facing config records. They are pure data —
//! validation, conflict detection and compilation into matchers live in
//! sibling modules. Field names mirror the plan's RoutingProfile table so the
//! design doc and the code stay legible against each other.

use serde::{Deserialize, Serialize};

use super::Action;

/// The kind of flows a profile applies to (plan §3.1 routing scope).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Scope {
    /// All security-eligible new flows on the system. At most one enabled
    /// global profile at a time (plan §5 constraint, §16.4-15).
    Global,
    /// A set of executables / app identities.
    Applications,
    /// One or more running PIDs, taking over their *future* connections.
    RuntimeProcesses,
}

/// A program/app identity selector. The concrete matchable field differs per
/// platform (plan §5 app_selectors, §8 capability matrix). We keep every
/// variant serializable so a profile authored on one OS round-trips on another
/// (it simply won't match there).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case", tag = "kind", content = "value")]
pub enum AppSelector {
    /// Windows executable path (case-insensitive compare at match time).
    WindowsExecutable(String),
    /// macOS code-signing identity (Team ID / bundle id).
    MacosSigningIdentity(String),
    /// macOS application bundle path.
    MacosAppPath(String),
    /// Linux executable path.
    LinuxPath(String),
    /// Linux cgroup selector (v2 path fragment).
    LinuxCgroup(String),
}

/// A running-process selector. Persists `process_start_time` alongside the PID
/// so a recycled PID cannot silently capture a different process (plan §5,
/// §16.4-17). "Remember this process" is converted by the UI into an
/// [`AppSelector`] rather than persisting an ephemeral PID.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProcessSelector {
    pub pid: u32,
    /// Platform process start time (opaque token) captured when the user picked
    /// the PID. Compared at attach time to defeat PID reuse.
    pub process_start_time: String,
    /// Human label shown in the UI (e.g. the exe name at selection time).
    #[serde(default)]
    pub label: Option<String>,
}

/// Which egress family a profile uses. `DIRECT` is *not* an egress kind — it is
/// selected by rule action, never disguised as an upstream (plan §5).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EgressKind {
    /// References an existing `SessionType::Proxy` (SOCKS5 / HTTP CONNECT).
    ProxySession,
    /// References an existing `SessionType::SSH`; each TCP flow opens a
    /// `direct-tcpip` channel on a shared control connection.
    SshJump,
}

/// What to do when the selected egress is unavailable (plan §5, §16.2-4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EgressFailureAction {
    /// Fall back to DIRECT (global default).
    FailOpen,
    /// Block the flow instead of leaking it.
    FailClosed,
}

/// DNS handling strategy for a profile (plan §5 dns_mode, §6.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DnsMode {
    /// Intercept/observe the system resolver.
    SystemCapture,
    /// Hand out Fake-IPs and map them back to hostnames.
    VirtualDns,
    /// Resolve exclusively through the upstream (e.g. SOCKS5 remote / SSH).
    StrictProxy,
}

/// UDP handling for a profile (plan §7, §16.2-6/9).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UdpPolicy {
    /// Proxy UDP when the upstream supports it (SOCKS5 UDP ASSOCIATE), else
    /// enforce the profile policy strictly — never silently downgrade.
    ProxyIfSupported,
    /// Always send UDP direct (surface potential leak in the UI).
    Direct,
    /// Block UDP/QUIC to push apps back to TCP.
    Block,
}

/// Handling of LAN / private / link-local destinations (plan §5, §16.2-7).
/// loopback, Taomni/helper and upstream endpoints are *always* hard-bypassed
/// regardless of this setting.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LocalNetworkPolicy {
    /// LAN/private/link-local go DIRECT (default).
    Direct,
    /// Apply the profile's rules to LAN traffic too.
    ByRule,
    /// Block LAN traffic.
    Block,
}

/// A routing profile — the central config record (plan §5).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingProfile {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    /// Lower number = higher priority when app selectors overlap (plan §5).
    pub priority: i32,
    pub scope: Scope,
    #[serde(default)]
    pub app_selectors: Vec<AppSelector>,
    #[serde(default)]
    pub runtime_processes: Vec<RuntimeProcessSelector>,
    /// Whether child processes of the selected program are included (plan
    /// §16.4-16 — default true for app scope).
    #[serde(default = "default_true")]
    pub include_children: bool,
    pub egress_kind: EgressKind,
    /// References `SessionType::Proxy` or `SessionType::SSH` in the main
    /// `taomni.db`. `sockscap.db` only stores this reference, never secrets
    /// (plan §4.3, §10).
    pub egress_ref_id: String,
    #[serde(default = "default_fail_open")]
    pub egress_failure_action: EgressFailureAction,
    /// Ordered list of rule-source ids consulted for this profile.
    #[serde(default)]
    pub rule_source_ids: Vec<String>,
    pub default_action: Action,
    pub dns_mode: DnsMode,
    pub unknown_domain_action: Action,
    pub udp_policy: UdpPolicy,
    pub local_network_policy: LocalNetworkPolicy,
    /// SSH-only pool tuning; never holds secrets (plan §5 ssh_pool_options).
    #[serde(default)]
    pub ssh_pool_options: Option<SshPoolOptions>,
    /// Whether domain aggregates are retained, and for how long (plan §10).
    #[serde(default)]
    pub stats_privacy: StatsPrivacy,
}

/// SSH control-connection tuning (plan §4.3, §5). No secrets — the SSH session
/// and its credentials stay in `taomni.db` + Vault.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshPoolOptions {
    #[serde(default = "default_max_control")]
    pub max_control_connections: u32,
    #[serde(default = "default_max_channels")]
    pub max_channels_per_control: u32,
    #[serde(default = "default_keepalive_secs")]
    pub keepalive_secs: u32,
    #[serde(default = "default_connect_timeout_secs")]
    pub connect_timeout_secs: u32,
}

impl Default for SshPoolOptions {
    fn default() -> Self {
        Self {
            max_control_connections: default_max_control(),
            max_channels_per_control: default_max_channels(),
            keepalive_secs: default_keepalive_secs(),
            connect_timeout_secs: default_connect_timeout_secs(),
        }
    }
}

/// Per-profile statistics privacy (plan §10, §16.6-24/25).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsPrivacy {
    /// Whether to keep per-domain aggregates at all (default off).
    #[serde(default)]
    pub retain_domain_aggregates: bool,
    /// Retention for domain aggregates when enabled (default 7 days).
    #[serde(default = "default_domain_retention_days")]
    pub domain_retention_days: u32,
    /// "This run only, never persisted" — keep stats in memory only.
    #[serde(default)]
    pub ephemeral_only: bool,
}

impl Default for StatsPrivacy {
    fn default() -> Self {
        Self {
            retain_domain_aggregates: false,
            domain_retention_days: default_domain_retention_days(),
            ephemeral_only: false,
        }
    }
}

fn default_true() -> bool {
    true
}
fn default_fail_open() -> EgressFailureAction {
    EgressFailureAction::FailOpen
}
fn default_max_control() -> u32 {
    2
}
fn default_max_channels() -> u32 {
    64
}
fn default_keepalive_secs() -> u32 {
    30
}
fn default_connect_timeout_secs() -> u32 {
    15
}
fn default_domain_retention_days() -> u32 {
    7
}

/// The kind/format of a rule source (plan §6).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RuleSourceKind {
    /// Built-in GFWList (`gfwlist-official`), AutoProxy base64 format.
    GfwlistOfficial,
    /// User-supplied subscription URL (AutoProxy / GFWList format).
    CustomUrl,
    /// A locally imported AutoProxy/GFWList file.
    LocalAutoProxy,
    /// A locally imported plain domain list (one host per line).
    LocalDomainList,
}

/// A rule source definition. The built-in GFWList source ships with a health
/// set of official mirrors; a Bitbucket URL the user imports is kept only as a
/// provenance record and rotated to a healthy mirror on 404 (plan §6.1,
/// §16.3-10).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleSource {
    pub id: String,
    pub name: String,
    pub kind: RuleSourceKind,
    /// Ordered candidate URLs. The first healthy one is used; failures rotate
    /// to the next while keeping the last-good compiled snapshot.
    #[serde(default)]
    pub urls: Vec<String>,
    /// For local imports: the on-disk path the content was read from.
    #[serde(default)]
    pub local_path: Option<String>,
    pub enabled: bool,
    /// Minimum refresh interval in seconds; honored above the list's own
    /// Expires but never below (plan §6.2 — min 6h).
    #[serde(default = "default_min_refresh_secs")]
    pub min_refresh_secs: u64,
}

fn default_min_refresh_secs() -> u64 {
    6 * 60 * 60
}

/// Direction of a rule action expressed as an AutoProxy-style rule (plan §6.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RuleDirection {
    /// Route through the profile's upstream.
    Proxy,
    /// Force direct (AutoProxy `@@` exception, or an explicit user DIRECT).
    Direct,
    /// Drop the flow.
    Block,
}

/// A user-authored override rule (plan §6.3 decision order step 2). These are
/// evaluated first-match-wins, ahead of any subscription (plan §16.3-11).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomRule {
    pub id: String,
    /// Ordering within the profile's override list (ascending = evaluated
    /// first).
    pub order: i32,
    pub pattern: RulePattern,
    pub action: RuleDirection,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

/// A matchable pattern for a custom rule.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case", tag = "type", content = "value")]
pub enum RulePattern {
    /// Matches this host and all subdomains.
    DomainSuffix(String),
    /// Matches exactly this host.
    DomainExact(String),
    /// A single IP address.
    Ip(String),
    /// A CIDR block, e.g. `10.0.0.0/8`.
    Cidr(String),
}

