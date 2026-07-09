//! Connection config payload from the frontend and provider-preset resolution.

use rusty_s3::UrlStyle;
use serde::{Deserialize, Serialize};
use url::Url;

use crate::terminal::network::NetworkSettings;

/// Connection parameters sent by the frontend (camelCase). Mirrors the shape
/// stored in a session's `options_json`. Provider-specific fields are optional;
/// which ones matter depends on `provider`/`engine`. Secret-bearing fields may
/// be `vault:<uuid>` references resolved server-side via the vault.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectStorageConfig {
    /// `aws` | `alibaba-oss` | `minio` | `r2` | `backblaze` | `wasabi`
    /// | `tencent-cos` | `ceph` | `custom` | `azure`.
    pub provider: String,
    // --- S3 family ---
    /// Full service endpoint, e.g. `https://oss-cn-hangzhou.aliyuncs.com`.
    /// Optional for `aws` (derived from region).
    pub endpoint: Option<String>,
    pub region: Option<String>,
    /// Force path-style addressing (`endpoint/bucket/key`) instead of
    /// virtual-host (`bucket.endpoint/key`). Required by MinIO/Ceph.
    pub path_style: Option<bool>,
    pub access_key_id: Option<String>,
    /// Secret access key; may be a `vault:` ref.
    pub secret_access_key: Option<String>,
    /// Optional STS session token; may be a `vault:` ref.
    pub session_token: Option<String>,
    pub default_bucket: Option<String>,
    /// S3 credential source: `keys` (default) | `environment` | `profile`.
    pub aws_auth: Option<String>,
    /// Named profile for `aws_auth == "profile"` (defaults to `AWS_PROFILE` /
    /// `default`).
    pub aws_profile: Option<String>,
    // --- Azure (consumed in P2) ---
    pub account_name: Option<String>,
    pub account_key: Option<String>,
    pub connection_string: Option<String>,
    pub sas_token: Option<String>,
    pub endpoint_suffix: Option<String>,
    pub default_container: Option<String>,
    /// Azure auth selector: `key` | `sas` | `connstr` | `bearer` (Entra ID).
    /// When unset the engine infers it from whichever secret field is present.
    pub azure_auth: Option<String>,
    /// Pasted Entra ID access token for `azure_auth == "bearer"` (may be a
    /// `vault:` ref). Empty → obtain one from the Azure CLI at connect time.
    pub azure_bearer_token: Option<String>,
    // --- Network routing (P7) ---
    /// Proxy / SSH-jump routing. When absent (or with no proxy_kind) the engine
    /// connects directly (does not fall back to the app-level global proxy).
    pub network: Option<NetworkSettings>,
    // --- Defaults (P8) ---
    /// Default storage class / access tier applied to uploads when the caller
    /// doesn't specify one (e.g. `STANDARD`/`GLACIER`, or Azure `Hot`/`Cool`).
    pub storage_class: Option<String>,
}

/// Resolved S3 endpoint, addressing style, and signing region.
pub struct S3Endpoint {
    pub url: Url,
    pub style: UrlStyle,
    pub region: String,
    pub default_bucket: Option<String>,
}

impl ObjectStorageConfig {
    /// Resolve the S3 service endpoint, addressing style and region from the
    /// provider preset plus explicit overrides. AWS derives its endpoint from
    /// the region; all other providers require an explicit `endpoint`.
    pub fn resolve_s3_endpoint(&self) -> Result<S3Endpoint, String> {
        let region = self
            .region
            .clone()
            .filter(|r| !r.is_empty())
            .unwrap_or_else(|| "us-east-1".to_string());

        let endpoint = match self.endpoint.as_deref().filter(|e| !e.is_empty()) {
            Some(e) => e.to_string(),
            None if self.provider == "aws" => format!("https://s3.{region}.amazonaws.com"),
            None => {
                return Err(format!(
                    "endpoint is required for provider '{}'",
                    self.provider
                ));
            }
        };
        let endpoint = if endpoint.contains("://") {
            endpoint
        } else {
            format!("https://{endpoint}")
        };
        let mut url = Url::parse(&endpoint).map_err(|e| format!("invalid endpoint url: {e}"))?;
        let inferred_bucket = normalize_bucket_endpoint(self.provider.as_str(), &mut url);

        // Path-style by explicit override, else by provider default. MinIO,
        // Ceph and "custom" default to path-style; everything else uses
        // virtual-host addressing. An SSH-jump route forces path-style so the
        // single resolved endpoint host covers every bucket (virtual-host would
        // put each bucket on its own unresolved subdomain).
        let jump = self
            .network
            .as_ref()
            .map(|n| n.uses_jump_host())
            .unwrap_or(false);
        let path_style = self
            .path_style
            .unwrap_or_else(|| matches!(self.provider.as_str(), "minio" | "ceph" | "custom"))
            || jump;
        let style = if path_style {
            UrlStyle::Path
        } else {
            UrlStyle::VirtualHost
        };

        let default_bucket = self
            .default_bucket
            .as_deref()
            .map(str::trim)
            .filter(|b| !b.is_empty())
            .map(ToOwned::to_owned)
            .or(inferred_bucket);

        Ok(S3Endpoint {
            url,
            style,
            region,
            default_bucket,
        })
    }
}

fn normalize_bucket_endpoint(provider: &str, url: &mut Url) -> Option<String> {
    let host = url.host_str()?.to_ascii_lowercase();
    let markers: &[&str] = match provider {
        "tencent-cos" => &[".cos."],
        "alibaba-oss" => &[".oss-", ".oss."],
        _ => return None,
    };

    for marker in markers {
        if let Some(idx) = host.find(marker) {
            if idx == 0 {
                continue;
            }
            let bucket = host[..idx].to_string();
            let service_host = &host[idx + 1..];
            if url.set_host(Some(service_host)).is_err() {
                return None;
            }
            url.set_path("/");
            url.set_query(None);
            url.set_fragment(None);
            return Some(bucket);
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(provider: &str, endpoint: Option<&str>, region: Option<&str>) -> ObjectStorageConfig {
        ObjectStorageConfig {
            provider: provider.into(),
            endpoint: endpoint.map(Into::into),
            region: region.map(Into::into),
            ..Default::default()
        }
    }

    #[test]
    fn aws_derives_endpoint_from_region() {
        let e = cfg("aws", None, Some("eu-west-1"))
            .resolve_s3_endpoint()
            .unwrap();
        assert_eq!(e.url.as_str(), "https://s3.eu-west-1.amazonaws.com/");
        assert_eq!(e.region, "eu-west-1");
        assert!(matches!(e.style, UrlStyle::VirtualHost));
    }

    #[test]
    fn minio_defaults_to_path_style() {
        let e = cfg("minio", Some("http://127.0.0.1:9000"), None)
            .resolve_s3_endpoint()
            .unwrap();
        assert!(matches!(e.style, UrlStyle::Path));
        assert_eq!(e.region, "us-east-1");
    }

    #[test]
    fn non_aws_without_endpoint_errors() {
        assert!(cfg("wasabi", None, None).resolve_s3_endpoint().is_err());
    }

    #[test]
    fn bare_host_endpoint_gets_https_scheme() {
        let e = cfg(
            "alibaba-oss",
            Some("oss-cn-hangzhou.aliyuncs.com"),
            Some("oss-cn-hangzhou"),
        )
        .resolve_s3_endpoint()
        .unwrap();
        assert_eq!(e.url.scheme(), "https");
        assert!(matches!(e.style, UrlStyle::VirtualHost));
    }

    #[test]
    fn tencent_cos_bucket_endpoint_infers_default_bucket() {
        let e = cfg(
            "tencent-cos",
            Some("https://photos-1234567890.cos.ap-beijing.myqcloud.com"),
            Some("ap-beijing"),
        )
        .resolve_s3_endpoint()
        .unwrap();

        assert_eq!(e.url.as_str(), "https://cos.ap-beijing.myqcloud.com/");
        assert_eq!(e.default_bucket.as_deref(), Some("photos-1234567890"));
    }

    #[test]
    fn alibaba_oss_bucket_endpoint_infers_default_bucket() {
        let e = cfg(
            "alibaba-oss",
            Some("archive.oss-cn-hangzhou.aliyuncs.com"),
            Some("oss-cn-hangzhou"),
        )
        .resolve_s3_endpoint()
        .unwrap();

        assert_eq!(e.url.as_str(), "https://oss-cn-hangzhou.aliyuncs.com/");
        assert_eq!(e.default_bucket.as_deref(), Some("archive"));
    }

    #[test]
    fn explicit_default_bucket_wins_over_bucket_endpoint() {
        let c = ObjectStorageConfig {
            provider: "tencent-cos".into(),
            endpoint: Some("https://endpoint-bucket.cos.ap-beijing.myqcloud.com".into()),
            region: Some("ap-beijing".into()),
            default_bucket: Some("configured-bucket".into()),
            ..Default::default()
        };
        let e = c.resolve_s3_endpoint().unwrap();

        assert_eq!(e.url.as_str(), "https://cos.ap-beijing.myqcloud.com/");
        assert_eq!(e.default_bucket.as_deref(), Some("configured-bucket"));
    }

    #[test]
    fn ssh_jump_forces_path_style_even_for_virtual_host_provider() {
        // A virtual-host provider (aws) would normally use VirtualHost, but an
        // SSH-jump route forces path-style so one resolved host covers all
        // buckets.
        let mut net = NetworkSettings::default();
        net.proxy_kind = "ssh-tunnel".into();
        let c = ObjectStorageConfig {
            provider: "aws".into(),
            region: Some("us-east-1".into()),
            network: Some(net),
            ..Default::default()
        };
        let e = c.resolve_s3_endpoint().unwrap();
        assert!(
            matches!(e.style, UrlStyle::Path),
            "jump host should force path-style addressing"
        );
    }

    #[test]
    fn plain_proxy_does_not_force_path_style() {
        // An HTTP/SOCKS proxy keeps the provider's default addressing (reqwest
        // proxies bucket subdomains fine); only ssh-tunnel forces path-style.
        let mut net = NetworkSettings::default();
        net.proxy_kind = "socks5".into();
        let c = ObjectStorageConfig {
            provider: "aws".into(),
            region: Some("us-east-1".into()),
            network: Some(net),
            ..Default::default()
        };
        let e = c.resolve_s3_endpoint().unwrap();
        assert!(matches!(e.style, UrlStyle::VirtualHost));
    }
}
