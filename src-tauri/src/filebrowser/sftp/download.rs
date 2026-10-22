use super::connection::ActiveSftp;
use super::progress::CHUNK_SIZE;
use super::progress::emit_paused;
use super::progress::emit_progress;
use crate::filebrowser::local;
use crate::filebrowser::transfer::TransferHandle;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Instant;
use tauri::AppHandle;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;

impl ActiveSftp {
    /// Recursively download `remote_dir` into `local_dir`. The local
    /// directory is created (with parents) if it does not exist. Progress is
    /// emitted as a single aggregate stream — `dir_size` pre-walks the remote
    /// tree to give the UI a stable "total" up front.
    pub async fn download_dir(
        &self,
        remote_dir: &str,
        local_dir: &Path,
        transfer_id: String,
        handle: Arc<TransferHandle>,
        app: AppHandle,
    ) -> Result<(), String> {
        let total = self.dir_size(remote_dir).await?;
        tokio::fs::create_dir_all(local_dir)
            .await
            .map_err(|e| format!("mkdir {}: {}", local_dir.display(), e))?;
        let completed = Arc::new(AtomicU64::new(0));
        let started = Instant::now();
        emit_progress(&app, &transfer_id, 0, total, started);
        self.download_dir_walk(
            remote_dir,
            local_dir,
            &transfer_id,
            &handle,
            &app,
            total,
            &completed,
            started,
        )
        .await
    }

    pub(super) async fn download_dir_walk(
        &self,
        remote_dir: &str,
        local_dir: &Path,
        transfer_id: &str,
        handle: &Arc<TransferHandle>,
        app: &AppHandle,
        total: u64,
        completed: &Arc<AtomicU64>,
        started: Instant,
    ) -> Result<(), String> {
        let entries = self.list_dir(remote_dir).await?;
        for entry in entries {
            if handle.is_cancelled() {
                return Err("transfer cancelled".to_string());
            }
            // Mirror upload_dir_walk: surface pauses between entries so the
            // walk suspends even when the current entry is just a subdirectory
            // (no chunk-loop pause check would fire).
            if handle.is_paused() {
                emit_paused(app, transfer_id, completed.load(Ordering::SeqCst), total);
                handle.wait_while_paused().await;
                if handle.is_cancelled() {
                    return Err("transfer cancelled".to_string());
                }
            }
            let local_target = local_dir.join(&entry.name);
            if entry.file_type == "dir" {
                tokio::fs::create_dir_all(&local_target)
                    .await
                    .map_err(|e| format!("mkdir {}: {}", local_target.display(), e))?;
                Box::pin(self.download_dir_walk(
                    &entry.path,
                    &local_target,
                    transfer_id,
                    handle,
                    app,
                    total,
                    completed,
                    started,
                ))
                .await?;
            } else if entry.file_type == "file" {
                self.download_file_aggregated(
                    &entry.path,
                    &local_target,
                    transfer_id,
                    handle,
                    app,
                    total,
                    completed,
                    started,
                )
                .await?;
            }
        }
        Ok(())
    }

    pub(super) async fn download_file_aggregated(
        &self,
        remote: &str,
        local: &Path,
        transfer_id: &str,
        handle: &Arc<TransferHandle>,
        app: &AppHandle,
        total: u64,
        completed: &Arc<AtomicU64>,
        started: Instant,
    ) -> Result<(), String> {
        let mut remote_file = {
            let sftp = self.sftp.lock().await;
            sftp.open(remote.to_string())
                .await
                .map_err(|e| format!("open {}: {}", remote, e))?
        };
        let mut local_file = tokio::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(local)
            .await
            .map_err(|e| format!("open {} for write: {}", local.display(), e))?;
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
            let n = remote_file
                .read(&mut buf)
                .await
                .map_err(|e| format!("read {}: {}", remote, e))?;
            if n == 0 {
                break;
            }
            local_file
                .write_all(&buf[..n])
                .await
                .map_err(|e| format!("write {}: {}", local.display(), e))?;
            let now = completed.fetch_add(n as u64, Ordering::SeqCst) + n as u64;
            emit_progress(app, transfer_id, now, total, started);
        }
        local_file
            .shutdown()
            .await
            .map_err(|e| format!("close {}: {}", local.display(), e))?;
        Ok(())
    }

    pub async fn download_file(
        &self,
        remote: &str,
        local: &Path,
        transfer_id: String,
        handle: Arc<TransferHandle>,
        app: AppHandle,
    ) -> Result<(), String> {
        // Stat + open under the session lock, then release it.
        let (total, mut remote_file) = {
            let sftp = self.sftp.lock().await;
            let attrs = sftp
                .metadata(remote.to_string())
                .await
                .map_err(|e| format!("stat {}: {}", remote, e))?;
            let file = sftp
                .open(remote.to_string())
                .await
                .map_err(|e| format!("open {}: {}", remote, e))?;
            (attrs.size.unwrap_or(0), file)
        };

        if let Some(parent) = local.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
        }
        let mut local_file = tokio::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(local)
            .await
            .map_err(|e| format!("open {} for write: {}", local.display(), e))?;

        let mut buf = vec![0u8; CHUNK_SIZE];
        let mut read_total: u64 = 0;
        let started = Instant::now();
        loop {
            if handle.is_cancelled() {
                return Err("transfer cancelled".to_string());
            }
            if handle.is_paused() {
                emit_paused(&app, &transfer_id, read_total, total);
                handle.wait_while_paused().await;
                if handle.is_cancelled() {
                    return Err("transfer cancelled".to_string());
                }
            }
            let n = remote_file
                .read(&mut buf)
                .await
                .map_err(|e| format!("read {}: {}", remote, e))?;
            if n == 0 {
                break;
            }
            local_file
                .write_all(&buf[..n])
                .await
                .map_err(|e| format!("write {}: {}", local.display(), e))?;
            read_total += n as u64;
            emit_progress(&app, &transfer_id, read_total, total, started);
        }
        local_file
            .shutdown()
            .await
            .map_err(|e| format!("close {}: {}", local.display(), e))?;
        Ok(())
    }
}
