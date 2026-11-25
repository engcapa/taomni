//! Bind a user's catalog selection to native platform, paths and package trust.
//! Renderer input contains no URL, path, signature or verification flag.

use std::path::Path;

use serde::{Deserialize, Serialize};

use super::{
    ModuleManifest, PluginError, current_platform,
    download::{DownloadRequest, ModuleCatalog, ProxyRoute},
    release_state::ReleasePlan,
    signed_catalog::read_cached_catalog,
    verify::{VerifiedCatalog, VerifiedPackage},
};

pub const OFFICIAL_CATALOG_URL: &str =
    "https://github.com/engcapa/taomni/releases/latest/download/modules.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogSelection {
    pub plugin_id: String,
    pub version: String,
    pub sha256: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceCatalog {
    pub catalog: ModuleCatalog,
    pub platform: String,
    pub release: ReleasePlan,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallReview {
    pub manifest: ModuleManifest,
    pub data_directory: String,
    pub download_id: String,
}

pub fn download_plan(
    plugin_root: &Path,
    selection: &CatalogSelection,
    installed_version: Option<&str>,
) -> Result<DownloadRequest, PluginError> {
    let verified = read_cached_catalog(plugin_root)?;
    let plan = plan_from_catalog(plugin_root, selection, &verified, current_platform())?;
    if let Some(installed_version) = installed_version {
        let plugin = &verified.catalog().plugins[&selection.plugin_id];
        let pointer =
            super::install::ModuleInstaller::new(plugin_root).active_pointer(&plugin.slug)?;
        super::installation::check_update(&pointer, installed_version, &plugin.version)?;
    }
    Ok(plan)
}

fn plan_from_catalog(
    plugin_root: &Path,
    selection: &CatalogSelection,
    verified: &VerifiedCatalog,
    platform: &str,
) -> Result<DownloadRequest, PluginError> {
    let plugin = verified
        .catalog()
        .plugins
        .get(&selection.plugin_id)
        .ok_or_else(|| {
            invalid("Selected module is absent from the verified catalog; refresh it")
        })?;
    let asset = plugin
        .platforms
        .get(platform)
        .ok_or_else(|| invalid("Selected module is unavailable on this platform"))?;
    if selection.version != plugin.version || !selection.sha256.eq_ignore_ascii_case(&asset.sha256)
    {
        return Err(invalid(
            "Module changed since review; refresh the catalog and review it again",
        ));
    }
    let digest = asset.sha256.to_ascii_lowercase();
    let root = plugin_root.join(".downloads");
    // The verified catalog enforces slug/hash syntax. The same immutable
    // artifact always selects the same task and safe resumable files.
    Ok(DownloadRequest {
        id: format!("module-{}-{digest}", plugin.slug),
        url: asset.url.clone(),
        partial_path: root.join(format!("{digest}.part")),
        completed_path: root.join(format!("{digest}.taomni-plugin")),
        expected_total: Some(asset.size),
        expected_sha256: Some(digest),
        proxy: ProxyRoute::NoProxy,
    })
}

pub fn prepare_install(
    plugin_root: &Path,
    selection: &CatalogSelection,
) -> Result<(VerifiedPackage, InstallReview), PluginError> {
    // Read and verify one catalog snapshot. A concurrent refresh cannot mix
    // the download path from one version with the signature from another.
    let catalog = read_cached_catalog(plugin_root)?;
    let plan = plan_from_catalog(plugin_root, selection, &catalog, current_platform())?;
    let package = VerifiedPackage::from_catalog(
        &plan.completed_path,
        &catalog,
        &selection.plugin_id,
        current_platform(),
    )?;
    let manifest = package.manifest().clone();
    let review = InstallReview {
        data_directory: plugin_root
            .join(&manifest.slug)
            .join("data")
            .to_string_lossy()
            .into_owned(),
        manifest,
        download_id: plan.id,
    };
    Ok((package, review))
}

fn invalid(message: &str) -> PluginError {
    PluginError::InvalidManifest(message.into())
}

#[cfg(test)]
#[path = "marketplace_tests.rs"]
mod tests;
