//! Snapshot selected owners without starting, enabling or migrating a module.
use super::{
    super::{
        archive_writer::StagedFile, range::BackupScopeFlags, snapshot_context::SnapshotContext,
    },
    contracts::PluginDataSet,
};
use crate::plugin::PluginRegistry;
use std::path::Path;
use taomni_plugin_api::services::{ProfileGeneration, SnapshotJobId};

#[derive(Debug, Default)]
pub(crate) struct PluginSnapshots {
    pub(crate) files: Vec<StagedFile>,
    pub(crate) datasets: Vec<PluginDataSet>,
}

/// The caller holds registry lifecycle and the global Vault snapshot barrier.
/// A locally owned host must use the authenticated live snapshot protocol;
/// failures never fall back to reading its database files.
pub(crate) fn stage(
    registry: &PluginRegistry,
    staging: &Path,
    flags: BackupScopeFlags,
    context: &SnapshotContext,
    job: &SnapshotJobId,
    generation: &ProfileGeneration,
) -> Result<PluginSnapshots, String> {
    let profile = registry.data_profile().map_err(|e| e.to_string())?;
    let mut result = PluginSnapshots::default();
    for slug in super::discover_owners(registry.root())? {
        if !flags.plugins && !(flags.mfa && super::contracts::owner_requires_vault(&slug)) {
            continue;
        }
        context.check()?;
        if registry.owns_snapshot_host(&slug)? {
            return Err(format!(
                "Plugin {slug} is running; its authenticated prepare/snapshot/release protocol is required"
            ));
        }
        let schema = registry
            .get(&slug)
            .filter(|record| record.reason.is_none())
            .map(|record| record.manifest.data_schema_version);
        let snapshot = super::offline::stage(&profile, &slug, schema, staging, context)?;
        if snapshot.inventory.is_empty() {
            continue;
        }
        let dataset = PluginDataSet {
            slug: slug.clone(),
            data_schema_version: snapshot.schema,
            requires_vault: super::contracts::owner_requires_vault(&slug),
            job: job.clone(),
            profile_generation: generation.clone(),
            files: snapshot.inventory,
        };
        dataset.validate()?;
        result.files.extend(snapshot.files);
        result.datasets.push(dataset);
    }
    Ok(result)
}
