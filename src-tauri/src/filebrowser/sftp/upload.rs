use super::connection::ActiveSftp;
use super::metadata::join_remote;
use super::progress::CHUNK_SIZE;
use super::progress::emit_paused;
use super::progress::emit_progress;
use crate::filebrowser::local;
use crate::filebrowser::transfer::TransferHandle;
use russh_sftp::protocol::OpenFlags;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Instant;
use tauri::AppHandle;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;

impl ActiveSftp {
    pub async fn upload_file(
        &self,
        local: &Path,
        remote: &str,
        transfer_id: String,
        handle: Arc<TransferHandle>,
        app: AppHandle,
    ) -> Result<(), String> {
        if self.is_scp() {
            let completed = AtomicU64::new(0);
            let total = tokio::fs::metadata(local)
                .await
                .map_err(|e| e.to_string())?
                .len();
            return self
                .scp_upload(
                    local,
                    remote,
                    super::scp::Progress {
                        app: &app,
                        id: &transfer_id,
                        handle: &handle,
                        total,
                        completed: &completed,
                        started: Instant::now(),
                    },
                )
                .await;
        }

        use tokio::io::AsyncReadExt as _;

        let mut file = tokio::fs::File::open(local)
            .await
            .map_err(|e| format!("open {}: {}", local.display(), e))?;
        let total = file.metadata().await.map(|m| m.len()).unwrap_or(0);

        // Open the remote file under the session lock, then release the lock
        // so other ops (list, stat) can interleave with the chunked transfer.
        let mut remote_file = {
            let sftp = self.sftp_session().await?;
            sftp.open_with_flags(
                remote.to_string(),
                OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE,
            )
            .await
            .map_err(|e| format!("open remote {} for write: {}", remote, e))?
        };

        let mut buf = vec![0u8; CHUNK_SIZE];
        let mut written: u64 = 0;
        let started = Instant::now();
        loop {
            if handle.is_cancelled() {
                return Err("transfer cancelled".to_string());
            }
            if handle.is_paused() {
                emit_paused(&app, &transfer_id, written, total);
                handle.wait_while_paused().await;
                if handle.is_cancelled() {
                    return Err("transfer cancelled".to_string());
                }
            }
            let n = file
                .read(&mut buf)
                .await
                .map_err(|e| format!("read {}: {}", local.display(), e))?;
            if n == 0 {
                break;
            }
            remote_file
                .write_all(&buf[..n])
                .await
                .map_err(|e| format!("write {}: {}", remote, e))?;
            written += n as u64;
            emit_progress(&app, &transfer_id, written, total, started);
        }
        remote_file
            .shutdown()
            .await
            .map_err(|e| format!("close {}: {}", remote, e))?;
        Ok(())
    }

    /// Recursively sum the byte size of every regular file under `path`.
    /// Mirrors `local::dir_size` so callers can pre-compute a "total bytes"
    /// figure for download progress reporting before any data is transferred.
    pub async fn dir_size(&self, path: &str) -> Result<u64, String> {
        let entries = self.list_dir(path).await?;
        let mut total: u64 = 0;
        for entry in entries {
            if entry.file_type == "dir" {
                total = total.saturating_add(Box::pin(self.dir_size(&entry.path)).await?);
            } else if entry.file_type == "file" {
                total = total.saturating_add(entry.size);
            }
        }
        Ok(total)
    }

    /// Idempotent mkdir: succeed if the directory already exists. Used by
    /// recursive folder transfers where intermediate dirs may have been
    /// created by a prior partial run. The original `create_dir` error is
    /// preserved when the path also fails to stat as a directory, so the
    /// caller still sees the actionable cause (permission denied, read-only
    /// filesystem, etc.) instead of a generic message.
    pub(super) async fn mkdir_idempotent(&self, path: &str) -> Result<(), String> {
        if self.is_scp() {
            return self.scp_metadata("mkdirs", serde_json::json!([path])).await;
        }
        let sftp = self.sftp_session().await?;
        let create_err = match sftp.create_dir(path.to_string()).await {
            Ok(()) => return Ok(()),
            Err(e) => e,
        };
        match sftp.metadata(path.to_string()).await {
            Ok(attrs) if attrs.is_dir() => Ok(()),
            _ => Err(format!("mkdir {}: {}", path, create_err)),
        }
    }

    /// Recursively upload `local_dir` into `remote_dir`. The remote directory
    /// is created if it does not already exist. Progress is emitted as a
    /// single aggregate stream covering every file copied in the tree, using
    /// the byte total computed by `local::dir_size` so the percentage stays
    /// accurate as files complete.
    pub async fn upload_dir(
        &self,
        local_dir: &Path,
        remote_dir: &str,
        transfer_id: String,
        handle: Arc<TransferHandle>,
        app: AppHandle,
    ) -> Result<(), String> {
        let total = local::dir_size(local_dir)?;
        self.mkdir_idempotent(remote_dir).await?;
        let completed = Arc::new(AtomicU64::new(0));
        let started = Instant::now();
        // Emit an initial 0/total frame so the UI immediately shows the
        // expected size instead of "0 / 0".
        emit_progress(&app, &transfer_id, 0, total, started);
        self.upload_dir_walk(
            local_dir,
            remote_dir,
            &transfer_id,
            &handle,
            &app,
            total,
            &completed,
            started,
        )
        .await
    }

    pub(super) async fn upload_dir_walk(
        &self,
        local_dir: &Path,
        remote_dir: &str,
        transfer_id: &str,
        handle: &Arc<TransferHandle>,
        app: &AppHandle,
        total: u64,
        completed: &Arc<AtomicU64>,
        started: Instant,
    ) -> Result<(), String> {
        let mut read = tokio::fs::read_dir(local_dir)
            .await
            .map_err(|e| format!("read {}: {}", local_dir.display(), e))?;
        loop {
            if handle.is_cancelled() {
                return Err("transfer cancelled".to_string());
            }
            // Honour pauses at each iteration so a folder full of small files
            // (or empty subdirs) still suspends promptly — chunk-loop checks
            // alone would never trigger between mkdirs.
            if handle.is_paused() {
                emit_paused(app, transfer_id, completed.load(Ordering::SeqCst), total);
                handle.wait_while_paused().await;
                if handle.is_cancelled() {
                    return Err("transfer cancelled".to_string());
                }
            }
            let next = read
                .next_entry()
                .await
                .map_err(|e| format!("read entry in {}: {}", local_dir.display(), e))?;
            let Some(entry) = next else { break };
            let name = entry.file_name().to_string_lossy().to_string();
            let child_local = entry.path();
            let child_remote = join_remote(remote_dir, &name);
            let meta = tokio::fs::symlink_metadata(&child_local)
                .await
                .map_err(|e| format!("stat {}: {}", child_local.display(), e))?;
            if meta.file_type().is_dir() {
                self.mkdir_idempotent(&child_remote).await?;
                Box::pin(self.upload_dir_walk(
                    &child_local,
                    &child_remote,
                    transfer_id,
                    handle,
                    app,
                    total,
                    completed,
                    started,
                ))
                .await?;
            } else if meta.file_type().is_file() {
                self.upload_file_aggregated(
                    &child_local,
                    &child_remote,
                    transfer_id,
                    handle,
                    app,
                    total,
                    completed,
                    started,
                )
                .await?;
            }
            // Symlinks and special files are intentionally skipped to keep
            // the transfer semantics simple and predictable.
        }
        Ok(())
    }

    pub(super) async fn upload_file_aggregated(
        &self,
        local: &Path,
        remote: &str,
        transfer_id: &str,
        handle: &Arc<TransferHandle>,
        app: &AppHandle,
        total: u64,
        completed: &Arc<AtomicU64>,
        started: Instant,
    ) -> Result<(), String> {
        if self.is_scp() {
            return self
                .scp_upload(
                    local,
                    remote,
                    super::scp::Progress {
                        app,
                        id: transfer_id,
                        handle,
                        total,
                        completed,
                        started,
                    },
                )
                .await;
        }

        let mut file = tokio::fs::File::open(local)
            .await
            .map_err(|e| format!("open {}: {}", local.display(), e))?;
        let mut remote_file = {
            let sftp = self.sftp_session().await?;
            sftp.open_with_flags(
                remote.to_string(),
                OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE,
            )
            .await
            .map_err(|e| format!("open remote {} for write: {}", remote, e))?
        };

        let mut buf = vec![0u8; CHUNK_SIZE];
        loop {
            if handle.is_cancelled() {
                return Err("transfer cancelled".to_string());
            }
            if handle.is_paused() {
                emit_paused(app, transfer_id, completed.load(Ordering::SeqCst), total);
                handle.wait_while_paused().await;
                if handle.is_cancelled() {
                    return Err("transfer cancelled".to_string());
                }
            }
            let n = file
                .read(&mut buf)
                .await
                .map_err(|e| format!("read {}: {}", local.display(), e))?;
            if n == 0 {
                break;
            }
            remote_file
                .write_all(&buf[..n])
                .await
                .map_err(|e| format!("write {}: {}", remote, e))?;
            let now = completed.fetch_add(n as u64, Ordering::SeqCst) + n as u64;
            emit_progress(app, transfer_id, now, total, started);
        }
        remote_file
            .shutdown()
            .await
            .map_err(|e| format!("close {}: {}", remote, e))?;
        Ok(())
    }
}
