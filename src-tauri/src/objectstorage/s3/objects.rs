use super::client::S3Client;
use super::limits::SIGN_TTL;
use super::metadata::encode_key_path;
use super::metadata::folder_marker_key;
use super::metadata::move_prefix_plan;
use super::metadata::parse_http_date;
use super::response::net_err;
use super::response::parse_s3_error;
use crate::objectstorage::types::ObjectMetadata;
use jiff::Timestamp;
use rusty_s3::Method;
use rusty_s3::S3Action;
use std::time::Duration;

impl S3Client {
    pub async fn get_object_bytes(&self, bucket: &str, key: &str) -> Result<Vec<u8>, String> {
        let b = self.bucket(bucket)?;
        let url = b.get_object(Some(&self.creds), key).sign(SIGN_TTL);
        let resp = self.http.get(url).send().await.map_err(net_err)?;
        let resp = self.check(resp).await?;
        Ok(resp.bytes().await.map_err(net_err)?.to_vec())
    }

    /// HEAD an object and build its metadata from the response headers.
    pub async fn head_object(&self, bucket: &str, key: &str) -> Result<ObjectMetadata, String> {
        let b = self.bucket(bucket)?;
        let url = b.head_object(Some(&self.creds), key).sign(SIGN_TTL);
        let resp = self.http.head(url).send().await.map_err(net_err)?;
        let resp = self.check(resp).await?;
        let h = resp.headers();
        let get = |name: &str| {
            h.get(name)
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string())
        };
        let mut user_metadata = std::collections::BTreeMap::new();
        for (name, value) in h.iter() {
            if let Some(k) = name.as_str().strip_prefix("x-amz-meta-") {
                if let Ok(v) = value.to_str() {
                    user_metadata.insert(k.to_ascii_lowercase(), v.to_string());
                }
            }
        }
        Ok(ObjectMetadata {
            key: key.to_string(),
            size: get("content-length")
                .and_then(|s| s.parse().ok())
                .unwrap_or(0),
            content_type: get("content-type"),
            etag: get("etag").map(|e| e.trim_matches('"').to_string()),
            last_modified: get("last-modified").as_deref().and_then(parse_http_date),
            storage_class: get("x-amz-storage-class"),
            cache_control: get("cache-control"),
            content_encoding: get("content-encoding"),
            content_disposition: get("content-disposition"),
            user_metadata,
        })
    }

    pub async fn put_object_bytes(
        &self,
        bucket: &str,
        key: &str,
        body: Vec<u8>,
    ) -> Result<(), String> {
        let content_length = body.len();
        let b = self.bucket(bucket)?;
        let url = b.put_object(Some(&self.creds), key).sign(SIGN_TTL);
        let resp = self
            .http
            .put(url)
            .header(reqwest::header::CONTENT_LENGTH, content_length.to_string())
            .body(body)
            .send()
            .await
            .map_err(net_err)?;
        self.check(resp).await?;
        Ok(())
    }

    pub async fn delete_object(&self, bucket: &str, key: &str) -> Result<(), String> {
        let b = self.bucket(bucket)?;
        let url = b.delete_object(Some(&self.creds), key).sign(SIGN_TTL);
        let resp = self.http.delete(url).send().await.map_err(net_err)?;
        self.check(resp).await?;
        Ok(())
    }

    /// Server-side copy, including across buckets. rusty-s3 has no copy action,
    /// so we sign a PUT on the destination with the `x-amz-copy-source` header
    /// included in the signature, then send that exact header.
    pub async fn copy_object(
        &self,
        src_bucket: &str,
        src_key: &str,
        dst_bucket: &str,
        dst_key: &str,
    ) -> Result<(), String> {
        let dest = self.bucket(dst_bucket)?;
        let dest_url = dest
            .object_url(dst_key)
            .map_err(|e| format!("invalid destination key '{dst_key}': {e}"))?;
        let copy_source = format!("/{}/{}", src_bucket, encode_key_path(src_key));
        let signed = rusty_s3::signing::sign(
            &Timestamp::now(),
            Method::Put,
            dest_url,
            self.creds.key(),
            self.creds.secret(),
            self.creds.token(),
            &self.region,
            SIGN_TTL.as_secs(),
            std::iter::empty::<(&str, &str)>(),
            std::iter::once(("x-amz-copy-source", copy_source.as_str())),
        );
        let resp = self
            .http
            .put(signed)
            .header("x-amz-copy-source", &copy_source)
            .send()
            .await
            .map_err(net_err)?;
        let resp = self.check(resp).await?;
        // S3 can report a copy failure in a 200 response body. Surface it.
        let body = resp.text().await.unwrap_or_default();
        if body.contains("<Error") {
            let msg = parse_s3_error(&body).unwrap_or_else(|| "copy failed".into());
            return Err(format!("S3 copy error: {msg}"));
        }
        Ok(())
    }

    /// Recursively delete everything under `prefix` (its objects and the folder
    /// marker). Lists all keys (no delimiter) then deletes with bounded
    /// concurrency — robust across S3-compatible providers that lack the batch
    /// DeleteObjects API.
    pub async fn delete_prefix(&self, bucket: &str, prefix: &str) -> Result<(), String> {
        use futures::stream::{self, StreamExt};
        let marker = folder_marker_key(prefix);
        let mut keys = self.list_all_keys(bucket, &marker).await?;
        if !marker.is_empty() && !keys.iter().any(|k| k == &marker) {
            keys.push(marker);
        }
        keys.sort();
        keys.dedup();
        let results: Vec<Result<(), String>> = stream::iter(keys.into_iter().map(|k| {
            let bucket = bucket.to_string();
            async move { self.delete_object(&bucket, &k).await }
        }))
        .buffer_unordered(16)
        .collect()
        .await;
        for r in results {
            r?;
        }
        Ok(())
    }

    /// Rename a virtual folder by copying every object under the old prefix,
    /// including its zero-byte folder marker, then deleting the originals.
    /// Copies are completed first so a failed copy never removes source data.
    pub async fn move_prefix(
        &self,
        bucket: &str,
        old_prefix: &str,
        new_prefix: &str,
    ) -> Result<(), String> {
        let old_prefix = folder_marker_key(old_prefix);
        let new_prefix = folder_marker_key(new_prefix);
        if old_prefix.is_empty() || new_prefix.is_empty() {
            return Err("folder prefixes must not be empty".into());
        }
        if old_prefix == new_prefix {
            return Ok(());
        }
        let keys = self.list_all_keys(bucket, &old_prefix).await?;
        if keys.is_empty() {
            return Err(format!("folder prefix '{old_prefix}' does not exist"));
        }

        let plan = move_prefix_plan(&old_prefix, &new_prefix, keys)?;
        for (src, dst) in &plan {
            self.copy_object(bucket, src, bucket, dst).await?;
        }
        for (src, _) in &plan {
            self.delete_object(bucket, src).await?;
        }
        Ok(())
    }

    /// Create a folder by writing a zero-byte object whose key ends in '/'.
    pub async fn create_folder(&self, bucket: &str, prefix: &str) -> Result<(), String> {
        let key = folder_marker_key(prefix);
        self.put_object_bytes(bucket, &key, Vec::new()).await
    }

    /// Generate a presigned GET URL valid for `ttl_secs` seconds — a shareable
    /// download link that needs no further credentials.
    pub fn presign_get(&self, bucket: &str, key: &str, ttl_secs: u64) -> Result<String, String> {
        let b = self.bucket(bucket)?;
        let url = b
            .get_object(Some(&self.creds), key)
            .sign(Duration::from_secs(ttl_secs));
        Ok(url.to_string())
    }
}
