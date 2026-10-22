use super::model::PrestoClient;
use super::model::PrestoResults;
use super::protocol::DEFAULT_PRESTO_USER;
use super::protocol::DEFAULT_TIMEOUT_SECS;
use super::protocol::protocol_headers_from_dialect;
use super::query::ping;
use super::statements::normalize_presto_statement;
use crate::database::DbConfig;
use crate::database::DbHandle;
use reqwest::header::HeaderMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex as AsyncMutex;
use tokio_util::sync::CancellationToken;

pub async fn connect(config: &DbConfig, password: Option<&str>) -> Result<DbHandle, String> {
    let scheme = if config.ssl { "https" } else { "http" };
    let base_url = format!("{scheme}://{}:{}", config.host, config.port);
    let timeout = Duration::from_secs(match config.timeout_secs {
        Some(s) if s > 0 => s,
        _ => DEFAULT_TIMEOUT_SECS,
    });
    // reqwest enables implicit system-proxy detection by default
    // (HTTP_PROXY/HTTPS_PROXY/ALL_PROXY env vars, plus the Windows/macOS system
    // proxy a corporate VPN installs). DB routing is explicit: a per-session
    // proxy/jump host is handled upstream by `forward.rs` via a loopback
    // forwarder, so this client always dials directly. Disable the implicit
    // layer so an ambient VPN/shell proxy can't silently reroute `/v1/statement`
    // and turn a healthy Trino into a 502 from some gateway that can't reach it.
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(timeout)
        .build()
        .map_err(|e| format!("Presto client build failed: {e}"))?;
    let presto = PrestoClient {
        client,
        base_url,
        user: config
            .username
            .clone()
            .filter(|u| !u.is_empty())
            .unwrap_or_else(|| DEFAULT_PRESTO_USER.to_string()),
        password: password.map(|value| value.to_string()),
        headers: protocol_headers_from_dialect(config.presto_dialect.as_deref()),
        catalog: Arc::new(AsyncMutex::new(
            config.catalog.clone().filter(|value| !value.is_empty()),
        )),
        schema: Arc::new(AsyncMutex::new(
            config.database.clone().filter(|value| !value.is_empty()),
        )),
        current_next_uri: Arc::new(AsyncMutex::new(None)),
    };
    ping(&presto).await?;
    Ok(DbHandle::Presto(presto))
}

pub(super) async fn request_context(client: &PrestoClient) -> (Option<String>, Option<String>) {
    let catalog = client.catalog.lock().await.clone();
    let schema = client.schema.lock().await.clone();
    (catalog, schema)
}

pub(super) async fn request_context_with_overrides(
    client: &PrestoClient,
    catalog_override: Option<&str>,
    schema_override: Option<&str>,
) -> (Option<String>, Option<String>) {
    let (catalog, schema) = request_context(client).await;
    let catalog = catalog_override
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or(catalog);
    let schema = schema_override
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or(schema);
    (catalog, schema)
}

pub(super) fn add_presto_headers(
    client: &PrestoClient,
    mut req: reqwest::RequestBuilder,
    catalog: Option<&str>,
    schema: Option<&str>,
) -> reqwest::RequestBuilder {
    let h = client.headers;
    req = req
        .header(h.user, client.user.as_str())
        .header(h.source, "taomni")
        .header("User-Agent", format!("Taomni {} Client", h.engine_label));
    if let Some(catalog) = catalog.filter(|value| !value.is_empty()) {
        req = req.header(h.catalog, catalog);
    }
    if let Some(schema) = schema.filter(|value| !value.is_empty()) {
        req = req.header(h.schema, schema);
    }
    if let Some(password) = &client.password {
        req = req.basic_auth(client.user.as_str(), Some(password));
    }
    req
}

pub(super) async fn apply_session_headers(client: &PrestoClient, headers: &HeaderMap) {
    let h = client.headers;
    if let Some(catalog) = header_string(headers, h.set_catalog) {
        *client.catalog.lock().await = Some(catalog);
    }
    if let Some(schema) = header_string(headers, h.set_schema) {
        *client.schema.lock().await = Some(schema);
    }
}

pub(super) fn header_string(headers: &HeaderMap, key: &str) -> Option<String> {
    headers
        .get(key)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

pub(super) async fn read_results_response(
    client: &PrestoClient,
    resp: reqwest::Response,
) -> Result<PrestoResults, String> {
    let status = resp.status();
    let headers = resp.headers().clone();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("Presto response read failed: {e}"))?;
    if !status.is_success() {
        return Err(format!("Presto error ({status}): {}", body.trim()));
    }
    apply_session_headers(client, &headers).await;
    let results: PrestoResults =
        serde_json::from_str(&body).map_err(|e| format!("Presto response parse failed: {e}"))?;
    Ok(results)
}

pub(super) async fn post_statement(
    client: &PrestoClient,
    sql: &str,
    token: &CancellationToken,
    track_cancel: bool,
) -> Result<PrestoResults, String> {
    post_statement_with_context(client, sql, token, track_cancel, None, None).await
}

pub(super) async fn post_statement_with_context(
    client: &PrestoClient,
    sql: &str,
    token: &CancellationToken,
    track_cancel: bool,
    catalog_override: Option<&str>,
    schema_override: Option<&str>,
) -> Result<PrestoResults, String> {
    let statement = normalize_presto_statement(sql)?;
    let (catalog, schema) =
        request_context_with_overrides(client, catalog_override, schema_override).await;
    let req = add_presto_headers(
        client,
        client
            .client
            .post(format!("{}/v1/statement", client.base_url))
            .body(statement),
        catalog.as_deref(),
        schema.as_deref(),
    );
    let send = req.send();
    let resp = tokio::select! {
        _ = token.cancelled() => {
            cancel_current(client).await;
            return Err("Query cancelled".into());
        }
        r = send => r.map_err(|e| format!("Presto request failed: {e}"))?,
    };
    let results = read_results_response(client, resp).await?;
    if track_cancel {
        set_current_next_uri(client, results.next_uri.as_deref()).await;
    }
    Ok(results)
}

pub(super) async fn get_next(
    client: &PrestoClient,
    uri: &str,
    token: &CancellationToken,
    track_cancel: bool,
) -> Result<PrestoResults, String> {
    get_next_with_context(client, uri, token, track_cancel, None, None).await
}

pub(super) async fn get_next_with_context(
    client: &PrestoClient,
    uri: &str,
    token: &CancellationToken,
    track_cancel: bool,
    catalog_override: Option<&str>,
    schema_override: Option<&str>,
) -> Result<PrestoResults, String> {
    let (catalog, schema) =
        request_context_with_overrides(client, catalog_override, schema_override).await;
    let req = add_presto_headers(
        client,
        client.client.get(uri),
        catalog.as_deref(),
        schema.as_deref(),
    );
    let send = req.send();
    let resp = tokio::select! {
        _ = token.cancelled() => {
            cancel_current(client).await;
            return Err("Query cancelled".into());
        }
        r = send => r.map_err(|e| format!("Presto request failed: {e}"))?,
    };
    let results = read_results_response(client, resp).await?;
    if track_cancel {
        set_current_next_uri(client, results.next_uri.as_deref()).await;
    }
    Ok(results)
}

pub(super) async fn set_current_next_uri(client: &PrestoClient, next_uri: Option<&str>) {
    *client.current_next_uri.lock().await = next_uri.map(ToOwned::to_owned);
}

pub(super) async fn cancel_current(client: &PrestoClient) {
    let uri = client.current_next_uri.lock().await.clone();
    if let Some(uri) = uri {
        let _ = delete_uri(client, &uri).await;
    }
}

pub(super) async fn delete_uri(client: &PrestoClient, uri: &str) -> Result<(), String> {
    let (catalog, schema) = request_context(client).await;
    let req = add_presto_headers(
        client,
        client.client.delete(uri),
        catalog.as_deref(),
        schema.as_deref(),
    );
    req.send()
        .await
        .map_err(|e| format!("Presto cancel failed: {e}"))?;
    Ok(())
}
