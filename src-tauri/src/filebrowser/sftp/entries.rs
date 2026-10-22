use super::connection::ActiveSftp;
use super::connection::is_disconnect_error;
use super::metadata::FileEntryDto;
use super::metadata::entry_from_attrs;
use super::metadata::join_remote;
use super::metadata::remote_basename;
use russh_sftp::protocol::FileType as SftpFileType;

impl ActiveSftp {
    pub async fn list_dir(&self, path: &str) -> Result<Vec<FileEntryDto>, String> {
        retry_reconnect!(self, self.list_dir_once(path).await)
    }

    pub(super) async fn list_dir_once(&self, path: &str) -> Result<Vec<FileEntryDto>, String> {
        let dir_entries = {
            let sftp = self.sftp.lock().await;
            sftp.read_dir(path.to_string())
                .await
                .map_err(|e| format!("Failed to read {}: {}", path, e))?
        };
        let mut entries: Vec<FileEntryDto> = Vec::new();
        for item in dir_entries {
            let name = item.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let attrs = item.metadata();
            let full = join_remote(path, &name);
            let mut dto = entry_from_attrs(name, full.clone(), attrs);
            // Resolve symlink targets for display. Best-effort: failures
            // (broken links, permission denied) leave the field empty.
            if dto.file_type == "symlink" {
                let sftp = self.sftp.lock().await;
                if let Ok(target) = sftp.read_link(full.clone()).await {
                    dto.symlink_target = Some(target);
                }
                // STAT (vs LSTAT used by read_dir) follows the link — the
                // returned attrs describe the *target*. We only need its
                // type so callers can distinguish "symlink → dir" from
                // "symlink → file" when handling double-click / open.
                if let Ok(target_attrs) = sftp.metadata(full.clone()).await {
                    let t = match target_attrs.file_type() {
                        SftpFileType::Dir => "dir",
                        SftpFileType::File => "file",
                        SftpFileType::Symlink => "symlink",
                        SftpFileType::Other => "unknown",
                    };
                    dto.target_file_type = Some(t.into());
                }
            }
            entries.push(dto);
        }
        entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        Ok(entries)
    }

    pub async fn read_link(&self, path: &str) -> Result<String, String> {
        retry_reconnect!(self, self.read_link_once(path).await)
    }

    pub(super) async fn read_link_once(&self, path: &str) -> Result<String, String> {
        let sftp = self.sftp.lock().await;
        sftp.read_link(path.to_string())
            .await
            .map_err(|e| format!("readlink {}: {}", path, e))
    }

    pub async fn stat(&self, path: &str) -> Result<FileEntryDto, String> {
        retry_reconnect!(self, self.stat_once(path).await)
    }

    pub(super) async fn stat_once(&self, path: &str) -> Result<FileEntryDto, String> {
        let sftp = self.sftp.lock().await;
        let attrs = sftp
            .metadata(path.to_string())
            .await
            .map_err(|e| format!("stat {}: {}", path, e))?;
        let name = remote_basename(path).to_string();
        Ok(entry_from_attrs(name, path.to_string(), attrs))
    }

    pub async fn realpath(&self, path: &str) -> Result<String, String> {
        retry_reconnect!(self, self.realpath_once(path).await)
    }

    pub(super) async fn realpath_once(&self, path: &str) -> Result<String, String> {
        let sftp = self.sftp.lock().await;
        sftp.canonicalize(path.to_string())
            .await
            .map_err(|e| format!("realpath {}: {}", path, e))
    }
}
