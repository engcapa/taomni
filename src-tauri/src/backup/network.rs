use super::model::NetworkConfig;
use crate::{
    proxy::{self, AppProxyConfig},
    state::AppState,
};
use std::time::Duration;

pub fn client(state: &AppState, settings: &NetworkConfig) -> Result<reqwest::Client, String> {
    let config = match settings.mode.as_str() {
        "none" => None,
        "app" => Some(AppProxyConfig::load(&proxy::default_app_proxy_path())),
        "custom" => Some(AppProxyConfig {
            enabled: true,
            ..settings.custom.clone()
        }),
        _ => return Err("Unknown backup proxy mode".into()),
    };
    let mut explicit_proxy = None;
    if let Some(config) = config.filter(|c| c.enabled) {
        if config.mode == "manual"
            && (config.host.trim().is_empty()
                || config.port == 0
                || !["http", "socks5"].contains(&config.kind.as_str()))
        {
            return Err("Configure the backup proxy host, port and protocol".into());
        }
        if config.mode == "session" && config.session_id.trim().is_empty() {
            return Err("Select a backup proxy session".into());
        }
        if !config.password_ref.is_empty() {
            state
                .vault
                .resolve(&config.password_ref)
                .map_err(|_| "Unlock the vault to use the configured proxy")?;
        }
        let resolved = proxy::resolve(state, &config)?
            .ok_or("Configured backup proxy could not be resolved")?;
        explicit_proxy = Some(
            reqwest::Proxy::all(resolved.to_url())
                .map_err(|_| "Invalid backup proxy configuration")?,
        );
    }
    transport(explicit_proxy)
}
fn transport(explicit_proxy: Option<reqwest::Proxy>) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::none());
    if let Some(proxy) = explicit_proxy {
        builder = builder.proxy(proxy);
    }
    builder
        .build()
        .map_err(|_| "Could not initialize backup network client".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn no_proxy_child() {
        let Ok(url) = std::env::var("TAOMNI_BACKUP_DIRECT_TEST_URL") else {
            return;
        };
        assert_eq!(
            transport(None)
                .unwrap()
                .get(url)
                .send()
                .await
                .unwrap()
                .status(),
            reqwest::StatusCode::OK
        );
    }
    #[tokio::test]
    async fn direct_bypasses_environment_and_bad_proxy_never_falls_back() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/fixture", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = [0; 8192];
            socket.read(&mut bytes).await.unwrap();
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .await
                .unwrap();
            assert!(
                tokio::time::timeout(Duration::from_millis(300), listener.accept())
                    .await
                    .is_err()
            );
        });
        let process_url = url.clone();
        let status = tokio::task::spawn_blocking(move || {
            std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "backup::network::tests::no_proxy_child"])
                .env("TAOMNI_BACKUP_DIRECT_TEST_URL", process_url)
                .env("HTTP_PROXY", "http://127.0.0.1:1")
                .env("HTTPS_PROXY", "http://127.0.0.1:1")
                .env("ALL_PROXY", "http://127.0.0.1:1")
                .env("NO_PROXY", "")
                .stdout(std::process::Stdio::null())
                .status()
                .unwrap()
        })
        .await
        .unwrap();
        assert!(status.success());
        let bad = transport(Some(reqwest::Proxy::all("http://127.0.0.1:1").unwrap())).unwrap();
        assert!(bad.get(url).send().await.is_err());
        server.await.unwrap();
    }
}

pub fn network_error(e: reqwest::Error) -> String {
    // reqwest error Display may contain signed URLs or authorization callback data.
    if e.is_timeout() {
        "Backup network timeout; check the connection or proxy".into()
    } else if e.is_connect() {
        "Cannot connect to backup service; check the connection or proxy".into()
    } else {
        "Backup network request failed".into()
    }
}

pub async fn json(response: reqwest::Response) -> Result<serde_json::Value, String> {
    let status = response.status();
    let value: serde_json::Value = response
        .json()
        .await
        .map_err(|_| format!("Invalid service response (HTTP {})", status.as_u16()))?;
    let code = value["code"].as_i64().unwrap_or(0);
    if !status.is_success() || code != 0 || value.get("error").is_some() {
        return Err(format!(
            "Feishu request failed (HTTP {}, code {}). Check application permissions and reconnect if authorization expired.",
            status.as_u16(),
            code
        ));
    }
    Ok(value)
}
