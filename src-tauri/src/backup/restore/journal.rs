//! Restart-time atomic file application and compatible rollback journal.
use super::super::{manifest::file_sha256, plugins};
use super::paths::{destination, no_symlink_ancestors};
use super::{PENDING_RESTORE_DIR, RESTORE_INTENT_FILE, RestoreIntent};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub(crate) const JOURNAL_FILE: &str = "restore_journal.json";

#[derive(Serialize, Deserialize)]
struct RollbackEntry {
    path: PathBuf,
    saved: PathBuf,
    existed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    saved_sha256: Option<String>,
}
#[derive(Serialize, Deserialize)]
struct RestoreJournal {
    entries: Vec<RollbackEntry>,
    committed: bool,
    #[serde(default)]
    plugin_owners: Vec<String>,
    #[serde(default)]
    profile_generation: Option<taomni_plugin_api::services::ProfileGeneration>,
}

fn replace_file(src: &Path, dst: &Path) -> Result<(), String> {
    no_symlink_ancestors(dst)?;
    let parent = dst.parent().ok_or("Invalid restore destination")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let tmp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    std::fs::copy(src, tmp.path()).map_err(|e| e.to_string())?;
    tmp.as_file().sync_all().map_err(|e| e.to_string())?;
    tmp.persist(dst).map_err(|e| e.error.to_string())?;
    Ok(())
}
fn rollback(app_data: &Path, journal: &RestoreJournal) -> Result<(), String> {
    // Recovery must not destroy the last readable new file before discovering
    // a missing/damaged safety copy. Old journals have no digest; still verify
    // their saved files can be opened before making any recovery changes.
    for entry in journal.entries.iter().filter(|entry| entry.existed) {
        no_symlink_ancestors(&entry.saved)?;
        let saved =
            crate::plugin::data_contract::open_regular(&entry.saved).map_err(|e| e.to_string())?;
        drop(saved);
        if let Some(expected) = &entry.saved_sha256 {
            if file_sha256(&entry.saved).map_err(|e| e.to_string())? != *expected {
                return Err("Restore safety copy changed; recovery files retained".into());
            }
        }
    }
    // Delete every new file before recreating old directory/file shapes.
    for entry in &journal.entries {
        no_symlink_ancestors(&entry.path)?;
        if entry.path.is_file() {
            std::fs::remove_file(&entry.path).map_err(|e| e.to_string())?;
        }
    }
    plugins::restore::prune_empty_data(app_data, &journal.plugin_owners)?;
    for entry in &journal.entries {
        if entry.existed {
            replace_file(&entry.saved, &entry.path)?;
        } else if entry.path.exists() {
            std::fs::remove_file(&entry.path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn lock_mail_restore(
    app_data: &Path,
    paths: impl Iterator<Item = PathBuf>,
) -> Result<Vec<crate::mail::coordination::ProcessLock>, String> {
    use crate::mail::coordination::ProcessLock;
    let paths: std::collections::BTreeSet<_> = paths
        .filter(|path| {
            path.parent() == Some(app_data.join("mail-cache").as_path())
                && path.extension().is_some_and(|ext| ext == "db")
        })
        .collect();
    let mut locks = Vec::new();
    for path in paths {
        locks.push(ProcessLock::access(&path)?);
        locks.push(ProcessLock::try_at(&path, "archive")?.ok_or("Another instance is storing a mailbox being restored; pause its full storage before restarting")?);
    }
    Ok(locks)
}

/// Fail startup rather than opening a partially restored set of databases.
pub fn apply_pending_restore(app_data: &Path) -> Result<(), String> {
    let intent_path = app_data.join(RESTORE_INTENT_FILE);
    let journal_path = app_data.join(JOURNAL_FILE);
    let pending = app_data.join(PENDING_RESTORE_DIR);
    if journal_path.exists() {
        let mut journal: RestoreJournal =
            serde_json::from_slice(&std::fs::read(&journal_path).map_err(|e| e.to_string())?)
                .map_err(|_| "Invalid restore journal")?;
        let _plugin_leases = plugins::restore::owner_leases(app_data, &journal.plugin_owners)?;
        let _mail_locks = lock_mail_restore(
            app_data,
            journal.entries.iter().map(|entry| entry.path.clone()),
        )?;
        journal.profile_generation = Some(crate::runtime::generation::recover_restore(
            app_data,
            journal.profile_generation.as_ref(),
        )?);
        super::super::control::write_json(&journal_path, &journal)?;
        if !journal.committed {
            rollback(app_data, &journal)?;
        }
        if intent_path.exists() {
            std::fs::remove_file(&intent_path).map_err(|e| e.to_string())?;
        }
        std::fs::remove_file(&journal_path).map_err(|e| e.to_string())?;
        if pending.exists() {
            std::fs::remove_dir_all(&pending).map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    if !intent_path.exists() {
        return Ok(());
    }
    let intent: RestoreIntent =
        serde_json::from_slice(&std::fs::read(&intent_path).map_err(|e| e.to_string())?)
            .map_err(|_| "Invalid restore intent")?;
    let plugin_entries = plugins::contracts::validate_manifest(&intent.manifest)?;
    if intent.manifest.app_name != "Taomni" {
        return Err("Unsupported restore intent".into());
    }
    let rdp_pins = super::rdp_pins::stage(app_data, &pending, &intent.manifest)?;
    let has_rdp_projection = rdp_pins.is_some();
    let (_plugin_leases, old_plugin_files) =
        plugins::restore_targets(app_data, &intent.manifest, has_rdp_projection)?;
    plugins::check_restore_dependencies(app_data, &intent.manifest)?;
    let _mail_locks = lock_mail_restore(
        app_data,
        intent
            .manifest
            .files
            .iter()
            .map(|entry| destination(app_data, &intent.manifest, &entry.path))
            .collect::<Result<Vec<_>, _>>()?
            .into_iter(),
    )?;
    let safety = app_data
        .join("backups")
        .join(format!("restore-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&safety).map_err(|e| e.to_string())?;
    let mut journal = RestoreJournal {
        entries: vec![],
        committed: false,
        plugin_owners: plugins::restore::restore_owners(app_data, &intent.manifest)?,
        profile_generation: None,
    };
    if has_rdp_projection {
        journal
            .plugin_owners
            .push(taomni_rdp_client_api::SLUG.into());
    }
    let mut mappings = vec![];
    let mut journal_paths = std::collections::BTreeSet::new();
    for entry in &intent.manifest.files {
        let src = pending.join(&entry.path);
        let dst = destination(app_data, &intent.manifest, &entry.path)?;
        no_symlink_ancestors(&src)?;
        no_symlink_ancestors(&dst)?;
        if file_sha256(&src).map_err(|e| e.to_string())? != entry.sha256
            || std::fs::metadata(&src).map_err(|e| e.to_string())?.len() != entry.size_bytes
        {
            return Err("Staged restore data changed".into());
        }
        let sqlite = plugins::contracts::is_sqlite(&plugin_entries, &entry.path);
        let mut paths = vec![dst.clone()];
        if sqlite {
            for suffix in ["-wal", "-shm", "-journal"] {
                paths.push(PathBuf::from(format!("{}{suffix}", dst.display())));
            }
        }
        if entry.path.starts_with("mail-cache/") && entry.path.ends_with(".db") {
            paths.push(crate::mail::coordination::redirect_path(&dst));
            paths.push(dst.with_extension("generation"));
        }
        journal_paths.extend(paths);
        mappings.push((src, dst, sqlite));
    }
    if let Some(pins) = &rdp_pins {
        let dst = app_data.join(taomni_rdp_client_api::PINS_DATABASE);
        journal_paths.insert(dst.clone());
        mappings.push((pins.database.clone(), dst, true));
    }
    journal_paths.extend(old_plugin_files.iter().cloned());
    for (src, dst) in
        plugins::restore::stage_locators(app_data, &pending, &intent.manifest, has_rdp_projection)?
    {
        journal_paths.insert(dst.clone());
        mappings.push((src, dst, false));
    }
    for path in journal_paths {
        no_symlink_ancestors(&path)?;
        let saved = safety.join(journal.entries.len().to_string());
        let existed = match std::fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_dir() && path.starts_with(app_data.join("plugins")) => {
                false
            }
            Ok(metadata) => {
                crate::plugin::data_contract::require_file(&metadata).map_err(|e| e.to_string())?;
                true
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                ) =>
            {
                false
            }
            Err(error) => return Err(error.to_string()),
        };
        if existed {
            std::fs::copy(&path, &saved)
                .map_err(|e| format!("Cannot save restore rollback copy: {e}"))?;
            std::fs::OpenOptions::new()
                .write(true)
                .open(&saved)
                .and_then(|file| file.sync_all())
                .map_err(|e| e.to_string())?;
        }
        journal.entries.push(RollbackEntry {
            path,
            saved_sha256: if existed {
                Some(file_sha256(&saved).map_err(|e| e.to_string())?)
            } else {
                None
            },
            saved,
            existed,
        });
    }
    journal.profile_generation = Some(crate::runtime::generation::begin_restore(app_data)?);
    super::super::control::write_json(&journal_path, &journal)?;
    let apply = (|| -> Result<(), String> {
        for path in &old_plugin_files {
            no_symlink_ancestors(path)?;
            std::fs::remove_file(path).map_err(|e| e.to_string())?;
        }
        plugins::restore::prune_empty_data(app_data, &journal.plugin_owners)?;
        for (src, dst, sqlite) in &mappings {
            replace_file(src, dst)?;
            if dst.parent() == Some(app_data.join("mail-cache").as_path())
                && dst.extension().is_some_and(|ext| ext == "db")
            {
                let redirect = crate::mail::coordination::redirect_path(dst);
                if redirect.exists() {
                    std::fs::remove_file(redirect).map_err(|e| e.to_string())?;
                }
                super::super::control::write_json(
                    &dst.with_extension("generation"),
                    &uuid::Uuid::new_v4().to_string(),
                )?;
            }
            for suffix in if *sqlite {
                &["-wal", "-shm", "-journal"][..]
            } else {
                &[][..]
            } {
                let aux = PathBuf::from(format!("{}{suffix}", dst.display()));
                if aux.exists() {
                    std::fs::remove_file(aux).map_err(|e| e.to_string())?;
                }
            }
        }
        if mappings
            .iter()
            .any(|(_, dst, _)| *dst == app_data.join("taomni.db"))
        {
            super::super::engine::portable_mail_paths(
                &rusqlite::Connection::open(app_data.join("taomni.db"))
                    .map_err(|e| e.to_string())?,
            )?;
        }
        Ok(())
    })();
    if let Err(error) = apply {
        rollback(app_data, &journal).map_err(|e| {
            format!("Restore failed ({error}); rollback also failed ({e}); recovery files retained")
        })?;
        return Err(format!("Restore failed and was rolled back: {error}"));
    }
    journal.committed = true;
    super::super::control::write_json(&journal_path, &journal)?;
    // Retain the historical safety-copy location for existing users and tooling.
    let legacy = app_data.join("backups/pre_restore_safety_copy");
    std::fs::create_dir_all(&legacy).map_err(|e| e.to_string())?;
    for entry in &journal.entries {
        if entry.existed && entry.path.parent() == Some(app_data) {
            if let Some(name) = entry.path.file_name() {
                std::fs::copy(&entry.saved, legacy.join(name)).map_err(|e| e.to_string())?;
            }
        }
    }
    std::fs::remove_file(&intent_path).map_err(|e| e.to_string())?;
    std::fs::remove_dir_all(&pending).map_err(|e| e.to_string())?;
    std::fs::remove_file(&journal_path).map_err(|e| e.to_string())?;
    Ok(())
}
