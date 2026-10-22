use super::limits::SIGN_TTL;
use super::response::net_err;
use super::response::parse_s3_error;
use reqwest::Client;
use rusty_s3::Bucket;
use rusty_s3::Credentials;
use rusty_s3::S3Action;
use rusty_s3::UrlStyle;
use url::Url;

pub struct S3Client {
    pub(super) http: Client,
    pub(super) creds: Credentials,
    pub(super) endpoint: Url,
    pub(super) region: String,
    pub(super) style: UrlStyle,
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

    pub(super) fn bucket(&self, name: &str) -> Result<Bucket, String> {
        Bucket::new(
            self.endpoint.clone(),
            self.style,
            name.to_string(),
            self.region.clone(),
        )
        .map_err(|e| format!("invalid bucket '{name}': {e}"))
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

    pub(super) async fn get_text(&self, url: Url) -> Result<String, String> {
        let resp = self.http.get(url).send().await.map_err(net_err)?;
        let resp = self.check(resp).await?;
        resp.text().await.map_err(net_err)
    }

    /// Map a non-2xx response into a useful S3 error string.
    pub(super) async fn check(&self, resp: reqwest::Response) -> Result<reqwest::Response, String> {
        let status = resp.status();
        if status.is_success() {
            return Ok(resp);
        }
        let body = resp.text().await.unwrap_or_default();
        let msg = parse_s3_error(&body).unwrap_or_else(|| body.chars().take(300).collect());
        Err(format!("S3 error {}: {msg}", status.as_u16()))
    }
}
