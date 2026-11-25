//! Snapshot selected owners without starting, enabling or migrating a module.
use super::{
    super::{
        archive_writer::StagedFile, range::BackupScopeFlags, snapshot_context::SnapshotContext,
    },
    contracts::PluginDataSet,
};
use crate::plugin::PluginRegistry;
use std::{path::Path, time::Instant};
use taomni_plugin_api::services::{ProfileGeneration, SnapshotJobId};

#[derive(Debug, Default)]
pub(crate) struct PluginSnapshots {
    pub(crate) files: Vec<StagedFile>,
    pub(crate) datasets: Vec<PluginDataSet>,
    active: Vec<super::live::LiveSnapshot>,
}

impl PluginSnapshots {
    pub(crate) fn release_hosts(&mut self) -> Result<(), String> {
        let mut failure = None;
        for host in self.active.drain(..) {
            if let Err(error) = host.release() {
                failure.get_or_insert(error);
            }
        }
        failure.map_or(Ok(()), Err)
    }
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
    deadline: Instant,
) -> Result<PluginSnapshots, String> {
    let profile = registry.data_profile().map_err(|e| e.to_string())?;
    let mut result = PluginSnapshots::default();
    for slug in super::discover_owners(registry.root())? {
        if !flags.plugins
            && !(flags.mfa && slug == taomni_plugin_services::MFA_FIXED_KEY_OWNER.slug)
            && !(flags.mail && slug == taomni_mail_api::SLUG)
        {
            continue;
        }
        context.check()?;
        let schema = registry
            .get(&slug)
            .filter(|record| record.reason.is_none())
            .map(|record| record.manifest.data_schema_version);
        let mut snapshot = if registry.owns_snapshot_host(&slug)? {
            let (snapshot, host) = super::live::stage(
                registry,
                &slug,
                schema.ok_or("Running plugin has no trusted data schema")?,
                staging,
                context,
                job,
                generation,
                deadline,
            )?;
            result.active.push(host);
            snapshot
        } else {
            super::offline::stage(&profile, &slug, schema, staging, context)?
        };
        if slug == taomni_mail_api::SLUG && flags.mail {
            retain_selected_mail_sections(&mut snapshot, flags, context)?;
        }
        if snapshot.inventory.is_empty() {
            continue;
        }
        let dataset = PluginDataSet {
            slug: slug.clone(),
            data_schema_version: snapshot.schema,
            requires_vault: super::contracts::dataset_requires_vault(&slug, &snapshot.inventory),
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

fn retain_selected_mail_sections(
    snapshot: &mut super::offline::OfflineSnapshot,
    flags: BackupScopeFlags,
    context: &SnapshotContext,
) -> Result<(), String> {
    let include = |relative: &str| {
        !(!flags.mail_originals
            && relative
                .split('/')
                .next()
                .is_some_and(|folder| folder.ends_with(".mail")))
            && !(!flags.mail_attachments && relative.starts_with("attachments/"))
    };
    snapshot.inventory.retain(|item| include(&item.path));
    snapshot.files.retain(|item| {
        include(
            item.archive_path
                .strip_prefix("plugins/mail/data/")
                .unwrap_or(&item.archive_path),
        )
    });
    if !flags.mail_originals {
        for database in snapshot
            .inventory
            .iter()
            .filter(|file| file.kind == super::contracts::PluginDataFileKind::Sqlite)
        {
            let path = format!("plugins/mail/data/{}", database.path);
            let file = snapshot
                .files
                .iter()
                .find(|file| file.archive_path == path)
                .ok_or("Missing Mail database snapshot")?;
            super::super::mail_snapshot::omit_archive_index(&file.disk_path, context)?;
        }
    }
    Ok(())
}
