use super::client::S3Client;
use super::limits::SIGN_TTL;
use super::metadata::decode_list_value;
use super::metadata::folder_marker_entry;
use super::metadata::parse_iso8601;
use super::model::ListAllMyBucketsResult;
use super::response::net_err;
use crate::objectstorage::types::BucketEntry;
use crate::objectstorage::types::ObjectEntry;
use crate::objectstorage::types::ObjectListPage;
use jiff::Timestamp;
use rusty_s3::Method;
use rusty_s3::S3Action;
use rusty_s3::actions::ListObjectsV2;
use rusty_s3::actions::ListObjectsV2Response;

impl S3Client {
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

    pub(super) fn list_response_to_page(
        prefix: &str,
        resp: ListObjectsV2Response,
    ) -> ObjectListPage {
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

    /// Page through every object key under `prefix` (no delimiter, so nested
    /// keys are included).
    pub(super) async fn list_all_keys(
        &self,
        bucket: &str,
        prefix: &str,
    ) -> Result<Vec<String>, String> {
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
}
