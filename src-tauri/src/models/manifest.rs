use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

const BUNDLED_MANIFEST: &str = include_str!("../../resources/models.manifest.json");

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelKind {
    Asr,
    Llm,
    Binary,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelMeta {
    pub kind: ModelKind,
    pub engine: String,
    pub display_name: String,
    pub version: String,
    pub size_mb: u64,
    pub sha256: String,
    pub license: String,
    #[serde(default)]
    pub license_note: Option<String>,
    pub filename: String,
    pub urls: Vec<String>,
    /// Set when the downloaded artifact is an archive (zip/tar) and we should
    /// extract a single member as the final file.
    #[serde(default)]
    pub extract_member: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelManifest {
    pub version: String,
    pub models: BTreeMap<String, ModelMeta>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ModelMetaSummary {
    pub id: String,
    pub kind: ModelKind,
    pub display_name: String,
    pub version: String,
    pub size_mb: u64,
    pub license: String,
    pub license_note: Option<String>,
    pub installed: bool,
}

impl ModelManifest {
    pub fn summaries(&self) -> Vec<ModelMetaSummary> {
        self.models
            .iter()
            .map(|(id, m)| ModelMetaSummary {
                id: id.clone(),
                kind: m.kind,
                display_name: m.display_name.clone(),
                version: m.version.clone(),
                size_mb: m.size_mb,
                license: m.license.clone(),
                license_note: m.license_note.clone(),
                installed: super::store::model_path(id, m).exists(),
            })
            .collect()
    }
}

/// Load the manifest. Tries the on-disk override at
/// `<config>/taomni/models.manifest.json` first; falls back to the bundled
/// canonical copy.
pub fn load_manifest() -> Result<ModelManifest, String> {
    if let Some(cfg) = dirs::config_dir() {
        let override_path = cfg.join("taomni").join("models.manifest.json");
        if let Ok(text) = std::fs::read_to_string(&override_path) {
            return serde_json::from_str(&text).map_err(|e| e.to_string());
        }
    }
    serde_json::from_str(BUNDLED_MANIFEST).map_err(|e| e.to_string())
}
