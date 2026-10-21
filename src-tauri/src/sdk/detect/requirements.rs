use super::files::path_string;
use super::model::SdkConfidence;
use super::model::SdkConstraintPolicy;
use super::model::SdkEvidence;
use super::model::SdkRequirement;
use super::model::SdkVersionConstraint;
use crate::sdk::SdkKind;
use crate::sdk::SdkRole;
use regex::Regex;
use std::path::Path;

#[allow(clippy::too_many_arguments)]
pub(super) fn requirement(
    kind: SdkKind,
    role: SdkRole,
    constraint: Option<SdkVersionConstraint>,
    required_location: Option<String>,
    managed_by_build: bool,
    source: &str,
    confidence: SdkConfidence,
    evidence: SdkEvidence,
) -> SdkRequirement {
    SdkRequirement {
        kind,
        role,
        constraint,
        required_location,
        managed_by_build,
        source: source.to_string(),
        confidence,
        evidence: vec![evidence],
    }
}

pub(super) fn constraint(raw: &str, policy: SdkConstraintPolicy) -> SdkVersionConstraint {
    SdkVersionConstraint {
        raw: raw.trim().to_string(),
        policy,
        major: version_major(raw),
    }
}

pub(super) fn version_major(version: &str) -> Option<u32> {
    let pattern = Regex::new(r"[0-9]+").ok()?;
    let mut numbers = pattern
        .find_iter(version)
        .filter_map(|capture| capture.as_str().parse::<u32>().ok());
    let first = numbers.next()?;
    if first == 1 {
        numbers.next().or(Some(first))
    } else {
        Some(first)
    }
}

pub(super) fn evidence(
    path: &Path,
    key: &str,
    value: &str,
    confidence: SdkConfidence,
) -> SdkEvidence {
    SdkEvidence {
        source_path: path_string(path),
        key: key.to_string(),
        value: value.to_string(),
        confidence,
    }
}
