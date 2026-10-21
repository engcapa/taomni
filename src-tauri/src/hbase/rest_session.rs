use super::model::HBaseConfig;
use reqwest::Client;
use reqwest::Method;
use reqwest::header::ACCEPT;
use std::time::Duration;
/// REST/Stargate transport session (legacy backend).
#[derive(Debug, Clone)]
pub struct RestSession {
    pub(super) client: Client,
    pub(super) base_url: String,
    pub(super) username: Option<String>,
    pub(super) password: Option<String>,
    pub(super) namespace: Option<String>,
}

impl RestSession {
    pub(super) fn new(config: &HBaseConfig, password: Option<String>) -> Result<Self, String> {
        let host = config.host.trim();
        if host.is_empty() {
            return Err("HBase REST host is required".into());
        }
        let scheme = if config.ssl { "https" } else { "http" };
        let path = normalize_rest_path(config.rest_path.as_deref());
        let base_url = format!("{scheme}://{host}:{}{}", config.port, path);
        let timeout_secs = config.timeout_secs.unwrap_or(15).clamp(1, 300);
        let client = Client::builder()
            .timeout(Duration::from_secs(timeout_secs))
            .build()
            .map_err(|e| format!("HBase client build failed: {e}"))?;
        Ok(Self {
            client,
            base_url,
            username: config.username.clone().filter(|s| !s.trim().is_empty()),
            password,
            namespace: config.namespace.clone().filter(|s| !s.trim().is_empty()),
        })
    }

    pub(super) fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }

    pub(super) fn table_name(&self, table: &str) -> String {
        let trimmed = table.trim();
        match self.namespace.as_deref() {
            Some(ns) if !trimmed.contains(':') => format!("{ns}:{trimmed}"),
            _ => trimmed.to_string(),
        }
    }

    pub(super) fn request(&self, method: Method, url: String) -> reqwest::RequestBuilder {
        let req = self
            .client
            .request(method, url)
            .header(ACCEPT, "application/json");
        match self.username.as_deref() {
            Some(user) => req.basic_auth(user, self.password.clone()),
            None => req,
        }
    }
}

pub(super) fn normalize_rest_path(value: Option<&str>) -> String {
    let trimmed = value.unwrap_or("").trim();
    if trimmed.is_empty() || trimmed == "/" {
        String::new()
    } else {
        format!("/{}", trimmed.trim_matches('/'))
    }
}
