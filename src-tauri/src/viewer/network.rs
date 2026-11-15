//! Per-token, proxy-resolved GET transport. WebViews never connect directly.
//! Session revocation cancels queued/connect/stream awaits and drops responses.
use super::html::Preview;
use super::network_rewrite;
use crate::proxy::{AppProxyConfig, ResolvedProxy};
use crate::state::AppState;
use base64::Engine;
use futures::StreamExt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

pub(super) const MAX_RESOURCE: u64 = 32 * 1024 * 1024;
const SESSION_BUDGET: u64 = 128 * 1024 * 1024;

pub(crate) fn resolve_proxy(
    state: &AppState,
    mode: &str,
    custom: Option<AppProxyConfig>,
) -> Result<Option<ResolvedProxy>, String> {
    let config = match mode {
        "none" => return Ok(None),
        "app" => AppProxyConfig::load_strict(&crate::proxy::default_app_proxy_path())?,
        "custom" => AppProxyConfig {
            enabled: true,
            ..custom.ok_or("Custom HTML proxy is required")?
        },
        _ => return Err("Unknown HTML proxy mode".into()),
    };
    let db = state
        .db
        .lock()
        .map_err(|_| "Proxy session database is unavailable")?;
    crate::proxy::resolve_strict_with_db(&config, Some(&db), Some(&state.vault))
}

pub(super) struct Network {
    client: reqwest::Client,
    pub cancel: CancellationToken,
    permits: tokio::sync::Semaphore,
    bytes: AtomicU64,
    requests: AtomicU64,
}

impl Network {
    pub fn new(proxy: Option<&ResolvedProxy>) -> Result<Self, String> {
        let mut builder = reqwest::Client::builder()
            .no_proxy()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(20))
            .redirect(reqwest::redirect::Policy::none());
        if let Some(proxy) = proxy {
            let endpoint = proxy.to_url();
            let endpoint = if proxy.kind == "socks5" {
                endpoint.replacen("socks5://", "socks5h://", 1)
            } else {
                endpoint
            };
            builder = builder.proxy(
                reqwest::Proxy::all(&endpoint).map_err(|_| "permission: Invalid HTML proxy")?,
            );
        }
        Ok(Self {
            client: builder
                .build()
                .map_err(|_| "permission: Cannot initialize HTML network client")?,
            cancel: CancellationToken::new(),
            permits: tokio::sync::Semaphore::new(4),
            bytes: AtomicU64::new(0),
            requests: AtomicU64::new(0),
        })
    }

    pub async fn fetch(
        &self,
        encoded: &str,
        preview: &Preview,
    ) -> Result<(Vec<u8>, String), String> {
        let _permit = tokio::select! {
            biased;
            _ = self.cancel.cancelled() => return Err("permission: HTML session was closed".into()),
            permit = self.permits.acquire() => permit.map_err(|_| "permission: Network queue closed")?,
        };
        if self.requests.fetch_add(1, Ordering::Relaxed) >= 512 {
            return Err("too_large: HTML session request budget exhausted".into());
        }
        let url = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(|_| "permission: Invalid network resource token")?;
        let url = std::str::from_utf8(&url).map_err(|_| "permission: Invalid network URL")?;
        let mut url = validate_url(url)?;
        let operation = async {
            for redirect in 0..=5 {
                // Fresh request: no browser cookies, credentials, Origin, auth,
                // Referer, request headers or user agent identity forwarded.
                let response = self.client.get(url.clone()).send().await.map_err(|_| {
                    "permission: HTML request failed; check the selected proxy and resource URL"
                        .to_string()
                })?;
                if response.status().is_redirection() {
                    if redirect == 5 {
                        return Err("permission: Too many HTML resource redirects".into());
                    }
                    let location = response
                        .headers()
                        .get(reqwest::header::LOCATION)
                        .and_then(|value| value.to_str().ok())
                        .ok_or("permission: Invalid HTML resource redirect")?;
                    url = validate_url(
                        url.join(location)
                            .map_err(|_| "permission: Invalid HTML redirect URL")?
                            .as_str(),
                    )?;
                    continue;
                }
                if !response.status().is_success() {
                    return Err(format!(
                        "permission: HTML resource returned HTTP {}",
                        response.status().as_u16()
                    ));
                }
                if response
                    .content_length()
                    .is_some_and(|size| size > MAX_RESOURCE)
                {
                    return Err("too_large: Network resource exceeds 32 MiB".into());
                }
                let mime = response
                    .headers()
                    .get(reqwest::header::CONTENT_TYPE)
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or("application/octet-stream")
                    .to_string();
                let mut stream = response.bytes_stream();
                let mut bytes = Vec::new();
                while let Some(chunk) = stream.next().await {
                    let chunk = chunk.map_err(|_| "permission: HTML response stream failed")?;
                    if bytes.len() as u64 + chunk.len() as u64 > MAX_RESOURCE {
                        return Err("too_large: Network resource exceeds 32 MiB".into());
                    }
                    if self.bytes.fetch_add(chunk.len() as u64, Ordering::Relaxed)
                        + chunk.len() as u64
                        > SESSION_BUDGET
                    {
                        self.cancel.cancel();
                        return Err(
                            "too_large: HTML session exceeded 128 MiB network budget".into()
                        );
                    }
                    bytes.extend_from_slice(&chunk);
                }
                let essence = mime
                    .split(';')
                    .next()
                    .unwrap_or("")
                    .trim()
                    .to_ascii_lowercase();
                let (bytes, mime) = match essence.as_str() {
                    "text/css" => {
                        let text = std::str::from_utf8(&bytes)
                            .map_err(|_| "binary: Remote CSS must be UTF-8")?;
                        (
                            network_rewrite::css(text, Some(&url), preview)?.into_bytes(),
                            "text/css; charset=utf-8".into(),
                        )
                    }
                    "text/html" | "application/xhtml+xml" => (
                        super::html_document::document_with_base(&bytes, preview, Some(&url))?,
                        "text/html; charset=utf-8".into(),
                    ),
                    _ => (bytes, mime),
                };
                return Ok((bytes, mime));
            }
            unreachable!()
        };
        tokio::select! {
            biased;
            _ = self.cancel.cancelled() => Err("permission: HTML session was closed".into()),
            result = tokio::time::timeout(Duration::from_secs(20), operation) =>
                result.map_err(|_| "permission: HTML resource timed out".to_string())?,
        }
    }
}

pub(super) fn validate_url(value: &str) -> Result<url::Url, String> {
    let mut url = url::Url::parse(value).map_err(|_| "permission: Invalid network URL")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_some_and(|host| {
            host == "ipc.localhost"
                || host == "tauri.localhost"
                || host == "asset.localhost"
                || host == "taomni-preview.localhost"
        })
    {
        return Err("permission: Only credentialless HTTP(S) resource URLs are allowed".into());
    }
    url.set_fragment(None);
    Ok(url)
}

pub(super) fn resource_url(value: &str, preview: &Preview) -> Result<String, String> {
    let url = validate_url(value)?;
    Ok(format!(
        "{}_net/{}",
        preview.url_root(),
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(url.as_str())
    ))
}
