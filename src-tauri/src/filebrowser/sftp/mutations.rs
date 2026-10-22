use super::connection::ActiveSftp;
use super::connection::is_disconnect_error;

impl ActiveSftp {
    pub async fn mkdir(&self, path: &str) -> Result<(), String> {
        retry_reconnect!(self, self.mkdir_once(path).await)
    }

    pub(super) async fn mkdir_once(&self, path: &str) -> Result<(), String> {
        let sftp = self.sftp.lock().await;
        sftp.create_dir(path.to_string())
            .await
            .map_err(|e| format!("mkdir {}: {}", path, e))
    }

    pub async fn remove(&self, path: &str, recursive: bool) -> Result<(), String> {
        retry_reconnect!(self, self.remove_once(path, recursive).await)
    }

    pub(super) async fn remove_once(&self, path: &str, recursive: bool) -> Result<(), String> {
        let sftp = self.sftp.lock().await;
        let attrs = sftp
            .metadata(path.to_string())
            .await
            .map_err(|e| format!("stat {}: {}", path, e))?;
        if attrs.is_dir() {
            if recursive {
                drop(sftp);
                self.remove_dir_recursive(path).await
            } else {
                sftp.remove_dir(path.to_string())
                    .await
                    .map_err(|e| format!("rmdir {}: {}", path, e))
            }
        } else {
            sftp.remove_file(path.to_string())
                .await
                .map_err(|e| format!("unlink {}: {}", path, e))
        }
    }

    pub(super) async fn remove_dir_recursive(&self, path: &str) -> Result<(), String> {
        let entries = self.list_dir(path).await?;
        for entry in entries {
            if entry.file_type == "dir" {
                Box::pin(self.remove_dir_recursive(&entry.path)).await?;
            } else {
                let sftp = self.sftp.lock().await;
                sftp.remove_file(entry.path.clone())
                    .await
                    .map_err(|e| format!("unlink {}: {}", entry.path, e))?;
            }
        }
        let sftp = self.sftp.lock().await;
        sftp.remove_dir(path.to_string())
            .await
            .map_err(|e| format!("rmdir {}: {}", path, e))
    }

    pub async fn rename(&self, from: &str, to: &str) -> Result<(), String> {
        retry_reconnect!(self, self.rename_once(from, to).await)
    }

    pub(super) async fn rename_once(&self, from: &str, to: &str) -> Result<(), String> {
        let sftp = self.sftp.lock().await;
        sftp.rename(from.to_string(), to.to_string())
            .await
            .map_err(|e| format!("rename {} -> {}: {}", from, to, e))
    }

    pub async fn chmod(&self, path: &str, mode: u32) -> Result<(), String> {
        retry_reconnect!(self, self.chmod_once(path, mode).await)
    }

    pub(super) async fn chmod_once(&self, path: &str, mode: u32) -> Result<(), String> {
        let sftp = self.sftp.lock().await;
        let mut attrs = sftp
            .metadata(path.to_string())
            .await
            .map_err(|e| format!("stat {}: {}", path, e))?;
        attrs.permissions = Some(mode);
        sftp.set_metadata(path.to_string(), attrs)
            .await
            .map_err(|e| format!("chmod {}: {}", path, e))
    }
}
