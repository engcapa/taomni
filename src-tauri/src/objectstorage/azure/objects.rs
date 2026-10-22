use super::authentication::AzureAuth;
use super::authentication::HmacSha256;
use super::authentication::MS_VERSION;
use super::client::AzureClient;
use super::metadata::folder_marker_key;
use super::metadata::move_prefix_plan;
use super::metadata::net_err;
use super::metadata::parse_http_date;
use crate::objectstorage::types::ObjectMetadata;
use base64::Engine as _;

impl AzureClient {
    pub async fn get_object_bytes(&self, container: &str, key: &str) -> Result<Vec<u8>, String> {
        let url = self.build(&format!("{container}/{key}"), &[]);
        let resp = self
            .send(reqwest::Method::GET, url, None, &[], None)
            .await?;
        Ok(resp.bytes().await.map_err(net_err)?.to_vec())
    }

    /// HEAD a blob and build its metadata from the response headers.
    pub async fn head_object(&self, container: &str, key: &str) -> Result<ObjectMetadata, String> {
        let url = self.build(&format!("{container}/{key}"), &[]);
        let resp = self
            .send(reqwest::Method::HEAD, url, None, &[], None)
            .await?;
        let h = resp.headers();
        let get = |name: &str| {
            h.get(name)
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string())
        };
        let mut user_metadata = std::collections::BTreeMap::new();
        for (name, value) in h.iter() {
            if let Some(k) = name.as_str().strip_prefix("x-ms-meta-") {
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
            storage_class: get("x-ms-access-tier"),
            cache_control: get("cache-control"),
            content_encoding: get("content-encoding"),
            content_disposition: get("content-disposition"),
            user_metadata,
        })
    }

    pub async fn put_object_bytes(
        &self,
        container: &str,
        key: &str,
        body: Vec<u8>,
    ) -> Result<(), String> {
        let url = self.build(&format!("{container}/{key}"), &[]);
        self.send(
            reqwest::Method::PUT,
            url,
            Some(body),
            &[("x-ms-blob-type", "BlockBlob")],
            Some("application/octet-stream"),
        )
        .await?;
        Ok(())
    }

    pub async fn delete_object(&self, container: &str, key: &str) -> Result<(), String> {
        let url = self.build(&format!("{container}/{key}"), &[]);
        self.send(reqwest::Method::DELETE, url, None, &[], None)
            .await?;
        Ok(())
    }

    /// Server-side Copy Blob, including across containers. With Shared Key the
    /// source is authorized by the same account; with SAS the same token is
    /// appended to the source URL.
    pub async fn copy_object(
        &self,
        src_container: &str,
        src_key: &str,
        dst_container: &str,
        dst_key: &str,
    ) -> Result<(), String> {
        let src_url = self.build(&format!("{src_container}/{src_key}"), &[]);
        let copy_source = match &self.auth {
            AzureAuth::Sas(sas) => format!("{src_url}?{sas}"),
            AzureAuth::SharedKey(_) | AzureAuth::Bearer(_) => src_url.to_string(),
        };
        let dst_url = self.build(&format!("{dst_container}/{dst_key}"), &[]);
        self.send(
            reqwest::Method::PUT,
            dst_url,
            None,
            &[("x-ms-copy-source", copy_source.as_str())],
            None,
        )
        .await?;
        Ok(())
    }

    /// Recursively delete every blob under `prefix` with bounded concurrency.
    pub async fn delete_prefix(&self, container: &str, prefix: &str) -> Result<(), String> {
        use futures::stream::{self, StreamExt};
        let keys = self.list_all_keys(container, prefix).await?;
        let results: Vec<Result<(), String>> = stream::iter(keys.into_iter().map(|k| {
            let container = container.to_string();
            async move { self.delete_object(&container, &k).await }
        }))
        .buffer_unordered(16)
        .collect()
        .await;
        for r in results {
            r?;
        }
        Ok(())
    }

    /// Rename a virtual folder while preserving empty-folder marker blobs.
    pub async fn move_prefix(
        &self,
        container: &str,
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
        let keys = self.list_all_keys(container, &old_prefix).await?;
        if keys.is_empty() {
            return Err(format!("folder prefix '{old_prefix}' does not exist"));
        }

        let plan = move_prefix_plan(&old_prefix, &new_prefix, keys)?;
        for (src, dst) in &plan {
            self.copy_object(container, src, container, dst).await?;
        }
        for (src, _) in &plan {
            self.delete_object(container, src).await?;
        }
        Ok(())
    }

    pub async fn create_folder(&self, container: &str, prefix: &str) -> Result<(), String> {
        let key = folder_marker_key(prefix);
        self.put_object_bytes(container, &key, Vec::new()).await
    }

    /// Build a shareable read-only URL for a blob, valid for `ttl_secs`. With
    /// Shared Key we mint a service SAS (signed with the account key); with an
    /// existing SAS token we just append it to the blob URL.
    pub fn presign_get(&self, container: &str, key: &str, ttl_secs: u64) -> Result<String, String> {
        let blob_url = self.build(&format!("{container}/{key}"), &[]);
        match &self.auth {
            AzureAuth::Sas(sas) => Ok(format!("{blob_url}?{sas}")),
            AzureAuth::SharedKey(account_key) => {
                let expiry = (chrono::Utc::now() + chrono::Duration::seconds(ttl_secs as i64))
                    .format("%Y-%m-%dT%H:%M:%SZ")
                    .to_string();
                let protocol = if self.base.scheme() == "https" {
                    "https"
                } else {
                    "https,http"
                };
                let permissions = "r";
                let resource = "b";
                let canonical = format!("/blob/{}/{}/{}", self.account, container, key);
                // Service SAS string-to-sign for api-version 2020-12-06+ (16
                // newline-joined fields). Empty fields: start, identifier, IP,
                // snapshot, encryption scope, and the five response-override
                // headers (rscc/rscd/rsce/rscl/rsct).
                let fields = [
                    permissions,
                    "",
                    expiry.as_str(),
                    canonical.as_str(),
                    "",
                    "",
                    protocol,
                    MS_VERSION,
                    resource,
                    "",
                    "",
                    "",
                    "",
                    "",
                    "",
                    "",
                ];
                let string_to_sign = fields.join("\n");
                let mut mac =
                    HmacSha256::new_from_slice(account_key).expect("hmac accepts any key length");
                mac.update(string_to_sign.as_bytes());
                let sig =
                    base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes());
                let query = format!(
                    "sv={}&sr={}&sp={}&se={}&spr={}&sig={}",
                    MS_VERSION,
                    resource,
                    permissions,
                    urlencoding::encode(&expiry),
                    urlencoding::encode(protocol),
                    urlencoding::encode(&sig),
                );
                Ok(format!("{blob_url}?{query}"))
            }
            AzureAuth::Bearer(_) => Err(
                "share links require account-key or SAS auth; an Entra ID (bearer) connection \
                 cannot mint a SAS"
                    .into(),
            ),
        }
    }
}
use hmac::{KeyInit, Mac};
