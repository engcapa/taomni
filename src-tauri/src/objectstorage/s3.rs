//! S3-family engine: builds and signs requests with rusty-s3 (sans-IO) and
//! executes them over reqwest. Covers AWS S3 and any S3-compatible provider.
//! Service-level ListBuckets — which rusty-s3 has no action for — is signed
//! directly via `rusty_s3::signing::sign`.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;

use jiff::Timestamp;
use reqwest::Client;
use rusty_s3::actions::{CreateMultipartUpload, ListObjectsV2, ListObjectsV2Response};
use rusty_s3::{Bucket, Credentials, Method, S3Action, UrlStyle};
use serde::Deserialize;
use tauri::{AppHandle, Runtime};
use url::Url;

use super::types::{BucketEntry, ObjectEntry, ObjectListPage, ObjectMetadata};
use crate::filebrowser::transfer::TransferHandle;

/// Presign lifetime for one-shot signed requests. Requests are issued
/// immediately, so a short window is plenty.
const SIGN_TTL: Duration = Duration::from_secs(300);

pub struct S3Client {
    http: Client,
    creds: Credentials,
    endpoint: Url,
    region: String,
    style: UrlStyle,
}

impl S3Client {
    pub fn new(
        http: Client,
        creds: Credentials,
        endpoint: Url,
        region: String,
        style: UrlStyle,
    ) -> Self {
        Self {
            http,
            creds,
            endpoint,
            region,
            style,
        }
    }

    fn bucket(&self, name: &str) -> Result<Bucket, String> {
        Bucket::new(
            self.endpoint.clone(),
            self.style,
            name.to_string(),
            self.region.clone(),
        )
        .map_err(|e| format!("invalid bucket '{name}': {e}"))
    }

    /// Service-level: list all buckets. rusty-s3 has no action for this, so we
    /// sign a GET on the service root directly and parse the XML ourselves.
    pub async fn list_buckets(&self) -> Result<Vec<BucketEntry>, String> {
        let signed = rusty_s3::signing::sign(
            &Timestamp::now(),
            Method::Get,
            self.endpoint.clone(),
            self.creds.key(),
            self.creds.secret(),
            self.creds.token(),
            &self.region,
            SIGN_TTL.as_secs(),
            std::iter::empty::<(&str, &str)>(),
            std::iter::empty::<(&str, &str)>(),
        );
        let body = self.get_text(signed).await?;
        let parsed: ListAllMyBucketsResult = quick_xml::de::from_str(&body)
            .map_err(|e| format!("parse ListBuckets response: {e}"))?;
        Ok(parsed
            .buckets
            .bucket
            .into_iter()
            .map(|b| BucketEntry {
                name: b.name,
                created_at: b.creation_date.as_deref().and_then(parse_iso8601),
                region: None,
            })
            .collect())
    }

    /// List one page of objects under `prefix`, using `/` as the delimiter so
    /// sub-prefixes surface as folders. `continuation` resumes a truncated
    /// listing; the returned `next_token` drives lazy pagination.
    pub async fn list_objects(
        &self,
        bucket: &str,
        prefix: &str,
        continuation: Option<&str>,
        max_keys: usize,
    ) -> Result<ObjectListPage, String> {
        let b = self.bucket(bucket)?;
        let mut action = b.list_objects_v2(Some(&self.creds));
        action.with_delimiter("/");
        if !prefix.is_empty() {
            action.with_prefix(prefix.to_string());
        }
        if let Some(t) = continuation {
            action.with_continuation_token(t.to_string());
        }
        action.with_max_keys(max_keys);
        let url = action.sign(SIGN_TTL);
        let body = self.get_text(url).await?;
        let resp = ListObjectsV2::parse_response(body.as_bytes())
            .map_err(|e| format!("parse ListObjectsV2 response: {e}"))?;

        let page = Self::list_response_to_page(prefix, resp);
        Ok(page)
    }

    fn list_response_to_page(prefix: &str, resp: ListObjectsV2Response) -> ObjectListPage {
        let mut entries = Vec::with_capacity(resp.common_prefixes.len() + resp.contents.len());
        for cp in resp.common_prefixes {
            let key = decode_list_value(&cp.prefix);
            let trimmed = key.trim_end_matches('/');
            let name = trimmed.rsplit('/').next().unwrap_or(trimmed).to_string();
            entries.push(ObjectEntry {
                name,
                key,
                is_dir: true,
                size: 0,
                last_modified: None,
                etag: None,
                storage_class: None,
            });
        }
        for c in resp.contents {
            let key = decode_list_value(&c.key);
            // Skip the zero-byte folder marker that equals the prefix itself.
            if key == prefix {
                continue;
            }
            if let Some(entry) = folder_marker_entry(prefix, &key, c.size) {
                if !entries.iter().any(|e| e.is_dir && e.key == entry.key) {
                    entries.push(entry);
                }
                continue;
            }
            let name = key.strip_prefix(prefix).unwrap_or(&key).to_string();
            entries.push(ObjectEntry {
                name,
                key,
                is_dir: false,
                size: c.size,
                last_modified: parse_iso8601(&c.last_modified),
                etag: Some(c.etag.trim_matches('"').to_string()),
                storage_class: c.storage_class,
            });
        }
        ObjectListPage {
            entries,
            next_token: resp.next_continuation_token,
        }
    }
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

    /// Page through every object key under `prefix` (no delimiter, so nested
    /// keys are included).
    async fn list_all_keys(&self, bucket: &str, prefix: &str) -> Result<Vec<String>, String> {
        let b = self.bucket(bucket)?;
        let mut keys = Vec::new();
        let mut token: Option<String> = None;
        loop {
            let mut action = b.list_objects_v2(Some(&self.creds));
            if !prefix.is_empty() {
                action.with_prefix(prefix.to_string());
            }
            if let Some(t) = &token {
                action.with_continuation_token(t.clone());
            }
            action.with_max_keys(1000);
            let url = action.sign(SIGN_TTL);
            let body = self.get_text(url).await?;
            let resp = ListObjectsV2::parse_response(body.as_bytes())
                .map_err(|e| format!("parse ListObjectsV2 response: {e}"))?;
            keys.extend(resp.contents.into_iter().map(|c| decode_list_value(&c.key)));
            match resp.next_continuation_token {
                Some(t) => token = Some(t),
                None => break,
            }
        }
        Ok(keys)
    }

    /// Create a folder by writing a zero-byte object whose key ends in '/'.
    pub async fn create_folder(&self, bucket: &str, prefix: &str) -> Result<(), String> {
        let key = folder_marker_key(prefix);
        self.put_object_bytes(bucket, &key, Vec::new()).await
    }

    pub async fn create_bucket(&self, bucket: &str) -> Result<(), String> {
        let b = self.bucket(bucket)?;
        let url = b.create_bucket(&self.creds).sign(SIGN_TTL);
        let resp = self.http.put(url).send().await.map_err(net_err)?;
        self.check(resp).await?;
        Ok(())
    }

    pub async fn delete_bucket(&self, bucket: &str) -> Result<(), String> {
        let b = self.bucket(bucket)?;
        let url = b.delete_bucket(&self.creds).sign(SIGN_TTL);
        let resp = self.http.delete(url).send().await.map_err(net_err)?;
        self.check(resp).await?;
        Ok(())
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
        super::transfer::stream_to_file(resp, total, dest, transfer_id, handle, app).await
    }

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
        use super::transfer::{MULTIPART_THRESHOLD, emit_progress};
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
            let mut put = b.put_object(Some(&self.creds), key);
            if let Some(sc) = storage_class {
                put.headers_mut()
                    .insert("x-amz-storage-class", sc.to_string());
            }
            let url = put.sign(SIGN_TTL);
            let mut req = self.http.put(url).body(data);
            if let Some(sc) = storage_class {
                req = req.header("x-amz-storage-class", sc);
            }
            let resp = req.send().await.map_err(net_err)?;
            self.check(resp).await?;
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
                let etag_refs: Vec<&str> = etags.iter().map(String::as_str).collect();
                let complete = b.complete_multipart_upload(
                    Some(&self.creds),
                    key,
                    &upload_id,
                    etag_refs.iter().copied(),
                );
                let curl = complete.sign(SIGN_TTL);
                let cbody = complete.body();
                let resp = self
                    .http
                    .post(curl)
                    .body(cbody)
                    .send()
                    .await
                    .map_err(net_err)?;
                let resp = self.check(resp).await?;
                let txt = resp.text().await.unwrap_or_default();
                if txt.contains("<Error") {
                    let msg = parse_s3_error(&txt).unwrap_or_else(|| "complete failed".into());
                    return Err(format!("S3 complete multipart error: {msg}"));
                }
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
    async fn upload_parts<R: Runtime>(
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
        use super::transfer::{PART_SIZE, emit_paused, emit_progress, read_full};
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
            let purl = b
                .upload_part(Some(&self.creds), key, part_number, upload_id)
                .sign(SIGN_TTL);
            let resp = self
                .http
                .put(purl)
                .body(buf[..n].to_vec())
                .send()
                .await
                .map_err(net_err)?;
            let resp = self.check(resp).await?;
            let etag = resp
                .headers()
                .get("etag")
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string())
                .ok_or("uploaded part missing ETag")?;
            etags.push(etag);
            uploaded += n as u64;
            emit_progress(app, transfer_id, uploaded, total, started);
            part_number += 1;
        }
        Ok(etags)
    }

    /// Cheap connectivity check: HEAD the default bucket if one is configured,
    /// otherwise list buckets.
    pub async fn ping(&self, default_bucket: Option<&str>) -> Result<(), String> {
        match default_bucket {
            Some(b) if !b.is_empty() => {
                let bk = self.bucket(b)?;
                let url = bk.head_bucket(Some(&self.creds)).sign(SIGN_TTL);
                let resp = self.http.head(url).send().await.map_err(net_err)?;
                self.check(resp).await.map(|_| ())
            }
            _ => self.list_buckets().await.map(|_| ()),
        }
    }

    async fn get_text(&self, url: Url) -> Result<String, String> {
        let resp = self.http.get(url).send().await.map_err(net_err)?;
        let resp = self.check(resp).await?;
        resp.text().await.map_err(net_err)
    }

    /// Map a non-2xx response into a useful S3 error string.
    async fn check(&self, resp: reqwest::Response) -> Result<reqwest::Response, String> {
        let status = resp.status();
        if status.is_success() {
            return Ok(resp);
        }
        let body = resp.text().await.unwrap_or_default();
        let msg = parse_s3_error(&body).unwrap_or_else(|| body.chars().take(300).collect());
        Err(format!("S3 error {}: {msg}", status.as_u16()))
    }
}

fn net_err(e: reqwest::Error) -> String {
    format!("request failed: {e}")
}

/// Percent-encode each path segment of a key while preserving `/` separators
/// (for the `x-amz-copy-source` header).
fn encode_key_path(key: &str) -> String {
    key.split('/')
        .map(|seg| urlencoding::encode(seg).into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

fn folder_marker_key(prefix: &str) -> String {
    if prefix.is_empty() || prefix.ends_with('/') {
        prefix.to_string()
    } else {
        format!("{prefix}/")
    }
}

fn folder_marker_entry(prefix: &str, key: &str, size: u64) -> Option<ObjectEntry> {
    if size != 0 || !key.ends_with('/') {
        return None;
    }
    let name = key
        .strip_prefix(prefix)
        .unwrap_or(key)
        .trim_end_matches('/');
    if name.is_empty() || name.contains('/') {
        return None;
    }
    Some(ObjectEntry {
        name: name.to_string(),
        key: key.to_string(),
        is_dir: true,
        size: 0,
        last_modified: None,
        etag: None,
        storage_class: None,
    })
}

fn decode_list_value(value: &str) -> String {
    urlencoding::decode(value)
        .map(|decoded| decoded.into_owned())
        .unwrap_or_else(|_| value.to_string())
}

fn parse_iso8601(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.timestamp())
}

/// Parse an RFC 1123 HTTP date (as returned by HEAD `Last-Modified`).
fn parse_http_date(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc2822(s)
        .ok()
        .map(|dt| dt.timestamp())
        .or_else(|| {
            chrono::NaiveDateTime::parse_from_str(s, "%a, %d %b %Y %H:%M:%S GMT")
                .ok()
                .map(|dt| dt.and_utc().timestamp())
        })
}

fn parse_s3_error(body: &str) -> Option<String> {
    #[derive(Deserialize)]
    struct S3Error {
        #[serde(rename = "Code")]
        code: Option<String>,
        #[serde(rename = "Message")]
        message: Option<String>,
    }
    let e: S3Error = quick_xml::de::from_str(body).ok()?;
    match (e.code, e.message) {
        (Some(c), Some(m)) => Some(format!("{c}: {m}")),
        (Some(c), None) => Some(c),
        (None, Some(m)) => Some(m),
        _ => None,
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct ListAllMyBucketsResult {
    #[serde(default)]
    buckets: BucketsXml,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct BucketsXml {
    #[serde(default, rename = "Bucket")]
    bucket: Vec<BucketXml>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct BucketXml {
    name: String,
    creation_date: Option<String>,
}

#[cfg(test)]
mod it {
    use super::*;
    use rusty_s3::UrlStyle;

    #[test]
    fn list_objects_decodes_url_encoded_keys() {
        let input = r#"
        <?xml version="1.0" encoding="UTF-8"?>
        <ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
            <Name>bucket</Name>
            <Prefix>report%2F</Prefix>
            <KeyCount>2</KeyCount>
            <MaxKeys>1000</MaxKeys>
            <Delimiter>%2F</Delimiter>
            <IsTruncated>false</IsTruncated>
            <Contents>
                <Key>report%2F%E6%89%8B%E6%9C%BA%2BCRM.txt</Key>
                <LastModified>2026-07-07T12:00:00.000Z</LastModified>
                <ETag>"etag"</ETag>
                <Size>42</Size>
                <StorageClass>STANDARD</StorageClass>
            </Contents>
            <CommonPrefixes>
                <Prefix>report%2F%E5%AD%90%E7%9B%AE%E5%BD%95%2F</Prefix>
            </CommonPrefixes>
            <EncodingType>url</EncodingType>
        </ListBucketResult>
        "#;

        let parsed = ListObjectsV2::parse_response(input).expect("parse list response");
        let page = S3Client::list_response_to_page("report/", parsed);

        let file = page.entries.iter().find(|e| !e.is_dir).expect("file entry");
        assert_eq!(file.key, "report/手机+CRM.txt");
        assert_eq!(file.name, "手机+CRM.txt");

        let folder = page
            .entries
            .iter()
            .find(|e| e.is_dir)
            .expect("folder entry");
        assert_eq!(folder.key, "report/子目录/");
        assert_eq!(folder.name, "子目录");
    }

    #[test]
    fn list_objects_treats_zero_byte_folder_markers_as_dirs() {
        let input = r#"
        <?xml version="1.0" encoding="UTF-8"?>
        <ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
            <Name>bucket</Name>
            <Prefix></Prefix>
            <KeyCount>2</KeyCount>
            <MaxKeys>1000</MaxKeys>
            <Delimiter>/</Delimiter>
            <IsTruncated>false</IsTruncated>
            <CommonPrefixes>
                <Prefix>existing/</Prefix>
            </CommonPrefixes>
            <Contents>
                <Key>empty/</Key>
                <LastModified>2026-07-07T12:00:00.000Z</LastModified>
                <ETag>"d41d8cd98f00b204e9800998ecf8427e"</ETag>
                <Size>0</Size>
                <StorageClass>STANDARD</StorageClass>
            </Contents>
            <Contents>
                <Key>existing/</Key>
                <LastModified>2026-07-07T12:00:00.000Z</LastModified>
                <ETag>"d41d8cd98f00b204e9800998ecf8427e"</ETag>
                <Size>0</Size>
                <StorageClass>STANDARD</StorageClass>
            </Contents>
        </ListBucketResult>
        "#;

        let parsed = ListObjectsV2::parse_response(input).expect("parse list response");
        let page = S3Client::list_response_to_page("", parsed);

        let empty = page
            .entries
            .iter()
            .find(|e| e.key == "empty/")
            .expect("folder marker entry");
        assert!(empty.is_dir);
        assert_eq!(empty.name, "empty");
        assert_eq!(
            page.entries.iter().filter(|e| e.key == "existing/").count(),
            1,
            "common-prefix folder should not be duplicated by its marker object"
        );
    }

    #[test]
    fn list_objects_skips_current_folder_marker() {
        let input = r#"
        <?xml version="1.0" encoding="UTF-8"?>
        <ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
            <Name>bucket</Name>
            <Prefix>empty/</Prefix>
            <KeyCount>1</KeyCount>
            <MaxKeys>1000</MaxKeys>
            <Delimiter>/</Delimiter>
            <IsTruncated>false</IsTruncated>
            <Contents>
                <Key>empty/</Key>
                <LastModified>2026-07-07T12:00:00.000Z</LastModified>
                <ETag>"d41d8cd98f00b204e9800998ecf8427e"</ETag>
                <Size>0</Size>
                <StorageClass>STANDARD</StorageClass>
            </Contents>
        </ListBucketResult>
        "#;

        let parsed = ListObjectsV2::parse_response(input).expect("parse list response");
        let page = S3Client::list_response_to_page("empty/", parsed);

        assert!(page.entries.is_empty());
    }

    #[test]
    fn folder_marker_key_normalizes_trailing_slash() {
        assert_eq!(folder_marker_key(""), "");
        assert_eq!(folder_marker_key("empty"), "empty/");
        assert_eq!(folder_marker_key("empty/"), "empty/");
    }

    /// End-to-end round trip against a live S3-compatible endpoint (MinIO in
    /// CI/dev). Skipped unless `TAOMNI_S3_IT_ENDPOINT` is set, so the normal
    /// `cargo test` run stays offline. Exercises bucket/object signing, XML
    /// list parsing, delimiter→folder mapping, and pagination plumbing.
    #[tokio::test]
    async fn s3_round_trip() {
        let endpoint = match std::env::var("TAOMNI_S3_IT_ENDPOINT") {
            Ok(e) => e,
            Err(_) => return,
        };
        let key = std::env::var("TAOMNI_S3_IT_KEY").unwrap_or_else(|_| "minioadmin".into());
        let secret = std::env::var("TAOMNI_S3_IT_SECRET").unwrap_or_else(|_| "minioadmin".into());

        let client = S3Client::new(
            reqwest::Client::new(),
            Credentials::new(key, secret),
            url::Url::parse(&endpoint).expect("endpoint url"),
            "us-east-1".to_string(),
            UrlStyle::Path,
        );

        let bucket = format!("taomni-it-{}", uuid::Uuid::new_v4().simple());
        client.create_bucket(&bucket).await.expect("create_bucket");

        let buckets = client.list_buckets().await.expect("list_buckets");
        assert!(
            buckets.iter().any(|b| b.name == bucket),
            "new bucket listed"
        );

        client
            .put_object_bytes(&bucket, "dir/hello.txt", b"hi there".to_vec())
            .await
            .expect("put_object");
        client
            .create_folder(&bucket, "emptydir")
            .await
            .expect("create_folder");

        let root = client
            .list_objects(&bucket, "", None, 1000)
            .await
            .expect("list root");
        assert!(
            root.entries.iter().any(|e| e.is_dir && e.name == "dir"),
            "dir/ surfaces as a folder"
        );
        assert!(
            root.entries.iter().all(|e| e.is_dir),
            "root has only folders, no loose files"
        );

        let inside = client
            .list_objects(&bucket, "dir/", None, 1000)
            .await
            .expect("list dir/");
        let file = inside
            .entries
            .iter()
            .find(|e| !e.is_dir)
            .expect("file under dir/");
        assert_eq!(file.name, "hello.txt");
        assert_eq!(file.size, 8);

        let bytes = client
            .get_object_bytes(&bucket, "dir/hello.txt")
            .await
            .expect("get");
        assert_eq!(bytes, b"hi there");

        // --- P3 management ops ---
        let meta = client
            .head_object(&bucket, "dir/hello.txt")
            .await
            .expect("head");
        assert_eq!(meta.size, 8);

        // Server-side copy (same bucket) then verify the copy's bytes.
        client
            .copy_object(&bucket, "dir/hello.txt", &bucket, "dir2/copy.txt")
            .await
            .expect("copy");
        let copied = client
            .get_object_bytes(&bucket, "dir2/copy.txt")
            .await
            .expect("get copy");
        assert_eq!(copied, b"hi there");

        // Presigned GET should be fetchable with no further credentials.
        let url = client
            .presign_get(&bucket, "dir/hello.txt", 300)
            .expect("presign");
        let presigned = reqwest::get(&url)
            .await
            .expect("fetch presigned")
            .bytes()
            .await
            .expect("bytes");
        assert_eq!(&presigned[..], b"hi there");

        // Recursive delete removes everything under the prefix.
        client
            .delete_prefix(&bucket, "dir/")
            .await
            .expect("delete_prefix");
        let after = client
            .list_objects(&bucket, "", None, 1000)
            .await
            .expect("relist");
        assert!(
            !after.entries.iter().any(|e| e.name == "dir"),
            "dir/ gone after delete_prefix"
        );

        // cleanup
        client
            .delete_object(&bucket, "dir2/copy.txt")
            .await
            .expect("del copy");
        client
            .delete_object(&bucket, "emptydir/")
            .await
            .expect("del marker");
        client.delete_bucket(&bucket).await.expect("del bucket");
    }

    // NOTE: the multipart-upload + streaming-download paths
    // (`upload_from_file`/`download_to_file`) need a Tauri `AppHandle` for
    // progress emission. Driving them in a unit test requires
    // `tauri::test::mock_app()` (the `test` feature), which fails to link a
    // bare test binary on Windows (STATUS_ENTRYPOINT_NOT_FOUND from the
    // windowing DLLs). Those paths are therefore covered by manual smoke
    // testing through the UI rather than an automated round-trip here.
}
