use super::client::S3Client;
use super::limits::SIGN_TTL;
use super::limits::UPLOAD_RETRY_BASE_DELAY;
use super::limits::UPLOAD_SEND_ATTEMPTS;
use super::response::confirmed_part_etag_from_xml;
use super::response::net_err;
use super::response::parse_s3_error;
use crate::filebrowser::transfer::TransferHandle;
use crate::objectstorage::types::ObjectMetadata;
use rusty_s3::Bucket;
use rusty_s3::S3Action;
use rusty_s3::actions::CreateMultipartUpload;
use rusty_s3::actions::ListParts;
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;
use tauri::AppHandle;
use tauri::Runtime;

impl S3Client {
    /// Upload a local file. Small files go in one PUT; large files use a
    /// multipart upload (aborted on failure), emitting progress per part.
    /// `storage_class`, when set, is applied via a signed `x-amz-storage-class`
    /// header (on the PUT, or the multipart create for large files).
    pub async fn upload_from_file<R: Runtime>(
        &self,
        local: &Path,
        bucket: &str,
        key: &str,
        storage_class: Option<&str>,
        transfer_id: &str,
        handle: &Arc<TransferHandle>,
        app: &AppHandle<R>,
    ) -> Result<(), String> {
        use super::super::transfer::{MULTIPART_THRESHOLD, emit_progress};
        let total = tokio::fs::metadata(local)
            .await
            .map_err(|e| format!("stat {}: {e}", local.display()))?
            .len();
        let b = self.bucket(bucket)?;
        let started = Instant::now();
        emit_progress(app, transfer_id, 0, total, started);

        if total <= MULTIPART_THRESHOLD {
            let data = tokio::fs::read(local)
                .await
                .map_err(|e| format!("read {}: {e}", local.display()))?;
            self.upload_small_object(&b, bucket, key, &data, storage_class, handle)
                .await?;
            emit_progress(app, transfer_id, total, total, started);
            return Ok(());
        }

        let mut create = b.create_multipart_upload(Some(&self.creds), key);
        if let Some(sc) = storage_class {
            create
                .headers_mut()
                .insert("x-amz-storage-class", sc.to_string());
        }
        let create_url = create.sign(SIGN_TTL);
        let mut create_req = self.http.post(create_url);
        if let Some(sc) = storage_class {
            create_req = create_req.header("x-amz-storage-class", sc);
        }
        let resp = create_req.send().await.map_err(net_err)?;
        let resp = self.check(resp).await?;
        let body = resp.bytes().await.map_err(net_err)?;
        let upload_id = CreateMultipartUpload::parse_response(&body)
            .map_err(|e| format!("parse multipart create: {e}"))?
            .upload_id()
            .to_string();

        match self
            .upload_parts(
                &b,
                key,
                &upload_id,
                local,
                total,
                transfer_id,
                handle,
                app,
                started,
            )
            .await
        {
            Ok(etags) => {
                self.complete_multipart_with_recovery(&b, bucket, key, &upload_id, &etags, total)
                    .await?;
                emit_progress(app, transfer_id, total, total, started);
                Ok(())
            }
            Err(e) => {
                let aurl = b
                    .abort_multipart_upload(Some(&self.creds), key, &upload_id)
                    .sign(SIGN_TTL);
                let _ = self.http.delete(aurl).send().await;
                Err(e)
            }
        }
    }

    /// Read the file in `PART_SIZE` chunks and upload each as a numbered part,
    /// returning the part ETags in order. Honors pause/cancel.
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn upload_parts<R: Runtime>(
        &self,
        b: &Bucket,
        key: &str,
        upload_id: &str,
        local: &Path,
        total: u64,
        transfer_id: &str,
        handle: &Arc<TransferHandle>,
        app: &AppHandle<R>,
        started: Instant,
    ) -> Result<Vec<String>, String> {
        use super::super::transfer::{PART_SIZE, emit_paused, emit_progress, read_full};
        let mut file = tokio::fs::File::open(local)
            .await
            .map_err(|e| format!("open {}: {e}", local.display()))?;
        let mut etags: Vec<String> = Vec::new();
        let mut buf = vec![0u8; PART_SIZE];
        let mut part_number: u16 = 1;
        let mut uploaded: u64 = 0;
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
            let etag = self
                .upload_part_with_recovery(b, key, upload_id, part_number, &buf[..n], handle)
                .await
                .map_err(|e| format!("upload part {part_number}: {e}"))?;
            etags.push(etag);
            uploaded += n as u64;
            // Multipart progress is server-confirmed. Reporting bytes while
            // reqwest consumes the body only measures client-side buffering
            // and can jump to a full part before anything reaches the server.
            emit_progress(app, transfer_id, uploaded, total, started);
            part_number += 1;
        }
        Ok(etags)
    }

    pub(super) async fn upload_small_object(
        &self,
        b: &Bucket,
        bucket: &str,
        key: &str,
        data: &[u8],
        storage_class: Option<&str>,
        handle: &Arc<TransferHandle>,
    ) -> Result<(), String> {
        let before = self.head_object(bucket, key).await.ok();
        for attempt in 1..=UPLOAD_SEND_ATTEMPTS {
            if handle.is_cancelled() {
                return Err("transfer cancelled".to_string());
            }
            let mut put = b.put_object(Some(&self.creds), key);
            if let Some(sc) = storage_class {
                put.headers_mut()
                    .insert("x-amz-storage-class", sc.to_string());
            }
            let mut request = self
                .http
                .put(put.sign(SIGN_TTL))
                .header(reqwest::header::CONTENT_LENGTH, data.len())
                .body(data.to_vec());
            if let Some(sc) = storage_class {
                request = request.header("x-amz-storage-class", sc);
            }
            match request.send().await {
                Ok(response) => {
                    self.check(response).await?;
                    return Ok(());
                }
                Err(error) => {
                    let safe_error = net_err(error);
                    if self
                        .object_put_was_committed(bucket, key, data.len() as u64, before.as_ref())
                        .await
                    {
                        tracing::warn!(
                            attempt,
                            "object PUT response was lost, but HEAD confirmed the upload"
                        );
                        return Ok(());
                    }
                    if attempt == UPLOAD_SEND_ATTEMPTS || handle.is_cancelled() {
                        return Err(format!(
                            "upload transport failed after {attempt} attempts: {safe_error}"
                        ));
                    }
                    let delay = UPLOAD_RETRY_BASE_DELAY * attempt;
                    tracing::warn!(
                        attempt,
                        max_attempts = UPLOAD_SEND_ATTEMPTS,
                        delay_ms = delay.as_millis(),
                        error = %safe_error,
                        "retrying object-storage upload after transport failure"
                    );
                    tokio::time::sleep(delay).await;
                }
            }
        }
        unreachable!("upload retry loop always returns")
    }

    pub(super) async fn object_put_was_committed(
        &self,
        bucket: &str,
        key: &str,
        expected_size: u64,
        before: Option<&ObjectMetadata>,
    ) -> bool {
        let Ok(after) = self.head_object(bucket, key).await else {
            return false;
        };
        if after.size != expected_size {
            return false;
        }
        match before {
            None => true,
            Some(previous) => {
                after.etag != previous.etag || after.last_modified != previous.last_modified
            }
        }
    }

    pub(super) async fn upload_part_with_recovery(
        &self,
        b: &Bucket,
        key: &str,
        upload_id: &str,
        part_number: u16,
        data: &[u8],
        handle: &Arc<TransferHandle>,
    ) -> Result<String, String> {
        for attempt in 1..=UPLOAD_SEND_ATTEMPTS {
            if handle.is_cancelled() {
                return Err("transfer cancelled".to_string());
            }
            let url = b
                .upload_part(Some(&self.creds), key, part_number, upload_id)
                .sign(SIGN_TTL);
            match self
                .http
                .put(url)
                .header(reqwest::header::CONTENT_LENGTH, data.len())
                .body(data.to_vec())
                .send()
                .await
            {
                Ok(response) => {
                    let response = self.check(response).await?;
                    return response
                        .headers()
                        .get("etag")
                        .and_then(|v| v.to_str().ok())
                        .map(str::to_string)
                        .ok_or_else(|| "uploaded part missing ETag".to_string());
                }
                Err(error) => {
                    let safe_error = net_err(error);
                    if let Some(etag) = self
                        .confirmed_part_etag(b, key, upload_id, part_number, data.len() as u64)
                        .await
                    {
                        tracing::warn!(
                            attempt,
                            part_number,
                            "UploadPart response was lost, but ListParts confirmed the part"
                        );
                        return Ok(etag);
                    }
                    if attempt == UPLOAD_SEND_ATTEMPTS || handle.is_cancelled() {
                        return Err(format!(
                            "upload transport failed after {attempt} attempts: {safe_error}"
                        ));
                    }
                    let delay = UPLOAD_RETRY_BASE_DELAY * attempt;
                    tracing::warn!(
                        attempt,
                        max_attempts = UPLOAD_SEND_ATTEMPTS,
                        part_number,
                        delay_ms = delay.as_millis(),
                        error = %safe_error,
                        "retrying UploadPart after transport failure"
                    );
                    tokio::time::sleep(delay).await;
                }
            }
        }
        unreachable!("upload retry loop always returns")
    }

    pub(super) async fn confirmed_part_etag(
        &self,
        b: &Bucket,
        key: &str,
        upload_id: &str,
        part_number: u16,
        expected_size: u64,
    ) -> Option<String> {
        let mut list = ListParts::new(b, Some(&self.creds), key, upload_id);
        list.set_max_parts(1);
        if part_number > 1 {
            list.set_part_number_marker(part_number - 1);
        }
        let body = self.get_text(list.sign(SIGN_TTL)).await.ok()?;
        confirmed_part_etag_from_xml(&body, part_number, expected_size)
    }

    pub(super) async fn complete_multipart_with_recovery(
        &self,
        b: &Bucket,
        bucket: &str,
        key: &str,
        upload_id: &str,
        etags: &[String],
        expected_size: u64,
    ) -> Result<(), String> {
        for attempt in 1..=UPLOAD_SEND_ATTEMPTS {
            let etag_refs: Vec<&str> = etags.iter().map(String::as_str).collect();
            let complete = b.complete_multipart_upload(
                Some(&self.creds),
                key,
                upload_id,
                etag_refs.iter().copied(),
            );
            let response = self
                .http
                .post(complete.sign(SIGN_TTL))
                .body(complete.body())
                .send()
                .await;
            match response {
                Ok(response) => {
                    let response = self.check(response).await?;
                    let text = response.text().await.unwrap_or_default();
                    if text.contains("<Error") {
                        let message =
                            parse_s3_error(&text).unwrap_or_else(|| "complete failed".into());
                        return Err(format!("S3 complete multipart error: {message}"));
                    }
                    return Ok(());
                }
                Err(error) => {
                    let safe_error = net_err(error);
                    if self
                        .head_object(bucket, key)
                        .await
                        .is_ok_and(|object| object.size == expected_size)
                    {
                        tracing::warn!(
                            attempt,
                            "CompleteMultipartUpload response was lost, but HEAD confirmed the object"
                        );
                        return Ok(());
                    }
                    if attempt == UPLOAD_SEND_ATTEMPTS {
                        return Err(format!(
                            "complete multipart failed after {attempt} attempts: {safe_error}"
                        ));
                    }
                    let delay = UPLOAD_RETRY_BASE_DELAY * attempt;
                    tracing::warn!(
                        attempt,
                        max_attempts = UPLOAD_SEND_ATTEMPTS,
                        delay_ms = delay.as_millis(),
                        error = %safe_error,
                        "retrying CompleteMultipartUpload after transport failure"
                    );
                    tokio::time::sleep(delay).await;
                }
            }
        }
        unreachable!("complete retry loop always returns")
    }
}
