use super::connection::ActiveSftp;
use super::connection::is_disconnect_error;
use russh_sftp::protocol::OpenFlags;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;

impl ActiveSftp {
    pub async fn read_bytes(&self, path: &str, max_bytes: u64) -> Result<Vec<u8>, String> {
        retry_reconnect!(self, self.read_bytes_once(path, max_bytes).await)
    }

    pub(super) async fn read_bytes_once(
        &self,
        path: &str,
        max_bytes: u64,
    ) -> Result<Vec<u8>, String> {
        let (size, mut file) = {
            let sftp = self.sftp.lock().await;
            let attrs = sftp
                .metadata(path.to_string())
                .await
                .map_err(|e| format!("stat {}: {}", path, e))?;
            if attrs.size.unwrap_or(0) > max_bytes {
                return Err(format!(
                    "File is {} bytes, exceeds preview limit of {} bytes",
                    attrs.size.unwrap_or(0),
                    max_bytes
                ));
            }
            let file = sftp
                .open(path.to_string())
                .await
                .map_err(|e| format!("open {}: {}", path, e))?;
            (attrs.size.unwrap_or(0), file)
        };
        let mut buf = Vec::with_capacity(size as usize);
        file.read_to_end(&mut buf)
            .await
            .map_err(|e| format!("read {}: {}", path, e))?;
        Ok(buf)
    }

    pub async fn write_bytes(&self, path: &str, data: &[u8]) -> Result<(), String> {
        retry_reconnect!(self, self.write_bytes_once(path, data).await)
    }

    pub(super) async fn write_bytes_once(&self, path: &str, data: &[u8]) -> Result<(), String> {
        let mut file = {
            let sftp = self.sftp.lock().await;
            sftp.open_with_flags(
                path.to_string(),
                OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE,
            )
            .await
            .map_err(|e| format!("open {} for write: {}", path, e))?
        };
        file.write_all(data)
            .await
            .map_err(|e| format!("write {}: {}", path, e))?;
        file.shutdown()
            .await
            .map_err(|e| format!("close {}: {}", path, e))
    }
}
