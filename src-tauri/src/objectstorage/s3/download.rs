use super::client::S3Client;
use super::limits::SIGN_TTL;
use super::response::net_err;
use crate::filebrowser::transfer::TransferHandle;
use rusty_s3::S3Action;
use std::path::Path;
use std::sync::Arc;
use tauri::AppHandle;
use tauri::Runtime;

impl S3Client {
    /// Stream an object to a local file, emitting progress.
    pub async fn download_to_file<R: Runtime>(
        &self,
        bucket: &str,
        key: &str,
        dest: &Path,
        transfer_id: &str,
        handle: &Arc<TransferHandle>,
        app: &AppHandle<R>,
    ) -> Result<(), String> {
        let b = self.bucket(bucket)?;
        let url = b.get_object(Some(&self.creds), key).sign(SIGN_TTL);
        let resp = self.http.get(url).send().await.map_err(net_err)?;
        let resp = self.check(resp).await?;
        let total = resp.content_length().unwrap_or(0);
        super::super::transfer::stream_to_file(resp, total, dest, transfer_id, handle, app).await
    }
}
