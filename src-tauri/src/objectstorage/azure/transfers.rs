use super::client::AzureClient;
use super::metadata::block_id;
use crate::filebrowser::transfer::TransferHandle;
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;
use tauri::AppHandle;
use tauri::Runtime;

impl AzureClient {
    /// Stream a blob to a local file, emitting progress.
    pub async fn download_to_file<R: Runtime>(
        &self,
        container: &str,
        key: &str,
        dest: &Path,
        transfer_id: &str,
        handle: &Arc<TransferHandle>,
        app: &AppHandle<R>,
    ) -> Result<(), String> {
        let url = self.build(&format!("{container}/{key}"), &[]);
        let resp = self
            .send(reqwest::Method::GET, url, None, &[], None)
            .await?;
        let total = resp.content_length().unwrap_or(0);
        super::super::transfer::stream_to_file(resp, total, dest, transfer_id, handle, app).await
    }

    /// Upload a local file. Small files go in one Put Blob; large files are
    /// staged as blocks then committed with Put Block List, emitting progress
    /// per block. `access_tier`, when set (`Hot`/`Cool`/`Cold`/`Archive`), is
    /// applied via `x-ms-access-tier`.
    pub async fn upload_from_file<R: Runtime>(
        &self,
        local: &Path,
        container: &str,
        key: &str,
        access_tier: Option<&str>,
        transfer_id: &str,
        handle: &Arc<TransferHandle>,
        app: &AppHandle<R>,
    ) -> Result<(), String> {
        use super::super::transfer::{
            MULTIPART_THRESHOLD, PART_SIZE, emit_paused, emit_progress, read_full,
        };
        let total = tokio::fs::metadata(local)
            .await
            .map_err(|e| format!("stat {}: {e}", local.display()))?
            .len();
        let started = Instant::now();
        emit_progress(app, transfer_id, 0, total, started);

        if total <= MULTIPART_THRESHOLD {
            let data = tokio::fs::read(local)
                .await
                .map_err(|e| format!("read {}: {e}", local.display()))?;
            let url = self.build(&format!("{container}/{key}"), &[]);
            let mut ms_headers: Vec<(&str, &str)> = vec![("x-ms-blob-type", "BlockBlob")];
            if let Some(tier) = access_tier {
                ms_headers.push(("x-ms-access-tier", tier));
            }
            self.send(
                reqwest::Method::PUT,
                url,
                Some(data),
                &ms_headers,
                Some("application/octet-stream"),
            )
            .await?;
            emit_progress(app, transfer_id, total, total, started);
            return Ok(());
        }

        let mut file = tokio::fs::File::open(local)
            .await
            .map_err(|e| format!("open {}: {e}", local.display()))?;
        let mut buf = vec![0u8; PART_SIZE];
        let mut block_ids: Vec<String> = Vec::new();
        let mut uploaded: u64 = 0;
        let mut index: u32 = 0;
        loop {
            if handle.is_cancelled() {
                return Err("transfer cancelled".to_string());
            }
            if handle.is_paused() {
                emit_paused(app, transfer_id, uploaded, total);
                handle.wait_while_paused().await;
                if handle.is_cancelled() {
                    return Err("transfer cancelled".to_string());
                }
            }
            let n = read_full(&mut file, &mut buf).await?;
            if n == 0 {
                break;
            }
            let id = block_id(index);
            let url = self.build(
                &format!("{container}/{key}"),
                &[("comp", "block"), ("blockid", id.as_str())],
            );
            self.send(
                reqwest::Method::PUT,
                url,
                Some(buf[..n].to_vec()),
                &[],
                None,
            )
            .await?;
            block_ids.push(id);
            uploaded += n as u64;
            emit_progress(app, transfer_id, uploaded, total, started);
            index += 1;
        }

        let mut xml = String::from("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<BlockList>\n");
        for id in &block_ids {
            xml.push_str("  <Latest>");
            xml.push_str(id);
            xml.push_str("</Latest>\n");
        }
        xml.push_str("</BlockList>");
        let url = self.build(&format!("{container}/{key}"), &[("comp", "blocklist")]);
        let mut ms_headers: Vec<(&str, &str)> = Vec::new();
        if let Some(tier) = access_tier {
            ms_headers.push(("x-ms-access-tier", tier));
        }
        self.send(
            reqwest::Method::PUT,
            url,
            Some(xml.into_bytes()),
            &ms_headers,
            Some("application/xml"),
        )
        .await?;
        emit_progress(app, transfer_id, total, total, started);
        Ok(())
    }
}
