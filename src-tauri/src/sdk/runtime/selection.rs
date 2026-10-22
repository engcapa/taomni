use super::java::java_major;
use super::model::JDTLS_MIN_JAVA_MAJOR;
use super::paths::path_is_within;
use crate::sdk::SdkBindingMode;
use crate::sdk::SdkInstallation;
use crate::sdk::SdkKind;
use crate::sdk::SdkRegistry;
use crate::sdk::SdkRole;
use crate::sdk::SdkStatus;
use crate::sdk::resolve::ResolvedSdkStatus;
use crate::sdk::resolve::WorkspaceSdkResolution;
use std::path::Path;
use std::path::PathBuf;

pub(super) fn nearest_project_scope(
    resolution: &WorkspaceSdkResolution,
    requested_scope: &Path,
) -> Option<PathBuf> {
    resolution
        .analysis
        .profiles
        .iter()
        .filter(|profile| path_is_within(requested_scope, Path::new(&profile.scope_path)))
        .max_by_key(|profile| profile.scope_path.len())
        .map(|profile| PathBuf::from(&profile.scope_path))
}

pub(super) fn selected_installation(
    resolution: &WorkspaceSdkResolution,
    registry: &SdkRegistry,
    requested_scope: &Path,
    kind: SdkKind,
    role: SdkRole,
) -> Option<SdkInstallation> {
    let resolved = resolution
        .resolved
        .iter()
        .filter(|item| {
            item.kind == kind
                && item.role == role
                && item.status == ResolvedSdkStatus::Resolved
                && path_is_within(requested_scope, Path::new(&item.scope_path))
        })
        .max_by_key(|item| item.scope_path.len())
        .and_then(|item| item.installation.clone());
    if resolved.is_some() {
        return resolved;
    }

    // A direct manual binding is meaningful even for a workspace whose source
    // scanner found no matching file yet (for example, an empty new project).
    nearest_manual_binding(registry, requested_scope, kind, role)
        .and_then(|binding| binding.sdk_id.as_deref())
        .and_then(|id| ready_installation(registry, id))
        .cloned()
}

pub(super) fn select_tooling_java(
    registry: &SdkRegistry,
    requested_scope: &Path,
) -> (Option<SdkInstallation>, Option<String>) {
    if let Some(binding) =
        nearest_manual_binding(registry, requested_scope, SdkKind::Java, SdkRole::Tooling)
    {
        let Some(id) = binding.sdk_id.as_deref() else {
            return (
                None,
                Some("The tooling JDK binding has no installation".to_string()),
            );
        };
        let Some(installation) = registry.installations.iter().find(|sdk| sdk.id == id) else {
            return (
                None,
                Some("The tooling JDK binding references a removed installation".to_string()),
            );
        };
        if installation.status != SdkStatus::Ready {
            return (
                None,
                Some(format!(
                    "The tooling JDK {} is not ready: {}",
                    installation.name,
                    installation
                        .last_error
                        .as_deref()
                        .unwrap_or(&installation.location)
                )),
            );
        }
        let major = installation.version.as_deref().and_then(java_major);
        if !major.is_some_and(|major| major >= JDTLS_MIN_JAVA_MAJOR) {
            return (
                None,
                Some(format!(
                    "The tooling JDK {} is {}, but JDT LS requires JDK {}+",
                    installation.name,
                    installation
                        .version
                        .as_deref()
                        .unwrap_or("an unknown version"),
                    JDTLS_MIN_JAVA_MAJOR
                )),
            );
        }
        return (Some(installation.clone()), None);
    }

    let default_java = registry
        .defaults
        .iter()
        .find(|entry| entry.kind == SdkKind::Java)
        .map(|entry| entry.sdk_id.as_str());
    let mut candidates = registry
        .installations
        .iter()
        .filter(|sdk| {
            sdk.kind == SdkKind::Java
                && sdk.status == SdkStatus::Ready
                && sdk
                    .version
                    .as_deref()
                    .and_then(java_major)
                    .is_some_and(|major| major >= JDTLS_MIN_JAVA_MAJOR)
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        let left_default = default_java == Some(left.id.as_str());
        let right_default = default_java == Some(right.id.as_str());
        right_default
            .cmp(&left_default)
            .then_with(|| {
                right
                    .version
                    .as_deref()
                    .and_then(java_major)
                    .cmp(&left.version.as_deref().and_then(java_major))
            })
            .then_with(|| left.name.cmp(&right.name))
    });
    (candidates.first().map(|sdk| (*sdk).clone()), None)
}

pub(super) fn nearest_manual_binding<'a>(
    registry: &'a SdkRegistry,
    requested_scope: &Path,
    kind: SdkKind,
    role: SdkRole,
) -> Option<&'a super::super::WorkspaceSdkBinding> {
    registry
        .bindings
        .iter()
        .filter(|binding| {
            binding.mode == SdkBindingMode::Manual
                && binding.kind == kind
                && binding.role == role
                && path_is_within(requested_scope, Path::new(&binding.scope_path))
        })
        .max_by_key(|binding| binding.scope_path.len())
}

pub(super) fn ready_installation<'a>(
    registry: &'a SdkRegistry,
    id: &str,
) -> Option<&'a SdkInstallation> {
    registry
        .installations
        .iter()
        .find(|installation| installation.id == id && installation.status == SdkStatus::Ready)
}
