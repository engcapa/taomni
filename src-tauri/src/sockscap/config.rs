//! Persisted SocksCap configuration.

mod scope;

mod upstream;

mod applications;

mod launch;

mod rules;

mod gfwlist;

mod settings;

#[cfg(test)]
mod tests;

pub use scope::{Decision, RuleMode, ScopeMode};

pub use upstream::{UpstreamKind, UpstreamParams, UpstreamRef};

pub use applications::{AppSelector, MacosAppIdentity, MacosAppIdentityKind};

pub use launch::{AppLaunchMode, AppLaunchPreparation, AppLaunchShell};

pub use rules::{SocksCapProfile, UserRule, UserRuleAction};

pub use gfwlist::GfwListSource;

pub use settings::SocksCapConfig;
