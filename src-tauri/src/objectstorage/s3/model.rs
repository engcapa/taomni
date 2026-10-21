use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub(super) struct ListAllMyBucketsResult {
    #[serde(default)]
    pub(super) buckets: BucketsXml,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub(super) struct BucketsXml {
    #[serde(default, rename = "Bucket")]
    pub(super) bucket: Vec<BucketXml>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub(super) struct BucketXml {
    pub(super) name: String,
    pub(super) creation_date: Option<String>,
}
