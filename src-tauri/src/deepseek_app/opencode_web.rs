//! Go has no DeepSeek server tools. Use real configured search and bounded HTTPS
//! reads through the selected provider's shared proxy, with explicit failures.
use super::{client::MessagesClient, opencode_tools::ToolOutput};
use crate::state::AppState;
use futures::StreamExt;
use serde_json::{Value, json};

pub async fn execute(
    name: &str,
    args: &Value,
    state: &AppState,
    client: &MessagesClient,
) -> Result<ToolOutput, String> {
    let config = state.legacy.ai_ctx.read().await.config.clone();
    if config.full_local_mode || config.fully_disabled {
        return Err("disabled: external research is disabled".into());
    }
    if name == "read_url" {
        let raw = args["url"].as_str().ok_or("web: URL is required")?;
        let (url, text) = fetch(client, raw).await?;
        return Ok(ToolOutput {
            content: json!({"url":url,"untrusted_page_content":text}),
            sources: vec![json!({"id":url,"url":url,"title":url,"site":"HTTPS"})],
        });
    }
    let search = &config.web_search;
    if !search.client_enabled {
        return Err("configuration: enable a web search service in Settings for OpenCode research; local research remains available".into());
    }
    let query = args["query"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or("web: search query is required")?;
    let response = match search.client_provider.as_str() {
        "tavily" | "serper" => {
            let key = state
                .core
                .vault
                .resolve(&search.byok_key)
                .map_err(|_| "vault_locked: unlock the search credential")?
                .map(|s| s.to_string())
                .unwrap_or_else(|| search.byok_key.clone());
            if key.is_empty() {
                return Err("configuration: search API key missing".into());
            }
            if search.client_provider == "tavily" {
                client
                    .http
                    .post("https://api.tavily.com/search")
                    .json(&json!({"api_key":key,"query":query,"max_results":5}))
                    .send()
                    .await
            } else {
                client
                    .http
                    .post("https://google.serper.dev/search")
                    .header("X-API-KEY", key)
                    .json(&json!({"q":query,"num":5}))
                    .send()
                    .await
            }
        }
        _ => {
            let base = search
                .searxng_url
                .as_deref()
                .unwrap_or(crate::agent::search::instances::PUBLIC_INSTANCES[0])
                .trim_end_matches('/');
            crate::ai::network_policy::reject_if_remote(config.full_local_mode, base)?;
            client
                .http
                .get(format!("{base}/search"))
                .query(&[("q", query), ("format", "json")])
                .send()
                .await
        }
    }
    .map_err(|_| "network: web search connection or configured proxy failed")?;
    if !response.status().is_success() {
        return Err(format!(
            "web: search service returned HTTP {}",
            response.status().as_u16()
        ));
    }
    let bytes = bounded(response, 2 * 1024 * 1024).await?;
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|_| "web: search service did not return JSON")?;
    let rows = value["results"]
        .as_array()
        .or_else(|| value["organic"].as_array())
        .ok_or("web: search service returned no result list")?;
    let mut sources = Vec::new();
    for row in rows.iter().take(5) {
        let url = row["url"]
            .as_str()
            .or_else(|| row["link"].as_str())
            .unwrap_or("");
        if !url.starts_with("https://") {
            continue;
        }
        let title = row["title"].as_str().unwrap_or(url);
        let snippet = row["content"]
            .as_str()
            .or_else(|| row["snippet"].as_str())
            .unwrap_or("");
        let Some((summary, _)) = super::local_data::safe_excerpt(snippet, 800) else {
            continue;
        };
        sources.push(json!({"id":url,"url":url,"title":title,"summary":summary,"site":search.client_provider}));
    }
    Ok(ToolOutput {
        content: json!({"query":query,"untrusted_search_results":sources}),
        sources,
    })
}

async fn fetch(client: &MessagesClient, raw: &str) -> Result<(String, String), String> {
    let mut url = reqwest::Url::parse(raw).map_err(|_| "web: invalid URL")?;
    for _ in 0..6 {
        validate_url(&url).await?;
        let response = client
            .http
            .get(url.clone())
            .send()
            .await
            .map_err(|_| "network: page connection or configured proxy failed")?;
        if response.status().is_redirection() {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or("web: redirect has no location")?;
            url = url.join(location).map_err(|_| "web: invalid redirect")?;
            continue;
        }
        if !response.status().is_success() {
            return Err(format!(
                "web: page returned HTTP {}",
                response.status().as_u16()
            ));
        }
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        if !content_type.contains("text/") && !content_type.contains("application/json") {
            return Err("web: page is not readable text".into());
        }
        let bytes = bounded(response, 2 * 1024 * 1024).await?;
        let html = String::from_utf8_lossy(&bytes);
        // Keep parsing local and bounded; no scripts, images or subresources are loaded.
        let mut text = String::new();
        let mut in_tag = false;
        for ch in html.chars() {
            match ch {
                '<' => {
                    in_tag = true;
                    text.push(' ');
                }
                '>' => in_tag = false,
                _ if !in_tag => text.push(ch),
                _ => (),
            }
        }
        let (text, _) = super::local_data::safe_excerpt(&text, 12000)
            .ok_or("web: untrusted page instructions blocked")?;
        return Ok((url.to_string(), text));
    }
    Err("web: too many redirects".into())
}

async fn bounded(response: reqwest::Response, maximum: usize) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "network: web response interrupted")?;
        if bytes.len() + chunk.len() > maximum {
            return Err("web: response exceeds the safe size".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn validate_url(url: &reqwest::Url) -> Result<(), String> {
    if url.scheme() != "https"
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("web: only public HTTPS URLs without credentials are allowed".into());
    }
    let host = url.host_str().ok_or("web: URL host missing")?;
    let addresses = tokio::net::lookup_host((host, 443))
        .await
        .map_err(|_| "web: DNS lookup failed")?
        .collect::<Vec<_>>();
    if addresses.is_empty() || addresses.iter().any(|a| private(a.ip())) {
        return Err("web: private, local or reserved addresses cannot be fetched".into());
    }
    Ok(())
}

fn private(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(ip) => {
            ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_broadcast()
                || ip.is_documentation()
                || ip.is_unspecified()
                || ip.is_multicast()
                || ip.octets()[0] == 0
                || ip.octets()[0] >= 240
        }
        std::net::IpAddr::V6(ip) => {
            ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_multicast()
                || ip.is_unique_local()
                || ip.is_unicast_link_local()
                || ip.to_ipv4_mapped().is_some_and(|v| private(v.into()))
        }
    }
}
