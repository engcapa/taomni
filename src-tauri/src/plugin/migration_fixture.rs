//! Test-only journal copy/activation fixture for M0 migration contracts.
//!
//! These operations intentionally lack the signed-package installation gate.
//! Keeping the whole executor behind `cfg(test)` prevents production callers
//! from publishing data-only pseudo versions or changing active pointers.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Component, Path, PathBuf};

use super::{
    MigrationExecutionResult, MigrationExecutor, MigrationJournal, MigrationRunState,
    MigrationSpec, MigrationStepState, source_fingerprint,
};

impl MigrationExecutor {
    /// Read source metadata and hashes without changing the filesystem.
    pub(super) fn preflight(&self, specs: &[MigrationSpec]) -> Result<Vec<String>, String> {
        let mut fingerprints = Vec::with_capacity(specs.len());
        for spec in specs {
            validate_slug(&spec.plugin_slug)?;
            validate_relative_path(&spec.source)?;
            validate_relative_path(&spec.target)?;
            let source = self.source_root.join(&spec.source);
            ensure_within(&self.source_root, &source)?;
            fingerprints.push(source_fingerprint(&source)?);
        }
        Ok(fingerprints)
    }

    pub(super) fn execute(
        &self,
        specs: &[MigrationSpec],
    ) -> Result<MigrationExecutionResult, String> {
        let fingerprints = self.preflight(specs)?;
        let mut journal = MigrationJournal::load(&self.journal_path)?;
        if journal.from_version.is_empty() {
            journal.from_version = self.from_version.clone();
            journal.to_core_api_version = self.core_api_version.clone();
        }
        if journal.from_version != self.from_version
            || journal.to_core_api_version != self.core_api_version
        {
            return Err("migration journal version does not match this executor".into());
        }
        journal.status = MigrationRunState::Staged;
        journal.save_atomic(&self.journal_path)?;

        let mut committed = Vec::new();
        let mut skipped = Vec::new();
        let mut staged_slugs = BTreeSet::new();
        for (spec, fingerprint) in specs.iter().zip(fingerprints.iter()) {
            let target = match self.target_path(spec) {
                Ok(target) => target,
                Err(error) => {
                    journal.status = MigrationRunState::RolledBack;
                    let _ = journal.save_atomic(&self.journal_path);
                    return Err(error);
                }
            };
            if let Some(entry) = journal.entries.iter().find(|entry| entry.item == spec.item) {
                if entry.source_fingerprint == *fingerprint
                    && entry.state == MigrationStepState::Committed
                    && target.exists()
                {
                    skipped.push(spec.item);
                    continue;
                }
            }
            let staging = match self.staging_path(spec) {
                Ok(staging) => staging,
                Err(error) => {
                    journal.status = MigrationRunState::RolledBack;
                    let _ = journal.save_atomic(&self.journal_path);
                    return Err(error);
                }
            };
            if let Err(error) = remove_path_if_exists(&staging) {
                journal.status = MigrationRunState::RolledBack;
                let _ = journal.save_atomic(&self.journal_path);
                return Err(error);
            }
            if let Err(error) = copy_source(&self.source_root.join(&spec.source), &staging) {
                let _ = remove_path_if_exists(&staging);
                journal.status = MigrationRunState::RolledBack;
                let _ = journal.save_atomic(&self.journal_path);
                return Err(error);
            }
            journal.mark(
                spec.item,
                MigrationStepState::Staged,
                fingerprint.clone(),
                target.clone(),
            );
            journal.save_atomic(&self.journal_path)?;
            staged_slugs.insert(spec.plugin_slug.clone());
        }

        let mut previous_pointers = BTreeMap::new();
        for slug in &staged_slugs {
            match self.read_pointer_bytes(slug) {
                Ok(bytes) => {
                    previous_pointers.insert(slug.clone(), bytes);
                }
                Err(error) => {
                    journal.status = MigrationRunState::RolledBack;
                    let _ = journal.save_atomic(&self.journal_path);
                    return Err(error);
                }
            }
        }
        for slug in staged_slugs {
            if let Err(error) = self.activate_slug(&slug) {
                for (previous_slug, bytes) in &previous_pointers {
                    let _ = self.restore_pointer_bytes(previous_slug, bytes.as_deref());
                }
                journal.status = MigrationRunState::RolledBack;
                let _ = journal.save_atomic(&self.journal_path);
                return Err(error);
            }
        }
        for spec in specs {
            if let Some(entry) = journal
                .entries
                .iter_mut()
                .find(|entry| entry.item == spec.item)
            {
                if entry.state == MigrationStepState::Staged {
                    entry.state = MigrationStepState::Committed;
                    committed.push(spec.item);
                }
            }
        }
        journal.status = MigrationRunState::Complete;
        journal.save_atomic(&self.journal_path)?;
        Ok(MigrationExecutionResult {
            status: journal.status,
            committed,
            skipped,
            pending: Vec::new(),
            pending_reason: None,
        })
    }

    fn staging_path(&self, spec: &MigrationSpec) -> Result<PathBuf, String> {
        let plugin_dir = self.plugin_root.join(&spec.plugin_slug);
        reject_symlink(&plugin_dir)?;
        let versions = plugin_dir.join("versions");
        reject_symlink(&versions)?;
        fs::create_dir_all(&versions).map_err(|error| error.to_string())?;
        let path = self
            .plugin_root
            .join(&spec.plugin_slug)
            .join("versions")
            .join(format!(".{}.staging", self.version))
            .join(&spec.target);
        ensure_within(&versions, &path)?;
        Ok(path)
    }

    fn target_path(&self, spec: &MigrationSpec) -> Result<PathBuf, String> {
        let plugin_dir = self.plugin_root.join(&spec.plugin_slug);
        reject_symlink(&plugin_dir)?;
        let versions = plugin_dir.join("versions");
        reject_symlink(&versions)?;
        fs::create_dir_all(&versions).map_err(|error| error.to_string())?;
        let path = self
            .plugin_root
            .join(&spec.plugin_slug)
            .join("versions")
            .join(&self.version)
            .join(&spec.target);
        ensure_within(&versions, &path)?;
        Ok(path)
    }

    fn activate_slug(&self, slug: &str) -> Result<(), String> {
        let versions = self.plugin_root.join(slug).join("versions");
        let staging = versions.join(format!(".{}.staging", self.version));
        let destination = versions.join(&self.version);
        if !destination.exists() {
            fs::create_dir_all(&versions).map_err(|error| error.to_string())?;
            fs::rename(&staging, &destination).map_err(|error| error.to_string())?;
        }
        let pointer_dir = self.plugin_root.join(slug);
        fs::create_dir_all(&pointer_dir).map_err(|error| error.to_string())?;
        let pointer = pointer_dir.join("active.json");
        let temporary = pointer_dir.join(".active.migration.tmp");
        let previous_version = if pointer.exists() {
            serde_json::from_slice::<serde_json::Value>(
                &fs::read(&pointer).map_err(|error| error.to_string())?,
            )
            .ok()
            .and_then(|value| {
                value
                    .get("activeVersion")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
            })
        } else {
            None
        };
        let payload = serde_json::json!({
            "activeVersion": self.version,
            "previousVersion": previous_version,
        });
        fs::write(
            &temporary,
            serde_json::to_vec_pretty(&payload).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        if cfg!(windows) && pointer.exists() {
            fs::remove_file(&pointer).map_err(|error| error.to_string())?;
        }
        fs::rename(temporary, pointer).map_err(|error| error.to_string())
    }

    fn read_pointer_bytes(&self, slug: &str) -> Result<Option<Vec<u8>>, String> {
        let pointer = self.plugin_root.join(slug).join("active.json");
        if pointer.exists() {
            fs::read(pointer)
                .map(Some)
                .map_err(|error| error.to_string())
        } else {
            Ok(None)
        }
    }

    fn restore_pointer_bytes(&self, slug: &str, bytes: Option<&[u8]>) -> Result<(), String> {
        let pointer_dir = self.plugin_root.join(slug);
        let pointer = pointer_dir.join("active.json");
        match bytes {
            Some(bytes) => {
                fs::create_dir_all(&pointer_dir).map_err(|error| error.to_string())?;
                let temporary = pointer_dir.join(".active.migration.rollback.tmp");
                fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
                if cfg!(windows) && pointer.exists() {
                    fs::remove_file(&pointer).map_err(|error| error.to_string())?;
                }
                fs::rename(temporary, pointer).map_err(|error| error.to_string())
            }
            None => {
                if pointer.exists() {
                    fs::remove_file(pointer).map_err(|error| error.to_string())?;
                }
                Ok(())
            }
        }
    }
}

fn validate_slug(slug: &str) -> Result<(), String> {
    if slug.is_empty()
        || slug.starts_with('-')
        || slug.ends_with('-')
        || slug.split('-').any(|part| {
            part.is_empty()
                || !part
                    .chars()
                    .all(|character| character.is_ascii_lowercase() || character.is_ascii_digit())
        })
    {
        return Err(format!("invalid plugin slug: {slug}"));
    }
    Ok(())
}

fn validate_relative_path(path: &Path) -> Result<(), String> {
    if path.as_os_str().is_empty() || path.is_absolute() {
        return Err(format!(
            "migration path must be relative: {}",
            path.display()
        ));
    }
    for component in path.components() {
        if !matches!(component, Component::Normal(_)) {
            return Err(format!(
                "migration path contains unsafe component: {}",
                path.display()
            ));
        }
    }
    Ok(())
}

fn ensure_within(root: &Path, candidate: &Path) -> Result<(), String> {
    let root = root.canonicalize().map_err(|error| error.to_string())?;
    let mut existing = candidate;
    while !existing.exists() {
        existing = existing.parent().ok_or_else(|| {
            format!(
                "migration path has no existing ancestor: {}",
                candidate.display()
            )
        })?;
    }
    let existing = existing.canonicalize().map_err(|error| error.to_string())?;
    if !existing.starts_with(&root) {
        return Err(format!(
            "migration path escapes root: {}",
            candidate.display()
        ));
    }
    Ok(())
}

fn remove_path_if_exists(path: &Path) -> Result<(), String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    if metadata.is_dir() {
        fs::remove_dir_all(path).map_err(|error| error.to_string())
    } else {
        fs::remove_file(path).map_err(|error| error.to_string())
    }
}

fn reject_symlink(path: &Path) -> Result<(), String> {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "migration path cannot be a symlink: {}",
                path.display()
            ));
        }
    }
    Ok(())
}

fn copy_source(source: &Path, destination: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(source).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "migration source cannot be a symlink: {}",
            source.display()
        ));
    }
    if metadata.is_file() {
        let parent = destination
            .parent()
            .ok_or_else(|| "migration destination has no parent".to_string())?;
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        fs::copy(source, destination).map_err(|error| error.to_string())?;
        return Ok(());
    }
    if metadata.is_dir() {
        fs::create_dir_all(destination).map_err(|error| error.to_string())?;
        for entry in fs::read_dir(source).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            copy_source(&entry.path(), &destination.join(entry.file_name()))?;
        }
        return Ok(());
    }
    Err(format!(
        "unsupported migration source: {}",
        source.display()
    ))
}
