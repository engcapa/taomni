use super::model::SdkKind;
use super::model::SdkRegistry;
use super::persistence::strip_verbatim_prefix;
use std::path::PathBuf;

pub(super) fn default_installation_name(kind: SdkKind, version: Option<&str>) -> String {
    version
        .map(|version| format!("{} {version}", kind.label()))
        .unwrap_or_else(|| kind.label().to_string())
}

pub(super) fn require_installation(
    registry: &SdkRegistry,
    id: &str,
    kind: SdkKind,
) -> Result<(), String> {
    match registry
        .installations
        .iter()
        .find(|installation| installation.id == id)
    {
        Some(installation) if installation.kind == kind => Ok(()),
        Some(_) => Err(format!("SDK installation {id} has a different kind")),
        None => Err(format!("SDK installation {id} was not found")),
    }
}

pub(super) fn normalize_scope_path(path: &str) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Workspace scope path is required".to_string());
    }
    let expanded = PathBuf::from(shellexpand::tilde(trimmed).to_string());
    let normalized = std::fs::canonicalize(&expanded).unwrap_or(expanded);
    // `canonicalize` yields a `\\?\` verbatim path on Windows; strip it so
    // stored bindings and the resolution cache key match plain caller paths.
    Ok(strip_verbatim_prefix(&normalized.to_string_lossy()))
}

pub(super) fn paths_equal(left: &str, right: &str) -> bool {
    if cfg!(windows) {
        left.eq_ignore_ascii_case(right)
    } else {
        left == right
    }
}

pub(super) fn sort_registry(registry: &mut SdkRegistry) {
    registry.installations.sort_by(|left, right| {
        left.kind
            .cmp(&right.kind)
            .then_with(|| {
                left.name
                    .to_ascii_lowercase()
                    .cmp(&right.name.to_ascii_lowercase())
            })
            .then_with(|| left.id.cmp(&right.id))
    });
    registry.defaults.sort_by_key(|entry| entry.kind);
    registry.bindings.sort_by(|left, right| {
        left.scope_path
            .cmp(&right.scope_path)
            .then_with(|| left.kind.cmp(&right.kind))
            .then_with(|| format!("{:?}", left.role).cmp(&format!("{:?}", right.role)))
    });
}
