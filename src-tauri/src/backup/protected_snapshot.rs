//! Snapshot selected plugin data, the legacy MFA store and Vault in one barrier.
use super::{
    archive_writer::StagedFile, range::BackupScopeFlags, snapshot_context::SnapshotContext,
};
use crate::{mfa::store::MfaStore, plugin::PluginRegistry, vault::Vault};
use std::{
    path::Path,
    time::{Duration, Instant},
};

pub(crate) fn stage_with_plugins(
    registry: &PluginRegistry,
    vault: &Vault,
    mfa: Option<&MfaStore>,
    staging: &Path,
    flags: BackupScopeFlags,
    context: &SnapshotContext,
) -> Result<super::plugins::snapshot::PluginSnapshots, String> {
    if !flags.vault && !flags.mfa && !flags.plugins && !flags.mail {
        return Ok(Default::default());
    }
    context.check()?;
    let deadline = Instant::now() + Duration::from_secs(300);
    let bounded = context.with_deadline(deadline);
    let context = &bounded;
    let pair = tempfile::Builder::new()
        .prefix("protected-")
        .tempdir_in(staging)
        .map_err(|e| format!("create protected snapshot directory: {e}"))?;
    let vault_path = pair.path().join("vault.db");
    let mfa_path = pair.path().join("mfa.db");
    let job = taomni_plugin_api::services::SnapshotJobId::parse(uuid::Uuid::new_v4().to_string())
        .map_err(|e| e.to_string())?;
    let result = registry.with_vault_snapshot(
        Instant::now() + Duration::from_secs(10),
        &|| context.cancel.is_cancelled(),
        || {
            let profile = registry.data_profile().map_err(|e| e.to_string())?;
            let generation = crate::runtime::generation::current(profile.path())?;
            let mut plugins = super::plugins::snapshot::stage(
                registry,
                pair.path(),
                flags,
                context,
                &job,
                &generation,
                deadline,
            )?;
            // All ordinary operations are already drained. Both snapshots
            // retain the same external exclusive lease, including rekey.
            let has_mfa = match mfa {
                Some(mfa) if flags.mfa => mfa.backup_to_with_context(&mfa_path, context)?,
                _ => false,
            };
            context.check()?;
            if flags.vault || plugins.datasets.iter().any(|data| data.requires_vault) {
                vault.backup_to_with_context(&vault_path, context)?;
                plugins.files.push(StagedFile {
                    archive_path: "databases/vault.db".into(),
                    disk_path: vault_path.clone(),
                });
            }
            if has_mfa {
                plugins.files.push(StagedFile {
                    archive_path: "databases/mfa.db".into(),
                    disk_path: mfa_path.clone(),
                });
            }
            context.check()?;
            plugins.release_hosts()?;
            Ok(plugins)
        },
    );
    // Map cancellation during transition/lease acquisition to the existing
    // backup contract too. TempDir removes both files on every failure.
    context.check()?;
    let snapshot = result?;
    pair.keep(); // The archive's staging owner removes successful snapshots.
    Ok(snapshot)
}

#[cfg(test)]
pub(super) fn stage(
    registry: &PluginRegistry,
    vault: &Vault,
    mfa: &MfaStore,
    staging: &Path,
    flags: BackupScopeFlags,
    context: &SnapshotContext,
) -> Result<Vec<StagedFile>, String> {
    stage_with_plugins(registry, vault, Some(mfa), staging, flags, context)
        .map(|snapshot| snapshot.files)
}
