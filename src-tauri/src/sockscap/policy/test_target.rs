//! `test_target` — explain a routing decision for UI diagnostics.
//!
//! Design plan §6.3 / §16.3 #13: return profile, rule text, rule source,
//! hostname_source, and final action. Never claim full GFWList URL equivalence.

use super::matcher::{FlowMatchInput, PolicyDecision, PolicySnapshot, ProfileMatcher};
use crate::sockscap::types::{
    detect_profile_conflicts, HostnameSource, ProfileScope, RouteAction, RoutingProfileDraft,
};
use serde::{Deserialize, Serialize};

/// Request from UI: simulate how a flow would be routed.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestTargetRequest {
    /// Optional application path / identity used to select a profile.
    pub app_identity: Option<String>,
    /// Optional runtime PID (informational in Phase 1; selection uses identity).
    pub pid: Option<u32>,
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

    let enabled: Vec<&RoutingProfileDraft> =
        req.profiles.iter().filter(|p| p.enabled).collect();
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

    // Selection: global if present (only one allowed), else highest priority
    // (lowest number) application profile matching app_identity, else none.
    let global = enabled
        .iter()
        .find(|p| p.scope == ProfileScope::Global)
        .copied();

    let selected = if let Some(g) = global {
        Some((g, "enabled global profile".to_string()))
    } else if let Some(app) = req.app_identity.as_deref() {
        let mut matches: Vec<&RoutingProfileDraft> = enabled
            .iter()
            .copied()
            .filter(|p| {
                p.scope == ProfileScope::Applications
                    && p.app_selectors.iter().any(|s| s == app)
            })
            .collect();
        matches.sort_by_key(|p| p.priority);
        matches
            .first()
            .map(|p| (*p, format!("application selector matched '{app}'")))
    } else {
        None
    };

    let Some((profile, reason)) = selected else {
        return TestTargetResult {
            selected_profile_id: None,
            selected_profile_name: None,
            selection_reason: "no profile matched the given application identity (and no global profile)"
                .into(),
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
    use crate::sockscap::policy::rules::parse_rule_document;
    use crate::sockscap::types::{EgressKind, ProfileScope, RouteAction};

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
            pid: None,
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
            app_selectors: vec!["/usr/bin/curl".into()],
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
            app_selectors: vec!["/usr/bin/curl".into()],
            default_action: RouteAction::Direct,
            ..Default::default()
        };
        let result = test_target(TestTargetRequest {
            app_identity: Some("/usr/bin/curl".into()),
            pid: Some(1234),
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
}
