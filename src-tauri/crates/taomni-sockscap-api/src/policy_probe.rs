use serde::{Deserialize, Serialize};

use super::{ActiveProfileEngine, IpNetwork, PolicyEngine, PolicyInput};
use crate::gfwlist_rules::{CompiledRules, RuleMatch};
use crate::{Decision, RuleMode, ScopeMode, SocksCapConfig};

/// A target test has no process identity. Only the first active global
/// profile can match. Send its policy and the compiled list's hit for this
/// hostname without sending credentials or the rest of the rules cache.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TargetRuleProbe {
    host: String,
    port: u16,
    profile: Option<ActiveProfileEngine>,
    bypass_cidrs: Vec<String>,
    gfwlist_hit: Option<RuleMatch>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetTestResult {
    pub host: String,
    pub port: u16,
    pub decision: Decision,
    pub reason: String,
    pub matched_rule: Option<String>,
}

/// Evaluate the target against the signed host's profile-owned settings.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedTargetRequest {
    pub host: String,
    pub port: u16,
    /// The core has checked whether a missing rules file can be imported.
    /// Existing module rules always take priority.
    pub legacy_rules_checked: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SavedTargetReply {
    Adopt {
        settings_missing: bool,
        rules_missing: bool,
    },
    Evaluated {
        result: TargetTestResult,
    },
}

impl TargetRuleProbe {
    pub fn for_config(
        config: &SocksCapConfig,
        rules: Option<&CompiledRules>,
        host: String,
        port: u16,
    ) -> Self {
        let profile = config
            .active_profiles()
            .into_iter()
            .find(|profile| profile.mode == ScopeMode::Global)
            .map(|profile| ActiveProfileEngine {
                id: profile.id.clone(),
                name: profile.name.clone(),
                mode: profile.mode,
                apps: Vec::new(),
                rule_mode: profile.rule_mode,
                user_rules: profile.user_rules.clone(),
                default_action: profile.default_action,
            });
        let gfwlist_hit = profile
            .as_ref()
            .filter(|profile| profile.rule_mode == RuleMode::GfwList)
            .and(rules)
            .map(|rules| rules.match_host(&host));
        Self {
            host,
            port,
            profile,
            bypass_cidrs: config.bypass_cidrs.clone(),
            gfwlist_hit,
        }
    }

    pub fn evaluate(self) -> TargetTestResult {
        let input = PolicyInput {
            ip: self.host.parse().ok(),
            host: Some(self.host.clone()),
            port: self.port,
            process_path: None,
            pid: None,
        };
        let policy = PolicyEngine {
            profiles: self.profile.into_iter().collect(),
            bypass_cidrs: self
                .bypass_cidrs
                .iter()
                .filter_map(|cidr| IpNetwork::parse(cidr))
                .collect(),
            rules: None,
        };
        let trace = policy.decide_with_rule_match(&input, None, |_| self.gfwlist_hit);
        TargetTestResult {
            host: self.host,
            port: self.port,
            decision: trace.decision,
            reason: trace.reason,
            matched_rule: trace.matched_rule,
        }
    }
}
