//! Persisted SocksCap configuration.

mod scope;

mod upstream;

pub mod applications;
mod autopxy_rules;
pub mod gfwlist_rules;
pub mod policy;

mod launch;

mod rules;

mod gfwlist;

mod settings;

pub mod recovery;
pub mod share_link;
pub mod xray_config;

#[cfg(test)]
mod tests;

pub use scope::{Decision, RuleMode, ScopeMode};

pub use upstream::{UpstreamKind, UpstreamParams, UpstreamRef};

pub use applications::{AppSelector, MacosAppIdentity, MacosAppIdentityKind};

pub use launch::{AppLaunchMode, AppLaunchPreparation, AppLaunchShell};

pub use rules::{SocksCapProfile, UserRule, UserRuleAction};

pub use autopxy_rules::parse_autopxy_line;
pub use gfwlist::GfwListSource;

pub use settings::SocksCapConfig;

pub const SLUG: &str = "sockscap";
pub const PARSE_SHARE_LINK: &str = "sockscap/parse-share-link";
pub const TEST_TARGET: &str = "sockscap/test-target";
pub const SETTINGS: &str = "sockscap/settings";
pub const CONFIG_PATH: &str = "plugins/sockscap/data/config.json";
pub const RULES: &str = "sockscap/rules";
pub const RULES_PATH: &str = "plugins/sockscap/data/rules.json";
pub const RUNTIME_INFO: &str = "sockscap/runtime-info";
pub const XRAY: &str = "sockscap/xray";
pub const XRAY_FILE: &str = if cfg!(windows) { "xray.exe" } else { "xray" };
pub const XRAY_RUN_DIR: &str = "plugins/sockscap/runtime/xray";

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct XrayProcesses {
    pub host: u32,
    pub children: Vec<u32>,
}
pub const REDIRECTOR_BRIDGE_ARG: &str = "--sockscap-redirector-bridge";
pub const COMMANDS: [&str; 6] = [
    PARSE_SHARE_LINK,
    TEST_TARGET,
    SETTINGS,
    RULES,
    RUNTIME_INFO,
    XRAY,
];

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(tag = "operation", rename_all = "camelCase", deny_unknown_fields)]
pub enum XrayRequest {
    Ensure {
        profile: String,
        spec: Box<xray_config::ResolvedCoreUpstream>,
    },
    Remove {
        profile: String,
    },
    State,
    Stop,
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeInfo {
    pub host_pid: u32,
    pub host_start_micros: Option<u64>,
    pub redirector_bridge_protocol: Option<u32>,
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(
    tag = "operation",
    content = "config",
    rename_all = "camelCase",
    deny_unknown_fields
)]
pub enum SettingsRequest {
    Read,
    Adopt(Box<SocksCapConfig>),
    Save(Box<SocksCapConfig>),
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(
    tag = "operation",
    content = "cache",
    rename_all = "camelCase",
    deny_unknown_fields
)]
pub enum RulesRequest {
    Read,
    Adopt(gfwlist_rules::RuleCache),
    Replace(gfwlist_rules::RuleCache),
}
