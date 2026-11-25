//! Durable transfer descriptions contain no proxy credentials. Recovery reads
//! actual file lengths and verifies completed content before exposing success.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{DownloadError, DownloadPhase, DownloadProgress, DownloadRequest, ProxyRoute};

const MAX_RECORD_BYTES: u64 = 64 * 1024;

#[derive(Clone)]
pub(super) struct DownloadJournal {
    root: PathBuf,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    id: String,
    url: String,
    partial: PathBuf,
    completed: PathBuf,
    total: Option<u64>,
    sha256: Option<String>,
    progress: Option<DownloadProgress>,
}

pub(super) struct RecoveredDownload {
    pub request: DownloadRequest,
    pub progress: DownloadProgress,
}

impl DownloadJournal {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    fn directory(&self) -> Result<PathBuf, DownloadError> {
        reject_link(&self.root)?;
        fs::create_dir_all(&self.root)?;
        let directory = self.root.join(".jobs");
        reject_link(&directory)?;
        fs::create_dir_all(&directory)?;
        Ok(directory)
    }

    fn path(&self, id: &str) -> Result<PathBuf, DownloadError> {
        Ok(self.directory()?.join(format!("{}.json", digest(id))))
    }

    /// Hold every resource reservation across app instances until its worker
    /// finishes, including cancellation, verification and terminal publication.
    pub fn reserve(&self, request: &DownloadRequest) -> Result<Vec<File>, DownloadError> {
        let directory = self.directory()?;
        let mut keys = super::manager::artifact_keys(request)?;
        keys.push(format!("id:{}", request.id));
        for path in [&request.partial_path, &request.completed_path] {
            keys.push(format!(
                "path:{}",
                super::paths::reservation_key(path).display()
            ));
        }
        keys.sort();
        keys.dedup();
        keys.into_iter()
            .map(|key| {
                let path = directory.join(format!("{}.lock", digest(&key)));
                reject_regular(&path)?;
                let file = OpenOptions::new()
                    .create(true)
                    .truncate(false)
                    .read(true)
                    .write(true)
                    .open(path)?;
                file.try_lock().map_err(|error| match error {
                    std::fs::TryLockError::WouldBlock => {
                        DownloadError::AlreadyActive(request.id.clone())
                    }
                    std::fs::TryLockError::Error(error) => DownloadError::Io(error),
                })?;
                Ok(file)
            })
            .collect()
    }

    pub fn save(
        &self,
        request: &DownloadRequest,
        progress: Option<DownloadProgress>,
    ) -> Result<(), DownloadError> {
        super::integrity::validate_request(request)?;
        self.directory()?;
        let root = fs::canonicalize(&self.root)?;
        super::validate_download_paths_within_root(
            &request.partial_path,
            &request.completed_path,
            &root,
        )?;
        let relative = |path: &Path| -> Result<PathBuf, DownloadError> {
            super::paths::canonical_candidate(path)?
                .strip_prefix(&root)
                .map(Path::to_path_buf)
                .map_err(|_| invalid("saved download path is outside staging"))
        };
        let record = Record {
            id: request.id.clone(),
            url: request.url.clone(),
            partial: relative(&request.partial_path)?,
            completed: relative(&request.completed_path)?,
            total: request.expected_total,
            sha256: request.expected_sha256.clone(),
            progress,
        };
        let bytes = serde_json::to_vec(&record).map_err(|error| invalid(&error.to_string()))?;
        if bytes.len() as u64 > MAX_RECORD_BYTES {
            return Err(invalid("saved download description exceeds 64 KiB"));
        }
        let path = self.path(&request.id)?;
        reject_regular(&path)?;
        let temporary = path.with_extension("tmp");
        // Resource locks exclude simultaneous writers for this task id.
        reject_regular(&temporary)?;
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(temporary, path)?;
        #[cfg(unix)]
        File::open(self.directory()?)?.sync_all()?;
        Ok(())
    }

    pub fn remove(&self, id: &str) -> Result<(), DownloadError> {
        let path = self.path(id)?;
        reject_regular(&path)?;
        match fs::remove_file(path) {
            Ok(()) => {
                #[cfg(unix)]
                File::open(self.directory()?)?.sync_all()?;
                Ok(())
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    pub async fn recover(&self) -> (Vec<RecoveredDownload>, Vec<String>) {
        let directory = match self.directory().and_then(|path| Ok(fs::read_dir(path)?)) {
            Ok(directory) => directory,
            Err(error) => return (vec![], vec![error.to_string()]),
        };
        let mut downloads = Vec::new();
        let mut errors = Vec::new();
        for entry in directory {
            let path = match entry {
                Ok(entry) => entry.path(),
                Err(error) => {
                    errors.push(format!("read saved module download: {error}"));
                    continue;
                }
            };
            if path.extension().is_none_or(|extension| extension != "json") {
                continue;
            }
            match self.recover_one(&path).await {
                Ok(download) => downloads.push(download),
                Err(error) => errors.push(format!("{}: {error}", path.display())),
            }
        }
        (downloads, errors)
    }

    async fn recover_one(&self, path: &Path) -> Result<RecoveredDownload, DownloadError> {
        reject_regular(path)?;
        let mut bytes = Vec::new();
        File::open(path)?
            .take(MAX_RECORD_BYTES + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_RECORD_BYTES {
            return Err(invalid("saved download description exceeds 64 KiB"));
        }
        let record: Record = serde_json::from_slice(&bytes)
            .map_err(|error| invalid(&format!("invalid saved download: {error}")))?;
        if path != self.path(&record.id)? {
            return Err(invalid("saved task id does not match its journal filename"));
        }
        for suffix in [&record.partial, &record.completed] {
            if suffix.as_os_str().is_empty()
                || suffix
                    .components()
                    .any(|part| !matches!(part, Component::Normal(_)))
            {
                return Err(invalid("saved download contains an unsafe relative path"));
            }
        }
        let request = DownloadRequest {
            id: record.id,
            url: record.url,
            partial_path: self.root.join(record.partial),
            completed_path: self.root.join(record.completed),
            expected_total: record.total,
            expected_sha256: record.sha256,
            // Resumption must resolve current Settings again. A journal never
            // causes network activity or retains a resolved password.
            proxy: ProxyRoute::NoProxy,
        };
        super::integrity::validate_request(&request)?;
        super::validate_download_paths_within_root(
            &request.partial_path,
            &request.completed_path,
            &self.root,
        )?;
        let _resource_locks = self.reserve(&request)?;
        let mut progress = record.progress.unwrap_or(DownloadProgress {
            revision: 1,
            downloaded: 0,
            total: request.expected_total,
            phase: DownloadPhase::Failed,
            error: None,
        });
        progress.revision = progress.revision.saturating_add(1);
        progress.total = request.expected_total;
        progress.downloaded = file_length(&request.partial_path)?;
        if !matches!(
            progress.phase,
            DownloadPhase::Cancelled | DownloadPhase::Failed
        ) || progress.phase == DownloadPhase::Failed && progress.error.is_none()
        {
            progress.phase = DownloadPhase::Failed;
            progress.error =
                Some("Download interrupted; resume to continue from saved bytes".into());
        }
        if request.completed_path.exists() {
            progress.downloaded = file_length(&request.completed_path)?;
            let result = if request.expected_sha256.is_none() {
                Err(invalid("completed download has no expected SHA-256"))
            } else if request
                .expected_total
                .is_some_and(|size| size != progress.downloaded)
            {
                Err(invalid("completed download has an unexpected size"))
            } else {
                super::integrity::verify_file(
                    &request.completed_path,
                    request.expected_sha256.as_deref(),
                    &tokio_util::sync::CancellationToken::new(),
                )
                .await
            };
            match result {
                Ok(()) => {
                    progress.phase = DownloadPhase::Completed;
                    progress.error = None;
                }
                Err(error) => {
                    progress.phase = DownloadPhase::Failed;
                    progress.error = Some(error.to_string());
                }
            }
        } else if progress.downloaded > super::integrity::MAX_PACKAGE_BYTES
            || request
                .expected_total
                .is_some_and(|size| progress.downloaded > size)
        {
            progress.error = Some("Saved partial exceeds the expected package size".into());
        }
        Ok(RecoveredDownload { request, progress })
    }
}

fn file_length(path: &Path) -> Result<u64, DownloadError> {
    reject_regular(path)?;
    match fs::metadata(path) {
        Ok(metadata) => Ok(metadata.len()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(0),
        Err(error) => Err(error.into()),
    }
}

fn reject_link(path: &Path) -> Result<(), DownloadError> {
    if fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(invalid("download journal must not contain symlinks"));
    }
    Ok(())
}

fn reject_regular(path: &Path) -> Result<(), DownloadError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.is_file() || metadata.file_type().is_symlink() => {
            Err(invalid("saved download must be a regular file"))
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn digest(value: &str) -> String {
    super::integrity::hex_digest(&Sha256::digest(value.as_bytes()))
}

fn invalid(message: &str) -> DownloadError {
    DownloadError::InvalidPath(message.into())
}

#[cfg(test)]
#[path = "journal_tests.rs"]
mod tests;
