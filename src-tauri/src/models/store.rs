use super::manifest::{ModelKind, ModelMeta};
use std::path::PathBuf;

/// Where downloaded models live: `<cache>/newmob/models/`.
pub fn models_root() -> PathBuf {
    dirs::cache_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("newmob")
        .join("models")
}

/// Where downloaded sidecar binaries live: `<cache>/newmob/binaries/`.
pub fn sidecars_root() -> PathBuf {
    dirs::cache_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("newmob")
        .join("binaries")
}

/// Resolve the full on-disk path for a model id + meta.
pub fn model_path(id: &str, meta: &ModelMeta) -> PathBuf {
    let root = match meta.kind {
        ModelKind::Binary => sidecars_root(),
        _ => models_root(),
    };
    root.join(id).join(&meta.filename)
}
