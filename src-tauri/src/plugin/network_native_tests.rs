//! Real native Settings/Vault/proxy transport. Never run on a developer machine.
use super::super::*;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

async fn http_fixture(
    expected_authorization: Option<String>,
) -> (u16, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    let worker = tokio::spawn(async move {
        let (mut stream, _) = tokio::time::timeout(Duration::from_secs(5), listener.accept())
            .await
            .unwrap()
            .unwrap();
        let mut bytes = Vec::new();
        tokio::time::timeout(Duration::from_secs(5), async {
            while !bytes.ends_with(b"\r\n\r\n") {
                bytes.push(stream.read_u8().await.unwrap());
                assert!(bytes.len() < 16384);
            }
        })
        .await
        .unwrap();
        let headers = String::from_utf8(bytes).unwrap().to_ascii_lowercase();
        match expected_authorization {
            Some(value) => {
                assert!(
                    headers
                        .starts_with("get http://module.example.invalid/modules.json http/1.1\r\n"),
                    "request must reach the selected HTTP proxy"
                );
                assert!(
                    headers.contains(&format!(
                        "\r\nproxy-authorization: {}\r\n",
                        value.to_ascii_lowercase()
                    )),
                    "resolved Vault credentials must reach the selected proxy"
                );
            }
            None => assert!(!headers.contains("proxy-authorization:")),
        }
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
            .await
            .unwrap();
    });
    (port, worker)
}

fn authenticated(port: u16, reference: String) -> AppProxyConfig {
    AppProxyConfig {
        enabled: true,
        host: "127.0.0.1".into(),
        port,
        username: "module-user".into(),
        password_ref: reference,
        ..Default::default()
    }
}

#[tokio::test]
#[ignore = "real native Settings/Vault/network contract: GitHub runners only"]
async fn persisted_application_proxy_resolves_vault_auth_and_rereads_failures_without_direct_fallback()
 {
    let directory = tempfile::tempdir().unwrap();
    let application = directory.path().join("proxy.json");
    let settings_path = directory.path().join("modules-network.json");
    let vault = Vault::open(&directory.path().join("vault.db")).unwrap();
    vault.init("module proxy fixture").unwrap();
    let credential = vault
        .put("module_proxy", "Module proxy fixture", "module-secret")
        .unwrap();
    use base64::Engine;
    let expected = format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD.encode("module-user:module-secret")
    );
    let (port, server) = http_fixture(Some(expected)).await;
    authenticated(port, credential.reference)
        .save(&application)
        .unwrap();
    ModuleNetworkConfig::default().save(&settings_path).unwrap();
    let settings = ModuleNetworkConfig::load(&settings_path).unwrap();
    let client = service(&settings, &application, None, Some(&vault)).unwrap();
    assert_eq!(
        client
            .fetch_metadata("http://module.example.invalid/modules.json", 1024)
            .await
            .unwrap(),
        b"{}"
    );
    server.await.unwrap();
    assert!(
        !fs::read_to_string(&application)
            .unwrap()
            .contains("module-secret")
    );

    let origin = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let url = format!("http://{}/modules.json", origin.local_addr().unwrap());
    authenticated(9, String::new()).save(&application).unwrap();
    let changed = service(&settings, &application, None, Some(&vault)).unwrap();
    assert!(
        tokio::time::timeout(Duration::from_secs(5), changed.fetch_metadata(&url, 1024))
            .await
            .unwrap()
            .is_err()
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(250), origin.accept())
            .await
            .is_err(),
        "configured proxy failure must not open a direct connection"
    );
    vault.lock().unwrap();
}

#[tokio::test]
#[ignore = "real native three-mode network contract: GitHub runners only"]
async fn persisted_custom_proxy_and_no_proxy_bypass_application_config_and_environment() {
    let directory = tempfile::tempdir().unwrap();
    let application = directory.path().join("proxy.json");
    fs::write(
        &application,
        "corrupt application proxy must be ignored in explicit modes",
    )
    .unwrap();
    let before = fs::read(&application).unwrap();
    let settings_path = directory.path().join("modules-network.json");
    let (port, server) = http_fixture(Some("Basic bW9kdWxlLXVzZXI6".into())).await;
    ModuleNetworkConfig {
        mode: "custom".into(),
        custom: authenticated(port, String::new()),
    }
    .save(&settings_path)
    .unwrap();
    let custom = ModuleNetworkConfig::load(&settings_path).unwrap();
    let client = service(&custom, &application, None, None).unwrap();
    assert_eq!(
        client
            .fetch_metadata("http://module.example.invalid/modules.json", 1024)
            .await
            .unwrap(),
        b"{}"
    );
    server.await.unwrap();

    ModuleNetworkConfig {
        mode: "none".into(),
        ..custom
    }
    .save(&settings_path)
    .unwrap();
    let direct = ModuleNetworkConfig::load(&settings_path).unwrap();
    let (port, server) = http_fixture(None).await;
    let client = service(&direct, &application, None, None).unwrap();
    assert_eq!(
        client
            .fetch_metadata(&format!("http://127.0.0.1:{port}/modules.json"), 1024)
            .await
            .unwrap(),
        b"{}"
    );
    server.await.unwrap();
    assert_eq!(fs::read(&application).unwrap(), before);
}
