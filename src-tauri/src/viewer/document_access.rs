use crate::plugin::{LifecycleState, PluginRegistry};
use std::path::{Path, PathBuf};

pub(crate) fn approved_path(
    registry: &PluginRegistry,
    protected: &[&Path],
    path: &str,
    slug: &str,
    version: &str,
) -> Result<PathBuf, String> {
    let path = super::paths::absolute(path)?;
    for root in protected {
        match root.canonicalize() {
            Ok(root) if path.starts_with(&root) => {
                return Err("permission: Application profile files are private".into());
            }
            Ok(_) => (),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => return Err(super::paths::io_error("resolve profile directory", error)),
        }
    }
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !registry.get(slug).is_some_and(|record| {
        record.state == LifecycleState::Enabled
            && record.manifest.version == version
            && record.manifest.permissions.contains("fs.readUserFile")
            && record
                .manifest
                .document
                .is_some_and(|doc| doc.extensions.iter().any(|ext| ext == &extension))
    }) {
        return Err("permission: Module is not enabled for this document".into());
    }
    Ok(path)
}
