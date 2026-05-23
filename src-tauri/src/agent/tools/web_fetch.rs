use crate::agent::tools::{Tool, ToolDescriptor, ToolResult};
use async_trait::async_trait;
use reqwest::Client;
use std::net::IpAddr;
use std::time::Duration;

pub struct WebFetchTool {
    client: Client,
}

impl WebFetchTool {
    pub fn new() -> Self {
        Self {
            client: Client::builder()
                .timeout(Duration::from_secs(10))
                .user_agent("NewMob/0.1 (web_fetch)")
                .build()
                .expect("failed to build reqwest client"),
        }
    }
}

/// SSRF defense: reject RFC1918, loopback, and link-local addresses.
fn is_private_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_unspecified()
        }
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
        }
    }
}

async fn resolve_and_check(host: &str) -> Result<(), String> {
    use tokio::net::lookup_host;
    let addrs: Vec<_> = lookup_host(format!("{}:443", host))
        .await
        .map_err(|e| format!("DNS resolution failed: {}", e))?
        .collect();

    if addrs.is_empty() {
        return Err("DNS resolution returned no addresses".into());
    }

    for addr in &addrs {
        if is_private_ip(addr.ip()) {
            return Err(format!(
                "SSRF blocked: {} resolves to private/loopback address {}",
                host, addr.ip()
            ));
        }
    }
    Ok(())
}

#[async_trait]
impl Tool for WebFetchTool {
    fn descriptor(&self) -> ToolDescriptor {
        ToolDescriptor {
            name: "web_fetch",
            description: "抓取一个 URL 的可读内容（已去广告/导航）。仅允许公网 HTTPS。",
            params: "url: string",
        }
    }

    async fn execute(&self, args: &serde_json::Value) -> ToolResult {
        let url_str = match args.get("url").and_then(|v| v.as_str()) {
            Some(u) => u.to_string(),
            None => return ToolResult::err("web_fetch", "url is required"),
        };

        // Parse URL.
        let url = match url::Url::parse(&url_str) {
            Ok(u) => u,
            Err(e) => return ToolResult::err("web_fetch", format!("Invalid URL: {}", e)),
        };

        // HTTPS only.
        if url.scheme() != "https" {
            return ToolResult::err("web_fetch", "Only HTTPS URLs are allowed");
        }

        // Port must be 443 or default.
        if let Some(port) = url.port() {
            if port != 443 {
                return ToolResult::err("web_fetch", "Only port 443 is allowed");
            }
        }

        // SSRF: resolve and check.
        let host = match url.host_str() {
            Some(h) => h.to_string(),
            None => return ToolResult::err("web_fetch", "URL has no host"),
        };

        if let Err(e) = resolve_and_check(&host).await {
            return ToolResult::err("web_fetch", e);
        }

        // Fetch.
        let resp = match self.client.get(&url_str).send().await {
            Ok(r) => r,
            Err(e) => return ToolResult::err("web_fetch", format!("Request failed: {}", e)),
        };

        let content_type = resp.headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_lowercase();

        // Reject non-text content.
        if !content_type.contains("text/") && !content_type.contains("application/json") {
            return ToolResult::err("web_fetch", format!("Unsupported content type: {}", content_type));
        }

        // Read body with 2MB limit.
        const MAX_BYTES: usize = 2 * 1024 * 1024;
        let bytes = match resp.bytes().await {
            Ok(b) => b,
            Err(e) => return ToolResult::err("web_fetch", format!("Failed to read body: {}", e)),
        };

        let truncated = bytes.len() > MAX_BYTES;
        let text = String::from_utf8_lossy(&bytes[..bytes.len().min(MAX_BYTES)]).to_string();

        let result = if content_type.contains("text/html") {
            // Strip HTML tags for a basic readable version.
            strip_html(&text)
        } else {
            text
        };

        let mut output = result;
        if truncated {
            output.push_str("\n\n[内容已截断，超过 2MB 限制]");
        }

        ToolResult::ok("web_fetch", output)
    }
}

/// Lightweight HTML → readable text. Strips `<script>` / `<style>` /
/// `<nav>` / `<aside>` / `<footer>` blocks, then drops the remaining tags
/// and decodes a small set of common HTML entities. Not as good as a real
/// readability extractor, but predictable, no-deps, and adequate for the
/// agent's "skim this page" use case.
fn strip_html(html: &str) -> String {
    let lower = html.to_lowercase();
    let chars: Vec<char> = html.chars().collect();
    let lower_chars: Vec<char> = lower.chars().collect();

    let mut result = String::with_capacity(html.len() / 2);
    let mut in_tag = false;
    let mut in_block: Option<&'static str> = None;

    let block_starters: &[(&str, &str)] = &[
        ("<script", "</script"),
        ("<style", "</style"),
        ("<nav", "</nav"),
        ("<aside", "</aside"),
        ("<footer", "</footer"),
        ("<noscript", "</noscript"),
    ];

    let mut i = 0;
    while i < chars.len() {
        // Are we inside a block we want to skip entirely?
        if let Some(end) = in_block {
            let look = &lower_chars[i..(i + end.len()).min(lower_chars.len())];
            if look.iter().collect::<String>() == end {
                in_block = None;
            }
            i += 1;
            continue;
        }

        // Open a skipped block?
        if chars[i] == '<' {
            let lookahead: String = lower_chars[i..(i + 10).min(lower_chars.len())].iter().collect();
            if let Some((_, end)) = block_starters.iter().find(|(s, _)| lookahead.starts_with(s)) {
                in_block = Some(end);
                i += 1;
                continue;
            }
            in_tag = true;
        } else if chars[i] == '>' {
            in_tag = false;
        } else if !in_tag {
            result.push(chars[i]);
        }
        i += 1;
    }

    // Decode common entities.
    let result = result
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'");

    // Collapse whitespace.
    let mut collapsed = String::with_capacity(result.len());
    let mut last_space = true;
    for c in result.chars() {
        if c.is_whitespace() {
            if !last_space { collapsed.push(' '); }
            last_space = true;
        } else {
            collapsed.push(c);
            last_space = false;
        }
    }
    collapsed.trim().to_string()
}
