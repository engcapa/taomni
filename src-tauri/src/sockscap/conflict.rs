//! Routing-profile conflict detection (plan §5, §16.4-15).
//!
//! Rules:
//!   * At most one *enabled* `Global` profile at a time.
//!   * When two enabled application/runtime profiles share the same `priority`
//!     and their selectors overlap, the set is ambiguous — saving is rejected
//!     with an explanation. Different priorities are fine: the smaller number
//!     wins deterministically.

use super::model::{AppSelector, RoutingProfile, Scope};
use super::SockscapError;

/// A detected conflict, with enough detail for the UI to explain it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Conflict {
    /// More than one enabled global profile.
    MultipleGlobal { profile_ids: Vec<String> },
    /// Two enabled profiles at equal priority whose selectors overlap.
    SamePriorityOverlap {
        a: String,
        b: String,
        priority: i32,
        selectors: Vec<String>,
    },
}

impl Conflict {
    /// A human-readable, UI-ready explanation.
    pub fn explain(&self) -> String {
        match self {
            Conflict::MultipleGlobal { profile_ids } => format!(
                "only one enabled global profile is allowed; found {}: {}",
                profile_ids.len(),
                profile_ids.join(", ")
            ),
            Conflict::SamePriorityOverlap {
                a,
                b,
                priority,
                selectors,
            } => format!(
                "profiles '{a}' and '{b}' share priority {priority} and overlapping selectors: {}",
                selectors.join(", ")
            ),
        }
    }
}

/// A normalized comparison key for a selector. Windows executable paths compare
/// case-insensitively; other selectors compare exactly.
fn selector_key(sel: &AppSelector) -> String {
    match sel {
        AppSelector::WindowsExecutable(p) => format!("win:{}", p.to_ascii_lowercase()),
        AppSelector::MacosSigningIdentity(s) => format!("mac-id:{s}"),
        AppSelector::MacosAppPath(p) => format!("mac-path:{p}"),
        AppSelector::LinuxPath(p) => format!("linux-path:{p}"),
        AppSelector::LinuxCgroup(c) => format!("linux-cgroup:{c}"),
    }
}

/// Overlapping selector keys shared by two profiles.
fn overlapping_selectors(a: &RoutingProfile, b: &RoutingProfile) -> Vec<String> {
    let a_keys: Vec<String> = a.app_selectors.iter().map(selector_key).collect();
    let b_keys: Vec<String> = b.app_selectors.iter().map(selector_key).collect();
    a_keys
        .iter()
        .filter(|k| b_keys.contains(k))
        .cloned()
        .collect()
}

/// Detect every conflict in a set of profiles. An empty result means the set is
/// unambiguous and safe to activate.
pub fn detect_conflicts(profiles: &[RoutingProfile]) -> Vec<Conflict> {
    let mut out = Vec::new();

    // Multiple enabled globals.
    let globals: Vec<&RoutingProfile> = profiles
        .iter()
        .filter(|p| p.enabled && p.scope == Scope::Global)
        .collect();
    if globals.len() > 1 {
        out.push(Conflict::MultipleGlobal {
            profile_ids: globals.iter().map(|p| p.id.clone()).collect(),
        });
    }

    // Same-priority overlapping selectors among enabled non-global profiles.
    let apps: Vec<&RoutingProfile> = profiles
        .iter()
        .filter(|p| p.enabled && p.scope != Scope::Global)
        .collect();
    for i in 0..apps.len() {
        for j in (i + 1)..apps.len() {
            let (a, b) = (apps[i], apps[j]);
            if a.priority != b.priority {
                continue;
            }
            let selectors = overlapping_selectors(a, b);
            if !selectors.is_empty() {
                out.push(Conflict::SamePriorityOverlap {
                    a: a.id.clone(),
                    b: b.id.clone(),
                    priority: a.priority,
                    selectors,
                });
            }
        }
    }

    out
}

/// Validate saving `candidate` against the `existing` set (excluding any record
/// with the same id, since that's the one being replaced). Returns the first
/// conflict as an error so the UI can block the save with a reason
/// (plan §5 "同优先级禁止保存并给出冲突解释").
pub fn validate_upsert(
    existing: &[RoutingProfile],
    candidate: &RoutingProfile,
) -> Result<(), SockscapError> {
    let mut set: Vec<RoutingProfile> = existing
        .iter()
        .filter(|p| p.id != candidate.id)
        .cloned()
        .collect();
    set.push(candidate.clone());
    match detect_conflicts(&set).into_iter().next() {
        Some(conflict) => Err(SockscapError::Conflict(conflict.explain())),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sockscap::Action;
    use crate::sockscap::model::{
        DnsMode, EgressFailureAction, EgressKind, LocalNetworkPolicy, StatsPrivacy, UdpPolicy,
    };

    fn base(id: &str, scope: Scope, priority: i32) -> RoutingProfile {
        RoutingProfile {
            id: id.into(),
            name: id.into(),
            enabled: true,
            priority,
            scope,
            app_selectors: vec![],
            runtime_processes: vec![],
            include_children: true,
            egress_kind: EgressKind::ProxySession,
            egress_ref_id: "proxy-1".into(),
            egress_failure_action: EgressFailureAction::FailOpen,
            rule_source_ids: vec![],
            default_action: Action::Direct,
            dns_mode: DnsMode::SystemCapture,
            unknown_domain_action: Action::Direct,
            udp_policy: UdpPolicy::Block,
            local_network_policy: LocalNetworkPolicy::Direct,
            ssh_pool_options: None,
            stats_privacy: StatsPrivacy::default(),
        }
    }

    #[test]
    fn two_enabled_globals_conflict() {
        let a = base("g1", Scope::Global, 0);
        let b = base("g2", Scope::Global, 0);
        let conflicts = detect_conflicts(&[a, b]);
        assert!(matches!(conflicts[0], Conflict::MultipleGlobal { .. }));
    }

    #[test]
    fn one_global_plus_one_disabled_global_ok() {
        let a = base("g1", Scope::Global, 0);
        let mut b = base("g2", Scope::Global, 0);
        b.enabled = false;
        assert!(detect_conflicts(&[a, b]).is_empty());
    }

    #[test]
    fn same_priority_overlap_rejected() {
        let mut a = base("a", Scope::Applications, 100);
        a.app_selectors = vec![AppSelector::WindowsExecutable("C:/App/Foo.exe".into())];
        let mut b = base("b", Scope::Applications, 100);
        // Same exe, different case → overlap (Windows is case-insensitive).
        b.app_selectors = vec![AppSelector::WindowsExecutable("c:/app/foo.exe".into())];
        let conflicts = detect_conflicts(&[a, b]);
        assert!(matches!(conflicts[0], Conflict::SamePriorityOverlap { .. }));
    }

    #[test]
    fn different_priority_overlap_is_fine() {
        let mut a = base("a", Scope::Applications, 100);
        a.app_selectors = vec![AppSelector::WindowsExecutable("C:/App/Foo.exe".into())];
        let mut b = base("b", Scope::Applications, 200);
        b.app_selectors = vec![AppSelector::WindowsExecutable("C:/App/Foo.exe".into())];
        assert!(detect_conflicts(&[a, b]).is_empty());
    }

    #[test]
    fn validate_upsert_blocks_conflicting_save() {
        let existing = vec![base("g1", Scope::Global, 0)];
        let candidate = base("g2", Scope::Global, 0);
        assert!(validate_upsert(&existing, &candidate).is_err());
        // Replacing the same id is allowed (id excluded from the set).
        let replace = base("g1", Scope::Global, 0);
        assert!(validate_upsert(&existing, &replace).is_ok());
    }
}
