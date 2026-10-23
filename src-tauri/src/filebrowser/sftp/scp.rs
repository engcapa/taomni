//! SCP wire protocol and shell metadata. SCP mode does not request an SFTP
//! subsystem. Remote metadata requires Python 3; transfers require scp.
use super::connection::ActiveSftp;
use super::progress::{emit_paused, emit_progress};
use crate::filebrowser::transfer::TransferHandle;
use crate::terminal::ssh::SshAuth;
use serde::de::DeserializeOwned;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

trait ByteStream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> ByteStream for T {}
type Stream = Box<dyn ByteStream>;

pub(super) struct Progress<'a> {
    pub app: &'a AppHandle,
    pub id: &'a str,
    pub handle: &'a TransferHandle,
    pub total: u64,
    pub completed: &'a AtomicU64,
    pub started: Instant,
}
impl Progress<'_> {
    async fn ready(&self) -> Result<(), String> {
        if self.handle.is_cancelled() {
            return Err("transfer cancelled".into());
        }
        if self.handle.is_paused() {
            emit_paused(
                self.app,
                self.id,
                self.completed.load(Ordering::SeqCst),
                self.total,
            );
            self.handle.wait_while_paused().await;
        }
        if self.handle.is_cancelled() {
            return Err("transfer cancelled".into());
        }
        Ok(())
    }
    fn advance(&self, bytes: usize) {
        let count = self.completed.fetch_add(bytes as u64, Ordering::SeqCst) + bytes as u64;
        emit_progress(self.app, self.id, count, self.total, self.started);
    }
}

fn quote(value: &str) -> Result<String, String> {
    if value.contains('\0') {
        return Err("Remote path contains NUL".into());
    }
    Ok(format!("'{}'", value.replace('\'', "'\\''")))
}

async fn line(stream: &mut Stream) -> Result<Vec<u8>, String> {
    let mut value = Vec::new();
    loop {
        let byte = stream
            .read_u8()
            .await
            .map_err(|e| format!("SCP header: {e}"))?;
        if byte == b'\n' {
            return Ok(value);
        }
        if value.len() >= 8192 {
            return Err("SCP header exceeds 8 KiB".into());
        }
        value.push(byte);
    }
}
async fn ack(stream: &mut Stream) -> Result<(), String> {
    match stream
        .read_u8()
        .await
        .map_err(|e| format!("SCP acknowledgement: {e}"))?
    {
        0 => Ok(()),
        1 | 2 => Err(format!(
            "SCP server: {}",
            String::from_utf8_lossy(&line(stream).await?)
        )),
        _ => Err("Invalid SCP acknowledgement".into()),
    }
}

impl ActiveSftp {
    pub(super) fn is_scp(&self) -> bool {
        self.reconnect
            .as_ref()
            .is_some_and(|p| matches!(p.network.ssh_browser.as_str(), "scp" | "scp-fast"))
    }
    async fn scp_stream(&self, command: &str) -> Result<Stream, String> {
        let params = self
            .reconnect
            .as_ref()
            .ok_or("Missing SCP connection settings")?;
        if matches!(params.auth, SshAuth::Gssapi) {
            return Ok(Box::new(
                crate::terminal::openssh::exec_stream(
                    &params.host,
                    params.port,
                    &params.username,
                    Some(&params.network),
                    command,
                    false,
                )
                .await?,
            ));
        }
        let guard = self._handle.lock().await;
        let handle = guard.as_ref().ok_or("SSH connection closed")?;
        let channel = handle
            .channel_open_session()
            .await
            .map_err(|e| format!("SCP SSH channel: {e}"))?;
        channel
            .exec(true, command.as_bytes())
            .await
            .map_err(|e| format!("SCP exec: {e}"))?;
        Ok(Box::new(channel.into_stream()))
    }

    pub(super) async fn scp_metadata<T: DeserializeOwned>(
        &self,
        op: &str,
        args: serde_json::Value,
    ) -> Result<T, String> {
        let operation = async {
            let request = serde_json::to_string(&(op, args)).map_err(|e| e.to_string())?;
            let command = format!(
                "python3 -c {} {}",
                quote(include_str!("scp_metadata.py"))?,
                quote(&request)?
            );
            let mut stream = self.scp_stream(&command).await?;
            stream.shutdown().await.map_err(|e| e.to_string())?;
            let mut data = Vec::new();
            stream
                .take(16 * 1024 * 1024 + 1)
                .read_to_end(&mut data)
                .await
                .map_err(|e| e.to_string())?;
            if data.len() > 16 * 1024 * 1024 {
                return Err("SCP metadata exceeds 16 MiB".into());
            }
            let response: serde_json::Value = serde_json::from_slice(&data).map_err(
                |_| "SCP metadata requires Python 3 on the remote host; check shell startup output",
            )?;
            if let Some(error) = response.get("error") {
                return Err(format!("SCP {op}: {error}"));
            }
            serde_json::from_value(
                response
                    .get("ok")
                    .cloned()
                    .ok_or("Invalid SCP metadata response")?,
            )
            .map_err(|e| e.to_string())
        };
        tokio::time::timeout(Duration::from_secs(30), operation)
            .await
            .map_err(|_| "SCP metadata timed out")?
    }

    pub(super) async fn scp_read_bytes(&self, path: &str, limit: u64) -> Result<Vec<u8>, String> {
        let command = format!(
            "python3 -c {} {}",
            quote(
                "import sys; f=open(sys.argv[1], 'rb'); sys.stdout.buffer.write(f.read(int(sys.argv[2])+1))"
            )?,
            quote(path)?
        );
        let mut stream = self.scp_stream(&format!("{command} {limit}")).await?;
        stream.shutdown().await.map_err(|e| e.to_string())?;
        let mut data = Vec::new();
        tokio::time::timeout(
            Duration::from_secs(30),
            stream.take(limit.saturating_add(1)).read_to_end(&mut data),
        )
        .await
        .map_err(|_| "SCP preview timed out")?
        .map_err(|e| e.to_string())?;
        if data.len() as u64 > limit {
            return Err("File grew beyond preview limit".into());
        }
        Ok(data)
    }

    pub(super) async fn scp_write_bytes(&self, path: &str, data: &[u8]) -> Result<(), String> {
        let path = if path.starts_with('/') {
            path.to_string()
        } else {
            format!("./{path}")
        };
        let operation = async {
            let mut stream = self
                .scp_stream(&format!("scp -t {}", quote(&path)?))
                .await?;
            ack(&mut stream).await?;
            stream
                .write_all(format!("C0644 {} payload\n", data.len()).as_bytes())
                .await
                .map_err(|e| e.to_string())?;
            ack(&mut stream).await?;
            stream.write_all(data).await.map_err(|e| e.to_string())?;
            stream.write_all(&[0]).await.map_err(|e| e.to_string())?;
            ack(&mut stream).await
        };
        tokio::time::timeout(Duration::from_secs(30), operation)
            .await
            .map_err(|_| "SCP save timed out")?
    }

    fn scp_chunk_size(&self) -> usize {
        if self
            .reconnect
            .as_ref()
            .is_some_and(|p| p.network.ssh_browser == "scp-fast")
        {
            256 * 1024
        } else {
            32 * 1024
        }
    }

    pub(super) async fn scp_upload(
        &self,
        local: &Path,
        remote: &str,
        progress: Progress<'_>,
    ) -> Result<(), String> {
        let mut input = tokio::fs::File::open(local)
            .await
            .map_err(|e| e.to_string())?;
        let size = input.metadata().await.map_err(|e| e.to_string())?.len();
        let temporary = format!("{remote}.taomni-scp-{}.part", uuid::Uuid::new_v4());
        let operation = async {
            // Prefix relative paths to keep leading '-' from becoming an option.
            let path = if temporary.starts_with('/') {
                temporary.clone()
            } else {
                format!("./{temporary}")
            };
            let mut stream = self
                .scp_stream(&format!("scp -t {}", quote(&path)?))
                .await?;
            ack(&mut stream).await?;
            stream
                .write_all(format!("C0644 {size} payload\n").as_bytes())
                .await
                .map_err(|e| e.to_string())?;
            ack(&mut stream).await?;
            let mut buffer = vec![0; self.scp_chunk_size()];
            let mut remaining = size;
            while remaining > 0 {
                progress.ready().await?;
                let length = buffer.len().min(remaining as usize);
                let count = input
                    .read(&mut buffer[..length])
                    .await
                    .map_err(|e| e.to_string())?;
                if count == 0 {
                    return Err("Local file changed during SCP upload".into());
                }
                stream
                    .write_all(&buffer[..count])
                    .await
                    .map_err(|e| e.to_string())?;
                remaining -= count as u64;
                progress.advance(count);
            }
            stream.write_all(&[0]).await.map_err(|e| e.to_string())?;
            ack(&mut stream).await?;
            stream.shutdown().await.map_err(|e| e.to_string())?;
            self.scp_metadata::<()>("rename", serde_json::json!([temporary, remote]))
                .await
        };
        self.scp_cancellable(operation, progress.handle).await
    }

    pub(super) async fn scp_download(
        &self,
        remote: &str,
        local: &Path,
        progress: Progress<'_>,
    ) -> Result<(), String> {
        if let Some(parent) = local.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| e.to_string())?;
        }
        let mut temporary = local.as_os_str().to_os_string();
        temporary.push(format!(".taomni-scp-{}.part", uuid::Uuid::new_v4()));
        let temporary = std::path::PathBuf::from(temporary);
        let operation = async {
            let path = if remote.starts_with('/') {
                remote.to_string()
            } else {
                format!("./{remote}")
            };
            let mut stream = self
                .scp_stream(&format!("scp -f {}", quote(&path)?))
                .await?;
            stream.write_all(&[0]).await.map_err(|e| e.to_string())?;
            let header = line(&mut stream).await?;
            let size = parse_file_header(&header)?;
            let mut output = tokio::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
                .await
                .map_err(|e| e.to_string())?;
            stream.write_all(&[0]).await.map_err(|e| e.to_string())?;
            let mut remaining = size;
            let mut buffer = vec![0; self.scp_chunk_size()];
            while remaining > 0 {
                progress.ready().await?;
                let length = buffer.len().min(remaining as usize);
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
            output.sync_all().await.map_err(|e| e.to_string())?;
            drop(output);
            tokio::fs::rename(&temporary, local)
                .await
                .map_err(|e| e.to_string())
        };
        self.scp_cancellable(operation, progress.handle).await
    }

    async fn scp_cancellable<T>(
        &self,
        operation: impl std::future::Future<Output = Result<T, String>>,
        handle: &TransferHandle,
    ) -> Result<T, String> {
        tokio::pin!(operation);
        loop {
            tokio::select! {
                result = &mut operation => return result,
                _ = tokio::time::sleep(Duration::from_millis(50)) => {
                    if handle.is_cancelled() { return Err("transfer cancelled; partial data retained".into()); }
                }
            }
        }
    }
}

fn parse_file_header(header: &[u8]) -> Result<u64, String> {
    if header.first() != Some(&b'C') {
        return Err(format!(
            "Expected SCP file header: {}",
            String::from_utf8_lossy(header)
        ));
    }
    let text = std::str::from_utf8(&header[1..]).map_err(|_| "Invalid SCP header")?;
    let mut parts = text.splitn(3, ' ');
    let mode = parts.next().ok_or("Missing SCP mode")?;
    if mode.len() != 4 || !mode.bytes().all(|b| (b'0'..=b'7').contains(&b)) {
        return Err("Invalid SCP mode".into());
    }
    let size = parts
        .next()
        .ok_or("Missing SCP length")?
        .parse()
        .map_err(|_| "Invalid SCP length")?;
    let name = parts.next().ok_or("Missing SCP filename")?;
    if name.is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\\') {
        return Err("Unsafe SCP filename".into());
    }
    Ok(size)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_malformed_lengths_and_server_selected_paths() {
        assert_eq!(parse_file_header(b"C0644 3 a b.txt").unwrap(), 3);
        for header in [
            b"C0644 3 ../escape".as_slice(),
            b"C0644 -1 file",
            b"D0755 0 dir",
            b"C9999 1 file",
        ] {
            assert!(parse_file_header(header).is_err());
        }
        assert_eq!(quote("a'; rm x").unwrap(), "'a'\\''; rm x'");
        assert!(quote("a\0b").is_err());
    }
}
