use super::files::canonical_or_original;
use super::files::path_string;
use super::model::KotlinProjectProfile;
use super::model::ProjectBuildSystem;
use super::model::ProjectSdkProfile;
use super::model::SdkRequirement;
use crate::sdk::SdkKind;
use std::collections::HashSet;
use std::path::Path;
use std::path::PathBuf;

pub(super) struct RequirementCandidate {
    pub(super) priority: u16,
    pub(super) requirement: SdkRequirement,
}

pub(super) struct ProfileBuilder {
    pub(super) scope_path: PathBuf,
    pub(super) relative_path: String,
    pub(super) display_name: String,
    pub(super) build_systems: Vec<ProjectBuildSystem>,
    pub(super) languages: HashSet<SdkKind>,
    pub(super) requirements: Vec<RequirementCandidate>,
    pub(super) kotlin: Option<KotlinProjectProfile>,
}

impl ProfileBuilder {
    pub(super) fn new(root: &Path, scope: &Path) -> Self {
        let relative_path = scope
            .strip_prefix(root)
            .ok()
            .filter(|relative| !relative.as_os_str().is_empty())
            .map(path_string)
            .unwrap_or_else(|| ".".to_string());
        let display_name = scope
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .unwrap_or("Workspace")
            .to_string();
        Self {
            scope_path: scope.to_path_buf(),
            relative_path,
            display_name,
            build_systems: Vec::new(),
            languages: HashSet::new(),
            requirements: Vec::new(),
            kotlin: None,
        }
    }

    pub(super) fn add_build_system(&mut self, build_system: ProjectBuildSystem) {
        if !self.build_systems.contains(&build_system) {
            self.build_systems.push(build_system);
        }
    }

    pub(super) fn add_language(&mut self, kind: SdkKind) {
        self.languages.insert(kind);
    }

    pub(super) fn add_requirement(&mut self, priority: u16, mut requirement: SdkRequirement) {
        if let Some(existing) = self.requirements.iter_mut().find(|candidate| {
            candidate.requirement.kind == requirement.kind
                && candidate.requirement.role == requirement.role
                && candidate.requirement.managed_by_build == requirement.managed_by_build
        }) {
            if priority > existing.priority {
                requirement
                    .evidence
                    .extend(existing.requirement.evidence.clone());
                *existing = RequirementCandidate {
                    priority,
                    requirement,
                };
            } else {
                existing.requirement.evidence.extend(requirement.evidence);
            }
            return;
        }
        self.requirements.push(RequirementCandidate {
            priority,
            requirement,
        });
    }

    pub(super) fn finish(mut self) -> ProjectSdkProfile {
        self.build_systems
            .sort_by_key(|system| format!("{system:?}"));
        let mut languages: Vec<_> = self.languages.into_iter().collect();
        languages.sort();
        let mut requirements: Vec<_> = self
            .requirements
            .into_iter()
            .map(|candidate| candidate.requirement)
            .collect();
        requirements.sort_by(|left, right| {
            left.kind
                .cmp(&right.kind)
                .then_with(|| format!("{:?}", left.role).cmp(&format!("{:?}", right.role)))
        });
        ProjectSdkProfile {
            scope_path: path_string(&canonical_or_original(&self.scope_path)),
            relative_path: self.relative_path,
            display_name: self.display_name,
            build_systems: self.build_systems,
            languages,
            requirements,
            kotlin: self.kotlin,
        }
    }
}
