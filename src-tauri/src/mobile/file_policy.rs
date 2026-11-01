//! The mobile root grants read access only to a project, never a user profile.
use std::path::{Component, Path};
pub fn allowed_root(root: &Path) -> bool {
    if root.parent().is_none() || dirs::home_dir().is_some_and(|home| root == home) {
        return false;
    }
    let protected = [
        dirs::data_dir().map(|p| p.join("com.taomni.app")),
        crate::resolved_config_dir().map(|p| p.join("taomni")),
    ];
    !protected
        .into_iter()
        .flatten()
        .any(|p| root.starts_with(p.canonicalize().unwrap_or(p)))
}
pub fn allowed_path(path: &Path) -> bool {
    !path.components().any(|c| {
        let Component::Normal(name) = c else {
            return false;
        };
        let name = name.to_string_lossy().to_ascii_lowercase();
        matches!(
            name.as_str(),
            ".ssh"
                | ".aws"
                | ".azure"
                | ".gnupg"
                | ".kube"
                | ".config"
                | ".git"
                | "vault.db"
                | "mobile-devices.json"
                | "credentials"
                | "id_rsa"
                | "id_ed25519"
        ) || name == ".env"
            || name.starts_with(".env.")
            || name.ends_with(".pem")
            || name.ends_with(".key")
    })
}
