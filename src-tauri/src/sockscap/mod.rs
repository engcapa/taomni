//! Sockscap — cross-platform network-traffic routing module.
//!
//! Sockscap is a **new, standalone** capability, distinct from the app's own
//! "Application Proxy" (which only routes Taomni's own HTTP egress). Sockscap
//! runs a single traffic-interception plane, lets the user define multiple
//! `RoutingProfile`s (each binding programs / processes / upstream / rule
//! sources), and decides `PROXY | DIRECT | BLOCK` per new network flow.
//!
//! This module is developed in phases (see
//! `claudedocs/sockscap-cross-platform-design-plan.md`). Phase 1 is the pure,
//! side-effect-free core: data model, AutoProxy/GFWList projection, the
//! immutable rule matcher, the policy decision engine, profile-conflict
//! detection, and the last-good rule-source downloader. Nothing here touches
//! system routing, drivers, or privileged helpers — that arrives in later
//! phases behind the `CaptureAdapter` boundary.

pub mod attribution;
pub mod autoproxy;
pub mod capability;
pub mod capture;
pub mod commands;
pub mod conflict;
pub mod db;
pub mod download;
pub mod egress;
pub mod engine;
pub mod flow;
pub mod helper;
pub mod listener;
pub mod runtime;
pub mod known_hosts;
pub mod matcher;
pub mod model;
pub mod packet;
pub mod platform;
pub mod policy;
pub mod ssh_pool;
pub mod transparent;
pub mod tray;
#[cfg(windows)]
pub mod windivert;
#[cfg(windows)]
pub mod windows_capture;
#[cfg(windows)]
pub mod windows_install;
#[cfg(windows)]
pub mod windows_pid;

use serde::{Deserialize, Serialize};

/// Final routing action for a flow. `Direct` is chosen explicitly by a rule or
/// default action — it is never a silent fallback that masquerades as "proxied"
/// (see plan §16.2/§7).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Action {
    Direct,
    Proxy,
    Block,
}

/// Transport of the captured flow. Sockscap routes TCP through the selected
/// egress; UDP/QUIC only when the upstream can carry it, otherwise the
/// profile's explicit `udp_policy` applies. ICMP and other non-TCP/UDP default
/// to DIRECT (or BLOCK in strict profiles).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Protocol {
    Tcp,
    Udp,
    Icmp,
    Other,
}

/// Where a flow's hostname came from, in priority order. Recorded per decision
/// so the Dashboard can surface the `unknown` ratio honestly rather than
/// pretending every HTTPS flow was matched by domain (plan §4 DomainAttribution,
/// §6.4 DNS/DoH/SNI/ECH).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HostnameSource {
    /// Hostname supplied by the platform capture adapter (most reliable).
    PlatformRemote,
    /// Resolved through a Fake-IP / virtual-DNS mapping we installed.
    FakeIpDns,
    /// Extracted from the TLS ClientHello SNI (no decryption).
    TlsSni,
    /// Extracted from a plaintext HTTP Host header.
    HttpHost,
    /// No hostname available; only the destination IP is known.
    IpRule,
    /// Nothing usable — the `unknown_domain_action` decides the outcome.
    Unknown,
}

impl HostnameSource {
    /// True when no hostname could be attributed and the flow falls under the
    /// profile's `unknown_domain_action`.
    pub fn is_unknown(self) -> bool {
        matches!(self, HostnameSource::Unknown)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            HostnameSource::PlatformRemote => "platform-remote",
            HostnameSource::FakeIpDns => "fake-ip-dns",
            HostnameSource::TlsSni => "tls-sni",
            HostnameSource::HttpHost => "http-host",
            HostnameSource::IpRule => "ip-rule",
            HostnameSource::Unknown => "unknown",
        }
    }
}

/// Errors surfaced by the Sockscap core. Kept `String`-friendly so Tauri
/// commands (added in Phase 3) can return `Result<_, String>` like the rest of
/// the codebase, while internal code can still match on variants.
#[derive(Debug, thiserror::Error)]
pub enum SockscapError {
    #[error("rule source decode failed: {0}")]
    Decode(String),
    #[error("profile conflict: {0}")]
    Conflict(String),
    #[error("download failed: {0}")]
    Download(String),
    #[error("integrity check failed: {0}")]
    Integrity(String),
    #[error("invalid configuration: {0}")]
    Invalid(String),
}

impl From<SockscapError> for String {
    fn from(e: SockscapError) -> String {
        e.to_string()
    }
}
