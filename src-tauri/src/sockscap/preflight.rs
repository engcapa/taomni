//! Preflight checks that must pass before the engine transitions to Preparing.
//!
//! Design plan §2.1 / §9: capability/preflight first; fail fast; never install
//! capture rules when the host or configuration is invalid.

use super::capabilities::probe_capabilities;
use super::policy::compile_custom_rules;
use super::types::{
    CapabilitiesReport, EngineState, ProfileConflict, RoutingProfileDraft, SupportLevel,
    detect_profile_conflicts, validate_profile_draft,
};
use serde::{Deserialize, Serialize};

/// One preflight finding.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightFinding {
    pub code: String,
    pub severity: PreflightSeverity,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PreflightSeverity {
    Error,
    Warning,
    Info,
}

/// Aggregate preflight result.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightReport {
    pub ok: bool,
    pub capabilities: CapabilitiesReport,
    pub conflicts: Vec<ProfileConflict>,
    pub findings: Vec<PreflightFinding>,
    /// Suggested next engine state if the caller attempted to start.
    pub suggested_state: EngineState,
}

/// Run preflight against the current host and an optional profile set.
///
/// Phase 0 always fails start (capture plane not implemented) but still returns
/// structured diagnostics so the UI and tests can exercise the gate.
pub fn run_preflight(profiles: &[RoutingProfileDraft]) -> PreflightReport {
    let capabilities = probe_capabilities();
    let conflicts = detect_profile_conflicts(profiles);
    let mut findings = Vec::new();

    if !capabilities.capture_implemented {
        findings.push(PreflightFinding {
            code: "capture_not_implemented".into(),
            severity: PreflightSeverity::Error,
            message: "Capture plane is not implemented in this build (Phase 0 scaffold). Engine cannot enter Active.".into(),
        });
    }

    for item in &capabilities.items {
        if item.required_for_start
            && matches!(
                item.level,
                SupportLevel::Unsupported | SupportLevel::NotImplemented
            )
        {
            findings.push(PreflightFinding {
                code: format!("capability_{}", item.id),
                severity: PreflightSeverity::Error,
                message: format!("{}: {}", item.name, item.detail),
            });
        } else if matches!(item.level, SupportLevel::Degraded) {
            findings.push(PreflightFinding {
                code: format!("capability_{}", item.id),
                severity: PreflightSeverity::Warning,
                message: format!("{}: {}", item.name, item.detail),
            });
        }
    }

    for conflict in &conflicts {
        findings.push(PreflightFinding {
            code: "profile_conflict".into(),
            severity: PreflightSeverity::Error,
            message: format!(
                "profiles {} and {}: {}",
                conflict.profile_a, conflict.profile_b, conflict.reason
            ),
        });
    }

    if profiles.iter().filter(|p| p.enabled).count() == 0 {
        findings.push(PreflightFinding {
            code: "no_enabled_profiles".into(),
            severity: PreflightSeverity::Error,
            message: "No enabled routing profiles; refusing to start.".into(),
        });
    }

    for p in profiles.iter().filter(|p| p.enabled) {
        for issue in validate_profile_draft(p) {
            findings.push(PreflightFinding {
                code: format!("invalid_profile_{}", issue.field),
                severity: PreflightSeverity::Error,
                message: format!("profile '{}': {}", p.id, issue.message),
            });
        }
        for unsupported in compile_custom_rules(&p.id, &p.custom_rules).unsupported {
            findings.push(PreflightFinding {
                code: "invalid_custom_rule".into(),
                severity: PreflightSeverity::Error,
                message: format!(
                    "profile '{}': custom rule '{}' is invalid: {}",
                    p.id, unsupported.original, unsupported.reason
                ),
            });
        }

        // Egress required when default or unknown action is PROXY.
        if matches!(p.default_action, super::types::RouteAction::Proxy)
            || matches!(p.unknown_domain_action, super::types::RouteAction::Proxy)
        {
            if p.egress_kind.is_none()
                || p.egress_ref_id
                    .as_ref()
                    .map(|s| s.trim().is_empty())
                    .unwrap_or(true)
            {
                findings.push(PreflightFinding {
                    code: "missing_egress".into(),
                    severity: PreflightSeverity::Error,
                    message: format!(
                        "profile '{}': PROXY action requires egress_kind and egress_ref_id",
                        p.id
                    ),
                });
            }
        }
    }

    let has_error = findings
        .iter()
        .any(|f| f.severity == PreflightSeverity::Error);
    let ok = !has_error;

    PreflightReport {
        ok,
        capabilities,
        conflicts,
        findings,
        suggested_state: if ok {
            EngineState::Preparing
        } else {
            EngineState::Disabled
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sockscap::types::{
        CustomRuleDraft, CustomRuleKind, EgressKind, ProfileScope, RouteAction, RoutingProfileDraft,
    };

    fn sample_global() -> RoutingProfileDraft {
        RoutingProfileDraft {
            id: "global".into(),
            name: "Global".into(),
            enabled: true,
            scope: ProfileScope::Global,
            egress_kind: Some(EgressKind::ProxySession),
            egress_ref_id: Some("proxy-1".into()),
            default_action: RouteAction::Proxy,
            ..Default::default()
        }
    }

    #[test]
    fn phase0_preflight_always_blocks_start() {
        let report = run_preflight(&[sample_global()]);
        assert!(!report.ok);
        assert!(
            report
                .findings
                .iter()
                .any(|f| f.code == "capture_not_implemented")
        );
        assert_eq!(report.suggested_state, EngineState::Disabled);
    }

    #[test]
    fn empty_profile_list_is_error() {
        let report = run_preflight(&[]);
        assert!(
            report
                .findings
                .iter()
                .any(|f| f.code == "no_enabled_profiles")
        );
    }

    #[test]
    fn proxy_without_egress_is_error() {
        let mut p = sample_global();
        p.egress_kind = None;
        p.egress_ref_id = None;
        let report = run_preflight(&[p]);
        assert!(report.findings.iter().any(|f| f.code == "missing_egress"));
    }

    #[test]
    fn conflict_surfaces_in_findings() {
        let a = sample_global();
        let mut b = sample_global();
        b.id = "global-2".into();
        let report = run_preflight(&[a, b]);
        assert!(report.findings.iter().any(|f| f.code == "profile_conflict"));
        assert!(!report.conflicts.is_empty());
    }

    #[test]
    fn invalid_custom_rule_blocks_preflight() {
        let mut profile = sample_global();
        profile.custom_rules.push(CustomRuleDraft {
            id: "bad".into(),
            enabled: true,
            action: RouteAction::Proxy,
            kind: CustomRuleKind::IpCidr,
            pattern: "10.0.0.0/99".into(),
        });
        let report = run_preflight(&[profile]);
        assert!(
            report
                .findings
                .iter()
                .any(|finding| finding.code == "invalid_custom_rule")
        );
    }
}
