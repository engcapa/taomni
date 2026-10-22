use serde::Deserialize;

#[derive(Debug, Default, Deserialize)]
pub(super) struct EnumerationResults {
    #[serde(rename = "Containers")]
    pub(super) containers: Option<Containers>,
    #[serde(rename = "Blobs")]
    pub(super) blobs: Option<Blobs>,
    #[serde(rename = "NextMarker")]
    pub(super) next_marker: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
pub(super) struct Containers {
    #[serde(default, rename = "Container")]
    pub(super) container: Vec<ContainerXml>,
}

#[derive(Debug, Deserialize)]
pub(super) struct ContainerXml {
    #[serde(rename = "Name")]
    pub(super) name: String,
    #[serde(rename = "Properties")]
    pub(super) properties: Option<ContainerProps>,
}

#[derive(Debug, Deserialize)]
pub(super) struct ContainerProps {
    #[serde(rename = "Last-Modified")]
    pub(super) last_modified: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
pub(super) struct Blobs {
    #[serde(default, rename = "Blob")]
    pub(super) blob: Vec<BlobXml>,
    #[serde(default, rename = "BlobPrefix")]
    pub(super) blob_prefix: Vec<BlobPrefixXml>,
}

#[derive(Debug, Deserialize)]
pub(super) struct BlobXml {
    #[serde(rename = "Name")]
    pub(super) name: String,
    #[serde(rename = "Properties")]
    pub(super) properties: Option<BlobProps>,
}

#[derive(Debug, Default, Deserialize)]
pub(super) struct BlobProps {
    #[serde(rename = "Content-Length")]
    pub(super) content_length: Option<u64>,
    #[serde(rename = "Last-Modified")]
    pub(super) last_modified: Option<String>,
    #[serde(rename = "Etag", alias = "ETag")]
    pub(super) etag: Option<String>,
    #[serde(rename = "AccessTier")]
    pub(super) access_tier: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(super) struct BlobPrefixXml {
    #[serde(rename = "Name")]
    pub(super) name: String,
}
