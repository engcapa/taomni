//! Snapshot the current in-core MFA store and Vault as one protected pair.
//! Plugin data/retained-data snapshots are added by the TASK-025-F protocol.
use super::{
    archive_writer::StagedFile, range::BackupScopeFlags, snapshot_context::SnapshotContext,
};
use crate::{mfa::store::MfaStore, plugin::PluginRegistry, vault::Vault};
use std::{
    path::Path,
    time::{Duration, Instant},
};

pub(super) fn stage(
    registry: &PluginRegistry,
    vault: &Vault,
    mfa: &MfaStore,
    staging: &Path,
    flags: BackupScopeFlags,
    context: &SnapshotContext,
) -> Result<Vec<StagedFile>, String> {
    if !flags.vault && !flags.mfa {
        return Ok(Vec::new());
    }
    context.check()?;
    let pair = tempfile::Builder::new()
        .prefix("protected-")
        .tempdir_in(staging)
        .map_err(|e| format!("create protected snapshot directory: {e}"))?;
    let vault_path = pair.path().join("vault.db");
    let mfa_path = pair.path().join("mfa.db");
    let result = registry.with_vault_snapshot(
        Instant::now() + Duration::from_secs(10),
        &|| context.cancel.is_cancelled(),
        || {
            // All ordinary operations are already drained. Both snapshots
            // retain the same external exclusive lease, including rekey.
            let has_mfa = flags.mfa && mfa.backup_to_with_context(&mfa_path, context)?;
            context.check()?;
            vault.backup_to_with_context(&vault_path, context)?;
            context.check()?;
            Ok(has_mfa)
        },
    );
    // Map cancellation during transition/lease acquisition to the existing
    // backup contract too. TempDir removes both files on every failure.
    context.check()?;
    let has_mfa = result?;
    let mut files = vec![StagedFile {
        archive_path: "databases/vault.db".into(),
        disk_path: vault_path,
    }];
    if has_mfa {
        files.push(StagedFile {
            archive_path: "databases/mfa.db".into(),
            disk_path: mfa_path,
        });
    }
    pair.keep(); // The archive's staging owner removes successful snapshots.
    Ok(files)
}
