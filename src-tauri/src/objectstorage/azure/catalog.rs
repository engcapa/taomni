use super::client::AzureClient;
use super::metadata::net_err;
use super::metadata::parse_http_date;
use super::xml_model::EnumerationResults;
use crate::objectstorage::types::BucketEntry;
use crate::objectstorage::types::ObjectEntry;
use crate::objectstorage::types::ObjectListPage;

impl AzureClient {
    /// List containers (the bucket-level analog).
    pub async fn list_buckets(&self) -> Result<Vec<BucketEntry>, String> {
        let url = self.build("", &[("comp", "list")]);
        let resp = self
            .send(reqwest::Method::GET, url, None, &[], None)
            .await?;
        let body = resp.text().await.map_err(net_err)?;
        let parsed: EnumerationResults =
            quick_xml::de::from_str(&body).map_err(|e| format!("parse containers: {e}"))?;
        Ok(parsed
            .containers
            .map(|c| c.container)
            .unwrap_or_default()
            .into_iter()
            .map(|c| BucketEntry {
                name: c.name,
                created_at: c
                    .properties
                    .and_then(|p| p.last_modified)
                    .as_deref()
                    .and_then(parse_http_date),
                region: None,
            })
            .collect())
    }

    pub async fn list_objects(
        &self,
        container: &str,
        prefix: &str,
        continuation: Option<&str>,
        max_keys: usize,
    ) -> Result<ObjectListPage, String> {
        let max = max_keys.to_string();
        let mut query: Vec<(&str, &str)> = vec![
            ("restype", "container"),
            ("comp", "list"),
            ("delimiter", "/"),
            ("maxresults", &max),
        ];
        if !prefix.is_empty() {
            query.push(("prefix", prefix));
        }
        if let Some(m) = continuation {
            query.push(("marker", m));
        }
        let url = self.build(container, &query);
        let resp = self
            .send(reqwest::Method::GET, url, None, &[], None)
            .await?;
        let body = resp.text().await.map_err(net_err)?;
        let parsed: EnumerationResults =
            quick_xml::de::from_str(&body).map_err(|e| format!("parse blobs: {e}"))?;

        let blobs = parsed.blobs.unwrap_or_default();
        let mut entries = Vec::with_capacity(blobs.blob.len() + blobs.blob_prefix.len());
        for bp in blobs.blob_prefix {
            let trimmed = bp.name.trim_end_matches('/');
            let name = trimmed.rsplit('/').next().unwrap_or(trimmed).to_string();
            entries.push(ObjectEntry {
                name,
                key: bp.name,
                is_dir: true,
                size: 0,
                last_modified: None,
                etag: None,
                storage_class: None,
            });
        }
        for b in blobs.blob {
            if b.name == prefix {
                continue; // skip the folder-marker blob equal to the prefix
            }
            let name = b.name.strip_prefix(prefix).unwrap_or(&b.name).to_string();
            let props = b.properties.unwrap_or_default();
            entries.push(ObjectEntry {
                name,
                key: b.name,
                is_dir: false,
                size: props.content_length.unwrap_or(0),
                last_modified: props.last_modified.as_deref().and_then(parse_http_date),
                etag: props.etag.map(|e| e.trim_matches('"').to_string()),
                storage_class: props.access_tier,
            });
        }
        let next = parsed.next_marker.filter(|m| !m.is_empty());
        Ok(ObjectListPage {
            entries,
            next_token: next,
        })
    }

    /// Page through every blob name under `prefix` (no delimiter).
    pub(super) async fn list_all_keys(
        &self,
        container: &str,
        prefix: &str,
    ) -> Result<Vec<String>, String> {
        let mut keys = Vec::new();
        let mut marker: Option<String> = None;
        loop {
            let mut query: Vec<(&str, &str)> = vec![
                ("restype", "container"),
                ("comp", "list"),
                ("maxresults", "5000"),
            ];
            if !prefix.is_empty() {
                query.push(("prefix", prefix));
            }
            if let Some(m) = &marker {
                query.push(("marker", m));
            }
            let url = self.build(container, &query);
            let resp = self
                .send(reqwest::Method::GET, url, None, &[], None)
                .await?;
            let body = resp.text().await.map_err(net_err)?;
            let parsed: EnumerationResults =
                quick_xml::de::from_str(&body).map_err(|e| format!("parse blobs: {e}"))?;
            if let Some(blobs) = parsed.blobs {
                keys.extend(blobs.blob.into_iter().map(|b| b.name));
            }
            match parsed.next_marker.filter(|m| !m.is_empty()) {
                Some(m) => marker = Some(m),
                None => break,
            }
        }
        Ok(keys)
    }

    pub async fn create_bucket(&self, container: &str) -> Result<(), String> {
        let url = self.build(container, &[("restype", "container")]);
        self.send(reqwest::Method::PUT, url, None, &[], None)
            .await?;
        Ok(())
    }

    pub async fn delete_bucket(&self, container: &str) -> Result<(), String> {
        let url = self.build(container, &[("restype", "container")]);
        self.send(reqwest::Method::DELETE, url, None, &[], None)
            .await?;
        Ok(())
    }
}
