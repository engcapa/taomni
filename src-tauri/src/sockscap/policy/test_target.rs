//! `test_target` — explain a routing decision for UI diagnostics.
//!
//! Design plan §6.3 / §16.3 #13: return profile, rule text, rule source,
//! hostname_source, and final action. Never claim full GFWList URL equivalence.

use super::gfwlist::{compile_gfwlist_payload, load_last_good_text};
use super::matcher::{FlowMatchInput, PolicyDecision, PolicySnapshot, ProfileMatcher};
use super::rules::compile_custom_rules;
use crate::sockscap::types::{
    AppSelectorKind, HostnameSource, ProfileScope, RouteAction, RoutingProfileDraft,
    detect_profile_conflicts,
};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Request from UI: simulate how a flow would be routed.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestTargetRequest {
    /// Optional application path / identity used to select a profile.
    pub app_identity: Option<String>,
    pub app_selector_kind: Option<AppSelectorKind>,
    /// Runtime selection is valid only when both PID and start time match.
    pub pid: Option<u32>,
    pub process_start_time: Option<u64>,
    pub hostname: Option<String>,
    pub ip: Option<String>,
    pub port: u16,
    pub protocol: String,
    pub hostname_source: Option<HostnameSource>,
    /// When true, treat as hard-bypass (loopback/upstream).
    pub hard_bypass: bool,
    /// Profile drafts currently configured (Phase 1 has no sockscap.db yet).
    pub profiles: Vec<RoutingProfileDraft>,
    /// Optional precompiled matchers keyed by profile id. When absent, only
    /// default_action / unknown_domain_action are applied for the selected profile.
    #[serde(skip)]
    pub matchers: Vec<ProfileMatcher>,
}

/// Full explainability response.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestTargetResult {
    pub selected_profile_id: Option<String>,
    pub selected_profile_name: Option<String>,
    pub selection_reason: String,
    pub decision: Option<PolicyDecision>,
    pub conflicts: Vec<crate::sockscap::types::ProfileConflict>,
    pub notes: Vec<String>,
}

/// Build immutable matchers from each profile's ordered last-good rule sources.
/// Missing or corrupt sources are reported and skipped; they never erase other
/// valid sources or mutate the on-disk snapshot.
pub fn build_cached_profile_matchers(
    app_data: &Path,
    profiles: &[RoutingProfileDraft],
) -> (Vec<ProfileMatcher>, Vec<String>) {
    let mut matchers = Vec::new();
    let mut notes = Vec::new();
    for profile in profiles {
        let custom = compile_custom_rules(&profile.id, &profile.custom_rules);
        for unsupported in &custom.unsupported {
            notes.push(format!(
                "profile '{}': custom rule '{}' is invalid: {}",
                profile.id, unsupported.original, unsupported.reason
            ));
        }
        let mut direct_rules = Vec::new();
        let mut proxy_rules = Vec::new();
        for source_id in &profile.rule_source_ids {
            let Some(text) = load_last_good_text(app_data, source_id) else {
                notes.push(format!(
                    "profile '{}': rule source '{}' has no last-good snapshot",
                    profile.id, source_id
                ));
                continue;
            };
            match compile_gfwlist_payload(source_id, &text) {
                Ok(report) => {
                    direct_rules.extend(report.direct_rules);
                    proxy_rules.extend(report.proxy_rules);
                }
                Err(error) => notes.push(format!(
                    "profile '{}': rule source '{}' is invalid: {error}",
                    profile.id, source_id
                )),
            }
        }
        matchers.push(ProfileMatcher::from_parts(
            profile.id.clone(),
            profile.default_action,
            profile.unknown_domain_action,
            custom.rules,
            &direct_rules,
            &proxy_rules,
        ));
    }
    (matchers, notes)
}

/// Select a profile for the synthetic flow, then evaluate policy.
pub fn test_target(req: TestTargetRequest) -> TestTargetResult {
    let mut notes = Vec::new();
    notes.push(
        "GFWList URL/path semantics are projected to domain/IP matchers; not full browser equivalence."
            .into(),
    );

    let conflicts = detect_profile_conflicts(&req.profiles);
    if !conflicts.is_empty() {
        notes.push("enabled profile conflicts detected; fix before start".into());
    }

    let enabled: Vec<&RoutingProfileDraft> = req.profiles.iter().filter(|p| p.enabled).collect();
    if enabled.is_empty() {
        return TestTargetResult {
            selected_profile_id: None,
            selected_profile_name: None,
            selection_reason: "no enabled profiles".into(),
            decision: None,
            conflicts,
            notes,
        };
    }

    // Pick the most specific runtime/application match by priority. The single
    // global profile is a fallback, otherwise it would shadow every app group.
    let global = enabled
        .iter()
        .find(|p| p.scope == ProfileScope::Global)
        .copied();

    let mut specific_matches: Vec<(&RoutingProfileDraft, u8, String)> = Vec::new();
    if let (Some(pid), Some(start_time)) = (req.pid, req.process_start_time) {
        specific_matches.extend(
            enabled
                .iter()
                .copied()
                .filter(|profile| profile.scope == ProfileScope::RuntimeProcesses)
                .filter(|profile| {
                    profile.runtime_processes.iter().any(|selector| {
                        selector.pid == pid && selector.process_start_time == start_time
                    })
                })
                .map(|profile| {
                    (
                        profile,
                        0,
                        format!("runtime selector matched PID {pid} and start time {start_time}"),
                    )
                }),
        );
    }
    if let Some(app) = req.app_identity.as_deref() {
        specific_matches.extend(
            enabled
                .iter()
                .copied()
                .filter(|profile| profile.scope == ProfileScope::Applications)
                .filter(|profile| {
                    profile
                        .app_selectors
                        .iter()
                        .any(|selector| selector.matches(req.app_selector_kind, app))
                })
                .map(|profile| (profile, 1, format!("application selector matched '{app}'"))),
        );
    }
    specific_matches.sort_by_key(|(profile, specificity, _)| (profile.priority, *specificity));
    let selected = specific_matches
        .into_iter()
        .next()
        .map(|(profile, _, reason)| (profile, reason))
        .or_else(|| global.map(|profile| (profile, "enabled global fallback profile".into())));

    let Some((profile, reason)) = selected else {
        return TestTargetResult {
            selected_profile_id: None,
            selected_profile_name: None,
            selection_reason:
                "no profile matched the given application identity (and no global profile)".into(),
            decision: None,
            conflicts,
            notes,
        };
    };

    let hostname_source = req.hostname_source.unwrap_or_else(|| {
        if req.hostname.is_some() {
            HostnameSource::PlatformRemoteHostname
        } else if req.ip.is_some() {
            HostnameSource::IpOnly
        } else {
            HostnameSource::Unknown
        }
    });

    // Prefer provided matcher; else synthesize default-only matcher from draft.
    let matcher = req
        .matchers
        .iter()
        .find(|m| m.profile_id == profile.id)
        .cloned()
        .unwrap_or_else(|| {
            notes.push(
                "no compiled rule snapshot for profile; evaluating default/unknown actions only"
                    .into(),
            );
            ProfileMatcher::from_parts(
                profile.id.clone(),
                profile.default_action,
                profile.unknown_domain_action,
                vec![],
                &[],
                &[],
            )
        });

    let input = FlowMatchInput {
        profile_id: profile.id.clone(),
        hostname: req.hostname.clone(),
        hostname_source,
        ip: req.ip.clone(),
        port: req.port,
        protocol: req.protocol.clone(),
        hard_bypass: req.hard_bypass,
    };
    let decision = matcher.decide(&input);

    // Snapshot path kept for future multi-profile engines.
    let _snapshot = PolicySnapshot::new(vec![matcher], vec![profile.id.clone()]);

    TestTargetResult {
        selected_profile_id: Some(profile.id.clone()),
        selected_profile_name: Some(profile.name.clone()),
        selection_reason: reason,
        decision: Some(decision),
        conflicts,
        notes,
    }
}

/// Convenience: decide with only default actions (used in tests / stubs).
pub fn decide_defaults(
    profile_id: &str,
    default_action: RouteAction,
    unknown_domain_action: RouteAction,
    input: &FlowMatchInput,
) -> PolicyDecision {
    ProfileMatcher::from_parts(
        profile_id,
        default_action,
        unknown_domain_action,
        vec![],
        &[],
        &[],
    )
    .decide(input)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sockscap::policy::gfwlist::{RuleSourceKind, ingest_payload};
    use crate::sockscap::policy::rules::parse_rule_document;
    use crate::sockscap::types::{
        AppSelector, EgressKind, ProfileScope, RouteAction, RuntimeProcessSelector,
    };

    fn global_profile() -> RoutingProfileDraft {
        RoutingProfileDraft {
            id: "g".into(),
            name: "Global".into(),
            enabled: true,
            scope: ProfileScope::Global,
            egress_kind: Some(EgressKind::ProxySession),
            egress_ref_id: Some("px".into()),
            default_action: RouteAction::Direct,
            unknown_domain_action: RouteAction::Direct,
            ..Default::default()
        }
    }

    #[test]
    fn selects_global_and_explains_proxy_hit() {
        let report = parse_rule_document("gfw", "||google.com\n");
        let matcher = ProfileMatcher::from_parts(
            "g",
            RouteAction::Direct,
            RouteAction::Direct,
            vec![],
            &report.direct_rules,
            &report.proxy_rules,
        );
        let result = test_target(TestTargetRequest {
            app_identity: None,
            app_selector_kind: None,
            pid: None,
            process_start_time: None,
            hostname: Some("www.google.com".into()),
            ip: None,
            port: 443,
            protocol: "tcp".into(),
            hostname_source: Some(HostnameSource::TlsSni),
            hard_bypass: false,
            profiles: vec![global_profile()],
            matchers: vec![matcher],
        });
        assert_eq!(result.selected_profile_id.as_deref(), Some("g"));
        let d = result.decision.unwrap();
        assert_eq!(d.action, RouteAction::Proxy);
        assert!(d.matched_rule_original.is_some());
        assert_eq!(d.hostname_source, HostnameSource::TlsSni);
    }

    #[test]
    fn app_selector_priority() {
        let low = RoutingProfileDraft {
            id: "low".into(),
            name: "Low".into(),
            enabled: true,
            priority: 10,
            scope: ProfileScope::Applications,
            app_selectors: vec![AppSelector::executable_path("/usr/bin/curl")],
            default_action: RouteAction::Proxy,
            egress_kind: Some(EgressKind::ProxySession),
            egress_ref_id: Some("px".into()),
            ..Default::default()
        };
        let high_num = RoutingProfileDraft {
            id: "high".into(),
            name: "High".into(),
            enabled: true,
            priority: 50,
            scope: ProfileScope::Applications,
            app_selectors: vec![AppSelector::executable_path("/usr/bin/curl")],
            default_action: RouteAction::Direct,
            ..Default::default()
        };
        let result = test_target(TestTargetRequest {
            app_identity: Some("/usr/bin/curl".into()),
            app_selector_kind: Some(AppSelectorKind::ExecutablePath),
            pid: Some(1234),
            process_start_time: None,
            hostname: Some("example.com".into()),
            ip: None,
            port: 80,
            protocol: "tcp".into(),
            hostname_source: None,
            hard_bypass: false,
            profiles: vec![high_num, low],
            matchers: vec![],
        });
        assert_eq!(result.selected_profile_id.as_deref(), Some("low"));
    }

    #[test]
    fn application_profile_precedes_global_fallback() {
        let app = RoutingProfileDraft {
            id: "app".into(),
            name: "App".into(),
            enabled: true,
            priority: 20,
            scope: ProfileScope::Applications,
            app_selectors: vec![AppSelector::executable_path("/usr/bin/curl")],
            default_action: RouteAction::Block,
            ..Default::default()
        };
        let result = test_target(TestTargetRequest {
            app_identity: Some("/usr/bin/curl".into()),
            app_selector_kind: Some(AppSelectorKind::ExecutablePath),
            pid: None,
            process_start_time: None,
            hostname: Some("example.com".into()),
            ip: None,
            port: 443,
            protocol: "tcp".into(),
            hostname_source: None,
            hard_bypass: false,
            profiles: vec![global_profile(), app],
            matchers: vec![],
        });
        assert_eq!(result.selected_profile_id.as_deref(), Some("app"));
    }

    #[test]
    fn runtime_pid_requires_matching_start_time() {
        let runtime = RoutingProfileDraft {
            id: "runtime".into(),
            name: "Runtime".into(),
            enabled: true,
            scope: ProfileScope::RuntimeProcesses,
            runtime_processes: vec![RuntimeProcessSelector {
                pid: 42,
                process_start_time: 777,
            }],
            default_action: RouteAction::Block,
            ..Default::default()
        };
        let request = |process_start_time| TestTargetRequest {
            app_identity: None,
            app_selector_kind: None,
            pid: Some(42),
            process_start_time,
            hostname: Some("example.com".into()),
            ip: None,
            port: 443,
            protocol: "tcp".into(),
            hostname_source: None,
            hard_bypass: false,
            profiles: vec![global_profile(), runtime.clone()],
            matchers: vec![],
        };
        assert_eq!(
            test_target(request(Some(777)))
                .selected_profile_id
                .as_deref(),
            Some("runtime")
        );
        assert_eq!(
            test_target(request(Some(778)))
                .selected_profile_id
                .as_deref(),
            Some("g")
        );
        assert_eq!(
            test_target(request(None)).selected_profile_id.as_deref(),
            Some("g")
        );
    }

    #[test]
    fn cached_rule_sources_feed_explainable_target_decision() {
        let directory = tempfile::tempdir().unwrap();
        let outcome = ingest_payload(
            directory.path(),
            "local-rules",
            RuleSourceKind::LocalFile,
            None,
            "||cached.example\n",
        );
        assert!(outcome.ok, "{:?}", outcome.error);

        let mut profile = global_profile();
        profile.rule_source_ids = vec!["local-rules".into()];
        let (matchers, notes) = build_cached_profile_matchers(directory.path(), &[profile.clone()]);
        assert!(notes.is_empty(), "{notes:?}");
        let result = test_target(TestTargetRequest {
            app_identity: None,
            app_selector_kind: None,
            pid: None,
            process_start_time: None,
            hostname: Some("www.cached.example".into()),
            ip: None,
            port: 443,
            protocol: "tcp".into(),
            hostname_source: Some(HostnameSource::TlsSni),
            hard_bypass: false,
            profiles: vec![profile],
            matchers,
        });
        let decision = result.decision.unwrap();
        assert_eq!(decision.action, RouteAction::Proxy);
        assert_eq!(
            decision.matched_rule_source_id.as_deref(),
            Some("local-rules")
        );
        assert_eq!(
            decision.matched_rule_original.as_deref(),
            Some("||cached.example")
        );
    }

    #[test]
    fn manual_block_override_precedes_cached_subscription() {
        use crate::sockscap::types::{CustomRuleDraft, CustomRuleKind};

        let directory = tempfile::tempdir().unwrap();
        assert!(
            ingest_payload(
                directory.path(),
                "subscription",
                RuleSourceKind::LocalFile,
                None,
                "||blocked.example\n",
            )
            .ok
        );
        let mut profile = global_profile();
        profile.rule_source_ids = vec!["subscription".into()];
        profile.custom_rules = vec![CustomRuleDraft {
            id: "block".into(),
            enabled: true,
            action: RouteAction::Block,
            kind: CustomRuleKind::DomainSuffix,
            pattern: "blocked.example".into(),
        }];
        let (matchers, notes) = build_cached_profile_matchers(directory.path(), &[profile.clone()]);
        assert!(notes.is_empty(), "{notes:?}");
        let result = test_target(TestTargetRequest {
            app_identity: None,
            app_selector_kind: None,
            pid: None,
            process_start_time: None,
            hostname: Some("www.blocked.example".into()),
            ip: None,
            port: 443,
            protocol: "tcp".into(),
            hostname_source: Some(HostnameSource::TlsSni),
            hard_bypass: false,
            profiles: vec![profile],
            matchers,
        });
        let decision = result.decision.unwrap();
        assert_eq!(decision.action, RouteAction::Block);
        assert_eq!(decision.matched_stage, "user_override");
        assert_eq!(
            decision.matched_rule_source_id.as_deref(),
            Some("user-overrides:g")
        );
    }
}
