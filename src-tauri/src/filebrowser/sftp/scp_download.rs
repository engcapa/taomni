//! Persistent, integrity-checked SCP partials. The remote Python metadata
//! prerequisite also supplies SCP suffix framing when the stock scp command
//! cannot seek. No SFTP subsystem is involved in either path.
use super::connection::ActiveSftp;
use super::scp::{Progress, ack, line, parse_file_header, quote};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

#[derive(Deserialize)]
struct Fingerprint {
    size: u64,
    sha256: String,
    prefix: String,
}

fn partial_path(local: &Path, identity: &str) -> PathBuf {
    let mut name = local.as_os_str().to_os_string();
    name.push(format!(
        ".taomni-scp-{}.part",
        hex::encode(Sha256::digest(identity.as_bytes()))
    ));
    PathBuf::from(name)
}

async fn checksum(file: &mut tokio::fs::File) -> Result<String, String> {
    file.rewind().await.map_err(|e| e.to_string())?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0; 256 * 1024];
    loop {
        let count = file.read(&mut buffer).await.map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(hex::encode(digest.finalize()))
}

/// The OS file lock disappears on process exit, unlike a stale lockfile. Keep
/// this descriptor alive through checksum and publication to reject duplicates.
fn open_partial(path: &Path) -> Result<std::fs::File, String> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    let file = options
        .open(path)
        .map_err(|e| format!("Open SCP partial: {e}"))?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if file
            .metadata()
            .map_err(|e| e.to_string())?
            .file_attributes()
            & 0x400
            != 0
        {
            return Err("SCP partial must not be a reparse point".into());
        }
    }
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("SCP partial must be a regular file".into());
    }
    file.try_lock()
        .map_err(|_| "This SCP destination is already downloading")?;
    Ok(file)
}

impl ActiveSftp {
    pub(super) async fn scp_download(
        &self,
        remote: &str,
        local: &Path,
        progress: Progress<'_>,
    ) -> Result<(), String> {
        let params = self
            .reconnect
            .as_ref()
            .ok_or("Missing SCP connection settings")?;
        let identity =
            serde_json::to_string(&(&params.host, params.port, &params.username, remote))
                .map_err(|e| e.to_string())?;
        let temporary = partial_path(local, &identity);
        let operation = async {
            if let Some(parent) = local.parent() {
                tokio::fs::create_dir_all(parent)
                    .await
                    .map_err(|e| e.to_string())?;
            }
            progress.ready().await?;
            progress.phase("connecting", 0, false);
            let mut output = tokio::fs::File::from_std(open_partial(&temporary)?);
            let mut offset = output.metadata().await.map_err(|e| e.to_string())?.len();
            let original: Fingerprint = self
                .scp_metadata("fingerprint", serde_json::json!([remote, offset]))
                .await?;
            let restarted =
                offset > original.size || checksum(&mut output).await? != original.prefix;
            if restarted {
                // A previous partial belongs to an older version. Never append
                // a new suffix to it; restart explicitly from byte zero.
                tracing::info!(
                    "SCP source changed; restarting the retained partial from byte zero"
                );
                output.set_len(0).await.map_err(|e| e.to_string())?;
                output.rewind().await.map_err(|e| e.to_string())?;
                offset = 0;
            }
            progress
                .advance(usize::try_from(offset).map_err(|_| "SCP offset exceeds platform limit")?);
            progress.phase("downloading", offset, restarted);
            if offset < original.size || original.size == 0 {
                let path = if remote.starts_with('/') {
                    remote.to_string()
                } else {
                    format!("./{remote}")
                };
                let command = if offset == 0 {
                    format!("scp -f {}", quote(&path)?)
                } else {
                    format!(
                        "python3 -c {} {}",
                        quote(include_str!("scp_source.py"))?,
                        quote(
                            &serde_json::to_string(&(remote, offset, &original.sha256))
                                .map_err(|e| e.to_string())?
                        )?
                    )
                };
                let mut stream = self.scp_stream(&command).await?;
                stream.write_all(&[0]).await.map_err(|e| e.to_string())?;
                let size = parse_file_header(&line(&mut stream).await?)?;
                if size != original.size - offset {
                    return Err("Remote file changed before SCP download".into());
                }
                stream.write_all(&[0]).await.map_err(|e| e.to_string())?;
                let mut remaining = size;
                let mut buffer = vec![0; self.scp_chunk_size()];
                while remaining > 0 {
                    progress.ready().await?;
                    let length = buffer
                        .len()
                        .min(usize::try_from(remaining).unwrap_or(usize::MAX));
                    let count = stream
                        .read(&mut buffer[..length])
                        .await
                        .map_err(|e| e.to_string())?;
                    if count == 0 {
                        return Err("SCP file ended before its advertised length".into());
                    }
                    output
                        .write_all(&buffer[..count])
                        .await
                        .map_err(|e| e.to_string())?;
                    remaining -= count as u64;
                    progress.advance(count);
                }
                ack(&mut stream).await?;
                stream.write_all(&[0]).await.map_err(|e| e.to_string())?;
            }
            output.flush().await.map_err(|e| e.to_string())?;
            progress.phase("verifying", offset, restarted);
            if checksum(&mut output).await? != original.sha256 {
                return Err("SCP integrity verification failed; original destination preserved. Retry to restart.".into());
            }
            output.sync_all().await.map_err(|e| e.to_string())?;
            progress.ready().await?;
            // Keep the lock until publication; Windows Rust opens file handles
            // with FILE_SHARE_DELETE, so replacement can occur with this lease.
            tokio::fs::rename(&temporary, local)
                .await
                .map_err(|e| e.to_string())
        };
        self.scp_cancellable(operation, progress.handle).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partials_survive_restarts_but_do_not_mix_remote_identities() {
        let local = Path::new("download.bin");
        assert_eq!(
            partial_path(local, "user@host:a"),
            partial_path(local, "user@host:a")
        );
        assert_ne!(
            partial_path(local, "user@host:a"),
            partial_path(local, "user@host:b")
        );
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("partial");
        let first = open_partial(&path).unwrap();
        assert!(open_partial(&path).is_err());
        drop(first);
        assert!(open_partial(&path).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn partials_never_follow_symlinks() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("partial");
        std::os::unix::fs::symlink("unrelated", &path).unwrap();
        assert!(open_partial(&path).is_err());
        assert!(!directory.path().join("unrelated").exists());
    }
}
