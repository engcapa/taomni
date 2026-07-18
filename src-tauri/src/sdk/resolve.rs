use super::detect::{
    SdkConstraintPolicy, SdkRequirement, SdkVersionConstraint, WorkspaceSdkAnalysis,
};
use super::{
    SdkBindingMode, SdkInstallation, SdkKind, SdkOrigin, SdkRegistry, SdkStatus,
    WorkspaceSdkBinding,
};
use regex::Regex;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ResolvedSdkSource {
    ManualBinding,
    ProjectLocation,
    AutoMatch,
    Default,
    BuildManaged,
    Unresolved,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ResolvedSdkStatus {
    Resolved,
    Managed,
    Missing,
    Invalid,
    Incompatible,
    Unresolved,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedSdk {
    pub scope_path: String,
    pub kind: SdkKind,
    pub role: super::SdkRole,
    pub requirement: SdkRequirement,
    pub installation: Option<SdkInstallation>,
    pub source: ResolvedSdkSource,
    pub status: ResolvedSdkStatus,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSdkResolution {
    pub analysis: WorkspaceSdkAnalysis,
    pub resolved: Vec<ResolvedSdk>,
}

pub async fn resolve_workspace(
    analysis: WorkspaceSdkAnalysis,
    registry: &SdkRegistry,
) -> WorkspaceSdkResolution {
    let mut resolved = Vec::new();
    for profile in &analysis.profiles {
        for requirement in &profile.requirements {
            resolved.push(resolve_requirement(&profile.scope_path, requirement, registry).await);
        }
    }
    resolved.sort_by(|left, right| {
        left.scope_path
            .cmp(&right.scope_path)
            .then_with(|| left.kind.cmp(&right.kind))
            .then_with(|| format!("{:?}", left.role).cmp(&format!("{:?}", right.role)))
    });
    WorkspaceSdkResolution { analysis, resolved }
}

async fn resolve_requirement(
    scope_path: &str,
    requirement: &SdkRequirement,
    registry: &SdkRegistry,
) -> ResolvedSdk {
    if requirement.managed_by_build {
        return result(
            scope_path,
            requirement,
            None,
            ResolvedSdkSource::BuildManaged,
            ResolvedSdkStatus::Managed,
            format!(
                "{} is downloaded and managed by the build tool",
                requirement.source
            ),
        );
    }

    if let Some(binding) = nearest_manual_binding(scope_path, requirement, &registry.bindings) {
        let installation = binding
            .sdk_id
            .as_deref()
            .and_then(|id| {
                registry
                    .installations
                    .iter()
                    .find(|installation| installation.id == id)
            })
            .cloned();
        return match installation {
            Some(installation) => {
                let status = installation_resolution_status(&installation, requirement);
                let reason = match status {
                    ResolvedSdkStatus::Resolved => {
                        format!("Selected by manual binding at {}", binding.scope_path)
                    }
                    ResolvedSdkStatus::Incompatible => format!(
                        "Manual binding selects {}, which does not satisfy {}",
                        installation.name,
                        display_constraint(requirement)
                    ),
                    ResolvedSdkStatus::Missing => {
                        format!(
                            "Manual binding selects a missing SDK: {}",
                            installation.location
                        )
                    }
                    ResolvedSdkStatus::Invalid => format!(
                        "Manual binding selects an invalid SDK: {}",
                        installation
                            .last_error
                            .as_deref()
                            .unwrap_or(&installation.location)
                    ),
                    _ => "Manual binding could not be resolved".to_string(),
                };
                result(
                    scope_path,
                    requirement,
                    Some(installation),
                    ResolvedSdkSource::ManualBinding,
                    status,
                    reason,
                )
            }
            None => result(
                scope_path,
                requirement,
                None,
                ResolvedSdkSource::ManualBinding,
                ResolvedSdkStatus::Missing,
                "Manual binding references an SDK that is no longer registered".to_string(),
            ),
        };
    }

    if let Some(location) = requirement.required_location.as_deref() {
        let normalized = normalize_required_location(scope_path, location);
        if let Some(installation) = registry.installations.iter().find(|installation| {
            installation.kind == requirement.kind
                && paths_equal(&installation.location, &normalized)
        }) {
            let status = installation_resolution_status(installation, requirement);
            return result(
                scope_path,
                requirement,
                Some(installation.clone()),
                ResolvedSdkSource::ProjectLocation,
                status,
                format!("Project configuration selects {}", normalized),
            );
        }
        let probe = super::probe::probe_sdk(requirement.kind, &normalized).await;
        let status = match probe.status {
            SdkStatus::Ready
                if requirement_matches_probe(requirement, probe.version.as_deref()) =>
            {
                ResolvedSdkStatus::Resolved
            }
            SdkStatus::Ready => ResolvedSdkStatus::Incompatible,
            SdkStatus::Missing => ResolvedSdkStatus::Missing,
            SdkStatus::Invalid => ResolvedSdkStatus::Invalid,
        };
        let installation = SdkInstallation {
            id: transient_id(requirement.kind, &probe.location),
            kind: requirement.kind,
            name: format!("Project {}", kind_label(requirement.kind)),
            location: probe.location,
            executables: probe.executables,
            version: probe.version,
            vendor: probe.vendor,
            architecture: probe.architecture,
            origin: SdkOrigin::Discovered,
            status: probe.status,
            last_error: probe.error,
            last_probed_at: Some(chrono::Utc::now().to_rfc3339()),
        };
        return result(
            scope_path,
            requirement,
            Some(installation),
            ResolvedSdkSource::ProjectLocation,
            status,
            format!("Project configuration selects {}", normalized),
        );
    }

    let default_id = registry
        .defaults
        .iter()
        .find(|entry| entry.kind == requirement.kind)
        .map(|entry| entry.sdk_id.as_str());
    let mut candidates: Vec<_> = registry
        .installations
        .iter()
        .filter(|installation| {
            installation.kind == requirement.kind
                && installation.status == SdkStatus::Ready
                && requirement_matches_installation(requirement, installation)
        })
        .collect();
    candidates.sort_by(|left, right| {
        let left_score = installation_score(requirement, left, default_id);
        let right_score = installation_score(requirement, right, default_id);
        right_score
            .cmp(&left_score)
            .then_with(|| compare_versions(right.version.as_deref(), left.version.as_deref()))
            .then_with(|| left.name.cmp(&right.name))
    });
    if let Some(installation) = candidates.first() {
        let is_default = default_id == Some(installation.id.as_str());
        return result(
            scope_path,
            requirement,
            Some((*installation).clone()),
            if is_default {
                ResolvedSdkSource::Default
            } else {
                ResolvedSdkSource::AutoMatch
            },
            ResolvedSdkStatus::Resolved,
            if is_default {
                format!("Using the compatible default {}", installation.name)
            } else {
                format!(
                    "Automatically matched {} to {}",
                    installation.name,
                    display_constraint(requirement)
                )
            },
        );
    }

    let incompatible = registry
        .installations
        .iter()
        .filter(|installation| {
            installation.kind == requirement.kind && installation.status == SdkStatus::Ready
        })
        .count();
    result(
        scope_path,
        requirement,
        None,
        ResolvedSdkSource::Unresolved,
        ResolvedSdkStatus::Unresolved,
        if incompatible > 0 {
            format!(
                "No registered {} satisfies {}",
                kind_label(requirement.kind),
                display_constraint(requirement)
            )
        } else {
            format!(
                "No ready {} installation is registered",
                kind_label(requirement.kind)
            )
        },
    )
}

fn result(
    scope_path: &str,
    requirement: &SdkRequirement,
    installation: Option<SdkInstallation>,
    source: ResolvedSdkSource,
    status: ResolvedSdkStatus,
    reason: String,
) -> ResolvedSdk {
    ResolvedSdk {
        scope_path: scope_path.to_string(),
        kind: requirement.kind,
        role: requirement.role,
        requirement: requirement.clone(),
        installation,
        source,
        status,
        reason,
    }
}

fn nearest_manual_binding<'a>(
    scope_path: &str,
    requirement: &SdkRequirement,
    bindings: &'a [WorkspaceSdkBinding],
) -> Option<&'a WorkspaceSdkBinding> {
    bindings
        .iter()
        .filter(|binding| {
            binding.mode == SdkBindingMode::Manual
                && binding.kind == requirement.kind
                && binding.role == requirement.role
                && path_is_within(scope_path, &binding.scope_path)
        })
        .max_by_key(|binding| binding.scope_path.len())
}

fn installation_resolution_status(
    installation: &SdkInstallation,
    requirement: &SdkRequirement,
) -> ResolvedSdkStatus {
    match installation.status {
        SdkStatus::Missing => ResolvedSdkStatus::Missing,
        SdkStatus::Invalid => ResolvedSdkStatus::Invalid,
        SdkStatus::Ready if requirement_matches_installation(requirement, installation) => {
            ResolvedSdkStatus::Resolved
        }
        SdkStatus::Ready => ResolvedSdkStatus::Incompatible,
    }
}

fn requirement_matches_installation(
    requirement: &SdkRequirement,
    installation: &SdkInstallation,
) -> bool {
    requirement_matches_probe(requirement, installation.version.as_deref())
}

fn requirement_matches_probe(requirement: &SdkRequirement, version: Option<&str>) -> bool {
    match requirement.constraint.as_ref() {
        None => true,
        Some(constraint) => version
            .map(|version| version_matches(version, constraint))
            .unwrap_or(false),
    }
}

fn version_matches(version: &str, constraint: &SdkVersionConstraint) -> bool {
    let Some(actual) = numeric_version(version) else {
        return constraint.policy == SdkConstraintPolicy::Any;
    };
    match constraint.policy {
        SdkConstraintPolicy::Any => true,
        SdkConstraintPolicy::Exact => numeric_version(&constraint.raw)
            .map(|required| starts_with_version(&actual, &required))
            .unwrap_or(false),
        SdkConstraintPolicy::ExactMajor => constraint
            .major
            .map(|major| java_normalized_major(&actual) == major)
            .unwrap_or(false),
        SdkConstraintPolicy::PreferredMajor => constraint
            .major
            .map(|major| java_normalized_major(&actual) >= major)
            .unwrap_or(true),
        SdkConstraintPolicy::Minimum => numeric_version(&constraint.raw)
            .map(|required| compare_numeric(&actual, &required) != Ordering::Less)
            .unwrap_or(false),
        SdkConstraintPolicy::Range => range_matches(&actual, &constraint.raw),
    }
}

fn installation_score(
    requirement: &SdkRequirement,
    installation: &SdkInstallation,
    default_id: Option<&str>,
) -> i32 {
    let default_bonus = if default_id == Some(installation.id.as_str()) {
        25
    } else {
        0
    };
    let Some(constraint) = requirement.constraint.as_ref() else {
        return 100 + default_bonus;
    };
    let Some(actual) = installation.version.as_deref().and_then(numeric_version) else {
        return default_bonus;
    };
    let base = match constraint.policy {
        SdkConstraintPolicy::Any => 100,
        SdkConstraintPolicy::Exact | SdkConstraintPolicy::ExactMajor => 1_000,
        SdkConstraintPolicy::PreferredMajor => {
            let required = constraint.major.unwrap_or(0);
            let actual = java_normalized_major(&actual);
            if actual == required {
                950
            } else {
                700_i32.saturating_sub((actual.saturating_sub(required) * 10) as i32)
            }
        }
        SdkConstraintPolicy::Minimum | SdkConstraintPolicy::Range => 800,
    };
    base + default_bonus
}

fn numeric_version(value: &str) -> Option<Vec<u32>> {
    let regex = Regex::new(r"[0-9]+").ok()?;
    let values: Vec<_> = regex
        .find_iter(value)
        .filter_map(|capture| capture.as_str().parse::<u32>().ok())
        .collect();
    (!values.is_empty()).then_some(values)
}

fn java_normalized_major(version: &[u32]) -> u32 {
    if version.first() == Some(&1) {
        version.get(1).copied().unwrap_or(1)
    } else {
        version.first().copied().unwrap_or(0)
    }
}

fn starts_with_version(actual: &[u32], required: &[u32]) -> bool {
    actual.len() >= required.len()
        && actual
            .iter()
            .zip(required.iter())
            .all(|(actual, required)| actual == required)
}

fn compare_numeric(left: &[u32], right: &[u32]) -> Ordering {
    let length = left.len().max(right.len());
    for index in 0..length {
        let ordering = left
            .get(index)
            .copied()
            .unwrap_or_default()
            .cmp(&right.get(index).copied().unwrap_or_default());
        if ordering != Ordering::Equal {
            return ordering;
        }
    }
    Ordering::Equal
}

fn compare_versions(left: Option<&str>, right: Option<&str>) -> Ordering {
    match (
        left.and_then(numeric_version),
        right.and_then(numeric_version),
    ) {
        (Some(left), Some(right)) => compare_numeric(&left, &right),
        (Some(_), None) => Ordering::Greater,
        (None, Some(_)) => Ordering::Less,
        (None, None) => Ordering::Equal,
    }
}

fn range_matches(actual: &[u32], raw: &str) -> bool {
    let normalized = raw.replace(' ', "");
    if let Some(required) = normalized.strip_prefix('^').and_then(numeric_version) {
        let upper = vec![required.first().copied().unwrap_or(0) + 1, 0, 0];
        return compare_numeric(actual, &required) != Ordering::Less
            && compare_numeric(actual, &upper) == Ordering::Less;
    }
    if let Some(required) = normalized.strip_prefix('~').and_then(numeric_version) {
        let upper = vec![
            required.first().copied().unwrap_or(0),
            required.get(1).copied().unwrap_or(0) + 1,
            0,
        ];
        return compare_numeric(actual, &required) != Ordering::Less
            && compare_numeric(actual, &upper) == Ordering::Less;
    }
    normalized
        .split(',')
        .filter(|part| !part.is_empty())
        .all(|part| {
            let (operator, value) = if let Some(value) = part.strip_prefix(">=") {
                (">=", value)
            } else if let Some(value) = part.strip_prefix("<=") {
                ("<=", value)
            } else if let Some(value) = part.strip_prefix("==") {
                ("==", value)
            } else if let Some(value) = part.strip_prefix('>') {
                (">", value)
            } else if let Some(value) = part.strip_prefix('<') {
                ("<", value)
            } else if let Some(value) = part.strip_prefix('=') {
                ("==", value)
            } else {
                ("==", part)
            };
            let Some(required) = numeric_version(value) else {
                return true;
            };
            let ordering = compare_numeric(actual, &required);
            match operator {
                ">=" => ordering != Ordering::Less,
                "<=" => ordering != Ordering::Greater,
                ">" => ordering == Ordering::Greater,
                "<" => ordering == Ordering::Less,
                _ => starts_with_version(actual, &required),
            }
        })
}

fn normalize_required_location(scope_path: &str, location: &str) -> String {
    let expanded = PathBuf::from(shellexpand::tilde(location.trim()).to_string());
    let absolute = if expanded.is_absolute() {
        expanded
    } else {
        Path::new(scope_path).join(expanded)
    };
    std::fs::canonicalize(&absolute)
        .unwrap_or(absolute)
        .to_string_lossy()
        .into_owned()
}

fn path_is_within(path: &str, ancestor: &str) -> bool {
    if paths_equal(path, ancestor) {
        return true;
    }
    let mut ancestor = ancestor.replace('\\', "/");
    let mut path = path.replace('\\', "/");
    if cfg!(windows) {
        ancestor.make_ascii_lowercase();
        path.make_ascii_lowercase();
    }
    path.strip_prefix(&ancestor)
        .is_some_and(|suffix| suffix.starts_with('/'))
}

fn paths_equal(left: &str, right: &str) -> bool {
    let left = left.replace('\\', "/").trim_end_matches('/').to_string();
    let right = right.replace('\\', "/").trim_end_matches('/').to_string();
    if cfg!(windows) {
        left.eq_ignore_ascii_case(&right)
    } else {
        left == right
    }
}

fn transient_id(kind: SdkKind, location: &str) -> String {
    let digest = Sha256::digest(format!("{kind:?}:{location}").as_bytes());
    format!("project-{}", &hex::encode(digest)[..16])
}

fn display_constraint(requirement: &SdkRequirement) -> String {
    requirement
        .constraint
        .as_ref()
        .map(|constraint| constraint.raw.clone())
        .unwrap_or_else(|| format!("any {} version", kind_label(requirement.kind)))
}

fn kind_label(kind: SdkKind) -> &'static str {
    match kind {
        SdkKind::Java => "JDK",
        SdkKind::Kotlin => "Kotlin SDK",
        SdkKind::Scala => "Scala SDK",
        SdkKind::Python => "Python interpreter",
    }
}

#[cfg(test)]
mod tests {
    use super::super::{SdkDefault, SdkRole, WorkspaceSdkBinding};
    use super::*;
    use crate::sdk::detect::{SdkConfidence, SdkEvidence};
    use std::collections::BTreeMap;

    fn installation(id: &str, kind: SdkKind, version: &str) -> SdkInstallation {
        SdkInstallation {
            id: id.to_string(),
            kind,
            name: format!("{kind:?} {version}"),
            location: format!("/sdk/{id}"),
            executables: BTreeMap::new(),
            version: Some(version.to_string()),
            vendor: None,
            architecture: None,
            origin: SdkOrigin::Manual,
            status: SdkStatus::Ready,
            last_error: None,
            last_probed_at: None,
        }
    }

    fn requirement(kind: SdkKind, policy: SdkConstraintPolicy, raw: &str) -> SdkRequirement {
        SdkRequirement {
            kind,
            role: SdkRole::Project,
            constraint: Some(SdkVersionConstraint {
                raw: raw.to_string(),
                policy,
                major: numeric_version(raw).map(|version| java_normalized_major(&version)),
            }),
            required_location: None,
            managed_by_build: false,
            source: "test".to_string(),
            confidence: SdkConfidence::High,
            evidence: vec![SdkEvidence {
                source_path: "test".to_string(),
                key: "version".to_string(),
                value: raw.to_string(),
                confidence: SdkConfidence::High,
            }],
        }
    }

    #[tokio::test]
    async fn exact_toolchain_prefers_matching_major_over_newer_default() {
        let requirement = requirement(SdkKind::Java, SdkConstraintPolicy::ExactMajor, "17");
        let registry = SdkRegistry {
            installations: vec![
                installation("jdk-17", SdkKind::Java, "17.0.12"),
                installation("jdk-21", SdkKind::Java, "21.0.7"),
            ],
            defaults: vec![SdkDefault {
                kind: SdkKind::Java,
                sdk_id: "jdk-21".to_string(),
            }],
            ..SdkRegistry::default()
        };

        let resolved = resolve_requirement("/repo", &requirement, &registry).await;
        assert_eq!(resolved.installation.unwrap().id, "jdk-17");
        assert_eq!(resolved.source, ResolvedSdkSource::AutoMatch);
    }

    #[tokio::test]
    async fn manual_binding_wins_and_reports_incompatibility() {
        let requirement = requirement(SdkKind::Java, SdkConstraintPolicy::ExactMajor, "17");
        let registry = SdkRegistry {
            installations: vec![
                installation("jdk-17", SdkKind::Java, "17.0.12"),
                installation("jdk-21", SdkKind::Java, "21.0.7"),
            ],
            bindings: vec![WorkspaceSdkBinding {
                scope_path: "/repo".to_string(),
                kind: SdkKind::Java,
                role: SdkRole::Project,
                mode: SdkBindingMode::Manual,
                sdk_id: Some("jdk-21".to_string()),
                updated_at: "now".to_string(),
            }],
            ..SdkRegistry::default()
        };

        let resolved = resolve_requirement("/repo/module", &requirement, &registry).await;
        assert_eq!(resolved.installation.unwrap().id, "jdk-21");
        assert_eq!(resolved.source, ResolvedSdkSource::ManualBinding);
        assert_eq!(resolved.status, ResolvedSdkStatus::Incompatible);
    }

    #[tokio::test]
    async fn build_managed_compiler_does_not_require_local_installation() {
        let mut requirement = requirement(SdkKind::Kotlin, SdkConstraintPolicy::Exact, "2.2.0");
        requirement.role = SdkRole::Compiler;
        requirement.managed_by_build = true;
        let resolved = resolve_requirement("/repo", &requirement, &SdkRegistry::default()).await;
        assert_eq!(resolved.status, ResolvedSdkStatus::Managed);
        assert_eq!(resolved.source, ResolvedSdkSource::BuildManaged);
        assert!(resolved.installation.is_none());
    }

    #[test]
    fn matches_python_ranges_and_java_legacy_versions() {
        let python = SdkVersionConstraint {
            raw: ">=3.11,<3.14".to_string(),
            policy: SdkConstraintPolicy::Range,
            major: Some(3),
        };
        assert!(version_matches("3.12.4", &python));
        assert!(!version_matches("3.14.0", &python));

        let java = SdkVersionConstraint {
            raw: "8".to_string(),
            policy: SdkConstraintPolicy::ExactMajor,
            major: Some(8),
        };
        assert!(version_matches("1.8.0_402", &java));
        assert!(!version_matches("11.0.25", &java));
    }
}
