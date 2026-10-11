//! Bounded local cloud artifacts. Unfinished work is never evicted automatically.
use super::{
    control,
    failure::{self, FailureKind},
    model::*,
};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
};

pub const MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const KEEP_MS: i64 = 7 * 24 * 60 * 60 * 1000;
const MAX_COMPLETED_JOBS: usize = 100;
static RESERVED: LazyLock<Mutex<HashMap<PathBuf, u64>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheStatus {
    pub used_bytes: u64,
    pub limit_bytes: u64,
    pub retention_days: u32,
}

pub fn size(path: &Path) -> Result<u64, String> {
    if !path.exists() {
        return Ok(0);
    }
    let mut bytes = 0u64;
    for entry in std::fs::read_dir(path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if kind.is_symlink() {
            return Err("Backup cache contains a symlink; inspect it before continuing".into());
        }
        bytes = bytes.saturating_add(if kind.is_dir() {
            size(&entry.path())?
        } else {
            entry.metadata().map_err(|e| e.to_string())?.len()
        });
    }
    Ok(bytes)
}

pub fn status(root: &Path) -> Result<CacheStatus, String> {
    Ok(CacheStatus {
        used_bytes: size(&root.join("artifacts"))?,
        limit_bytes: MAX_BYTES,
        retention_days: 7,
    })
}

pub struct Reservation {
    root: PathBuf,
    bytes: u64,
}
impl Drop for Reservation {
    fn drop(&mut self) {
        if let Ok(mut values) = RESERVED.lock() {
            if let Some(value) = values.get_mut(&self.root) {
                *value = value.saturating_sub(self.bytes);
            }
        }
    }
}

/// Only files inside our exact managed layout participate in cloud quota.
pub fn reserve(path: &Path, bytes: u64) -> Result<Option<Reservation>, String> {
    let Some(job_dir) = path.parent() else {
        return Ok(None);
    };
    let Some(artifacts) = job_dir.parent() else {
        return Ok(None);
    };
    let Some(root) = artifacts.parent() else {
        return Ok(None);
    };
    if artifacts.file_name().and_then(|s| s.to_str()) != Some("artifacts")
        || root.file_name().and_then(|s| s.to_str()) != Some("backup-control")
    {
        return Ok(None);
    }
    validate_id(
        job_dir
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or_default(),
    )?;
    let mut values = RESERVED.lock().map_err(|e| e.to_string())?;
    let reserved = values.entry(root.to_path_buf()).or_default();
    if size(artifacts)?
        .saturating_add(*reserved)
        .saturating_add(bytes)
        > MAX_BYTES
    {
        return Err(failure::tagged(
            FailureKind::Storage,
            "Cloud backup cache is full (2 GiB); clear completed backups or explicitly discard an unfinished task",
        ));
    }
    *reserved += bytes;
    Ok(Some(Reservation {
        root: root.into(),
        bytes,
    }))
}

/// Update the journal before removing its artifact, so a crash cannot expose a
/// restore action pointing at an already deleted file. IDs, not persisted paths,
/// determine deletion destinations. Symlinks are rejected before recursive delete.
pub fn cleanup(
    root: &Path,
    jobs: &mut [BackupJob],
    active: &HashSet<String>,
    all_completed: bool,
) -> Result<(), String> {
    let mut completed: Vec<_> = jobs
        .iter_mut()
        .filter(|j| {
            ["completed", "discarded"].contains(&j.phase.as_str()) && !active.contains(&j.id)
        })
        .collect();
    completed.sort_by_key(|j| std::cmp::Reverse(j.updated_at.max(j.created_at)));
    let mut latest = HashSet::new();
    for (index, job) in completed.into_iter().enumerate() {
        let preserve_schedule = job.operation == "upload" && latest.insert(job.target_id.clone());
        let expired = now_ms().saturating_sub(job.updated_at.max(job.created_at)) > KEEP_MS;
        if !all_completed && !expired && index < MAX_COMPLETED_JOBS {
            continue;
        }
        validate_id(&job.id)?;
        job.artifact = None;
        job.revision += 1;
        control::write_json(&root.join("jobs").join(format!("{}.json", job.id)), job)?;
        remove_artifacts(root, &job.id)?;
        if !preserve_schedule && (expired || index >= MAX_COMPLETED_JOBS) {
            std::fs::remove_file(root.join("jobs").join(format!("{}.json", job.id)))
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cleanup_keeps_failed_partial_and_active_data_but_removes_completed_payload() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("backup-control");
        let mut jobs = Vec::new();
        for phase in [
            "completed",
            "failed",
            "retry_wait",
            "cancelled",
            "completed",
        ] {
            let id = uuid::Uuid::new_v4().to_string();
            let data = root.join("artifacts").join(&id);
            std::fs::create_dir_all(&data).unwrap();
            std::fs::write(data.join("archive.part"), b"recoverable data").unwrap();
            jobs.push(serde_json::from_value::<BackupJob>(serde_json::json!({"id": id,"revision":1,"targetId": "target", "operation":"upload", "phase":phase,"bytes":16,"total":null,"error":null,"artifact":null,"remote":null,"receipt":null,"createdAt":now_ms()})).unwrap());
        }
        let active = HashSet::from([jobs[4].id.clone()]);
        cleanup(&root, &mut jobs, &active, true).unwrap();
        assert!(!root.join("artifacts").join(&jobs[0].id).exists());
        for job in &jobs[1..] {
            assert!(
                root.join("artifacts")
                    .join(&job.id)
                    .join("archive.part")
                    .exists()
            );
        }
        let path = root
            .join("artifacts")
            .join(&jobs[1].id)
            .join("archive.taobak");
        assert!(reserve(&path, MAX_BYTES).is_err());
        let held = reserve(&path, MAX_BYTES - 1024).unwrap();
        assert!(reserve(&path, 2048).is_err());
        drop(held);
        assert!(reserve(&path, 2048).is_ok());
    }
}

pub fn remove_artifacts(root: &Path, id: &str) -> Result<(), String> {
    validate_id(id)?;
    let parent = root.join("artifacts");
    let path = parent.join(id);
    if !path.exists() {
        return Ok(());
    }
    if std::fs::symlink_metadata(&parent)
        .map_err(|e| e.to_string())?
        .file_type()
        .is_symlink()
        || std::fs::symlink_metadata(&path)
            .map_err(|e| e.to_string())?
            .file_type()
            .is_symlink()
    {
        return Err("Refusing to remove a linked backup cache directory".into());
    }
    // Walking first rejects child links and records a canonical containment check.
    size(&path)?;
    if !path
        .canonicalize()
        .map_err(|e| e.to_string())?
        .starts_with(root.canonicalize().map_err(|e| e.to_string())?)
    {
        return Err("Backup cache path escapes its root".into());
    }
    std::fs::remove_dir_all(path).map_err(|e| e.to_string())
}
