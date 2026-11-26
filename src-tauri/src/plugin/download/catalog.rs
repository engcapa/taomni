use super::DownloadError;
use serde::{Deserialize, Serialize};

/// The signed `modules.json` envelope published alongside plugin artifacts.
/// Signature verification is performed by the install verifier; this type is
/// intentionally limited to transport/catalog validation so callers can show
/// a catalogue before starting a package download.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModuleCatalog {
    pub core_api_version: String,
    pub sequence: u64,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub legacy_upgrade: Option<std::collections::BTreeSet<String>>,
    pub plugins: std::collections::BTreeMap<String, ModuleCatalogPlugin>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModuleCatalogPlugin {
    pub id: String,
    pub slug: String,
    pub name: String,
    pub version: String,
    pub core_api_version: String,
    #[serde(default)]
    pub kind: Option<taomni_plugin_api::PluginKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub document: Option<taomni_plugin_api::DocumentTypes>,
    #[serde(default)]
    pub permissions: Option<std::collections::BTreeSet<String>>,
    #[serde(default)]
    pub description: String,
    pub platforms: std::collections::BTreeMap<String, ModuleCatalogAsset>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModuleCatalogAsset {
    pub url: String,
    pub signature: String,
    pub sha256: String,
    pub size: u64,
}

impl ModuleCatalog {
    pub fn validate(&self, expected_core_api: &str) -> Result<(), DownloadError> {
        if self.core_api_version != expected_core_api {
            return Err(DownloadError::InvalidCatalog(format!(
                "coreApiVersion {} is incompatible with {expected_core_api}",
                self.core_api_version
            )));
        }
        if self.sequence == 0 {
            return Err(DownloadError::InvalidCatalog(
                "sequence must be positive".into(),
            ));
        }
        if self.legacy_upgrade.as_ref().is_some_and(|ids| {
            ids.iter().any(|id| {
                id == "taomni-plugin-lanchat"
                    || self
                        .plugins
                        .get(id)
                        .is_none_or(|plugin| plugin.description.trim().is_empty())
            })
        }) {
            return Err(DownloadError::InvalidCatalog(
                "legacyUpgrade must reference published modules with descriptions".into(),
            ));
        }
        for (key, plugin) in &self.plugins {
            if let Some(types) = &plugin.document {
                types
                    .validate()
                    .map_err(|reason| DownloadError::InvalidCatalog(reason.into()))?;
            }
            if key != &plugin.id || plugin.id != format!("taomni-plugin-{}", plugin.slug) {
                return Err(DownloadError::InvalidCatalog(format!(
                    "plugin id/slug mismatch for {key}"
                )));
            }
            if plugin.core_api_version != expected_core_api {
                return Err(DownloadError::InvalidCatalog(format!(
                    "plugin {} has incompatible coreApiVersion {}",
                    plugin.slug, plugin.core_api_version
                )));
            }
            if plugin.platforms.is_empty() {
                return Err(DownloadError::InvalidCatalog(format!(
                    "plugin {} has no platform assets",
                    plugin.slug
                )));
            }
            for asset in plugin.platforms.values() {
                let url = reqwest::Url::parse(&asset.url)
                    .map_err(|error| DownloadError::InvalidUrl(error.to_string()))?;
                if !matches!(url.scheme(), "http" | "https") {
                    return Err(DownloadError::InvalidCatalog(format!(
                        "plugin {} has unsupported asset URL scheme {}",
                        plugin.slug,
                        url.scheme()
                    )));
                }
                if asset.signature.trim().is_empty()
                    || asset.sha256.len() != 64
                    || !asset.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
                {
                    return Err(DownloadError::InvalidCatalog(format!(
                        "plugin {} has invalid asset integrity metadata",
                        plugin.slug
                    )));
                }
            }
        }
        Ok(())
    }
}
