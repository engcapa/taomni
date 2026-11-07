//! Exercise the same live/persisted policy used by Settings over real HTTP/WS.
use super::{Core, ListenerConfig, service_tests::Fixture};
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

const PROXY_HOST: &str = "2345463-proxy-8787.dsw-gateway-cn-hangzhou.data.aliyun.com";

async fn health(f: &Fixture, host: &str) -> reqwest::Response {
    f.client
        .get(format!("{}/api/v1/health", f.endpoint))
        .header("Host", host)
        .send()
        .await
        .unwrap()
}

fn profile(f: &Fixture) -> std::path::PathBuf {
    f.state.mobile.profile_data.lock().unwrap().clone().unwrap()
}

#[tokio::test]
async fn domain_settings_apply_live_persist_and_restore_without_stopping_listener() {
    let f = Fixture::new().await;
    let data = profile(&f);
    assert_eq!(health(&f, PROXY_HOST).await.status(), 403);
    let config = ListenerConfig {
        allowed_hosts: vec![PROXY_HOST.into(), "pc.example.com:8443".into()],
        allow_all_hosts: false,
    };
    assert_eq!(
        f.state
            .mobile
            .save_listener_config(&data, config.clone())
            .await
            .unwrap(),
        config
    );
    assert_eq!(health(&f, PROXY_HOST).await.status(), 200);
    assert_eq!(health(&f, "pc.example.com:8443").await.status(), 200);
    assert_eq!(health(&f, "pc.example.com").await.status(), 403);
    assert_eq!(
        health(&f, &format!("{PROXY_HOST}:8787")).await.status(),
        403
    );
    assert_eq!(health(&f, "other.example").await.status(), 403);
    assert_eq!(
        f.client
            .get(format!("{}/", f.endpoint))
            .header("Host", PROXY_HOST)
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    assert_eq!(
        f.client
            .get(format!("{}/api/v1/health", f.endpoint))
            .header("Host", "unlisted.example")
            .header("X-Forwarded-Host", PROXY_HOST)
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    let all = ListenerConfig {
        allow_all_hosts: true,
        ..config.clone()
    };
    f.state
        .mobile
        .save_listener_config(&data, all.clone())
        .await
        .unwrap();
    assert_eq!(health(&f, "other.example:1234").await.status(), 200);
    assert_eq!(f.state.mobile.listener_config(&data).await.unwrap(), all);
    assert_eq!(ListenerConfig::load(&data).unwrap(), all);

    f.state.mobile.stop().await;
    assert_eq!(f.state.mobile.listener_config(&data).await.unwrap(), all);
    let restarted = f
        .state
        .mobile
        .start(Core::Headless(f.state.clone()), data.clone(), false, 0)
        .await
        .unwrap();
    let response = f
        .client
        .get(format!("{restarted}/api/v1/health"))
        .header("Host", "other.example:1234")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    f.state
        .mobile
        .save_listener_config(&data, config.clone())
        .await
        .unwrap();
    assert_eq!(ListenerConfig::load(&data).unwrap(), config);
    let response = f
        .client
        .get(format!("{restarted}/api/v1/health"))
        .header("Host", "other.example:1234")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 403);
    assert_eq!(
        response.json::<Value>().await.unwrap(),
        json!({"error":"host_denied"})
    );
    assert_eq!(
        f.client
            .get(format!("{restarted}/api/v1/health"))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    f.finish().await;
}

#[tokio::test]
async fn allow_all_hosts_does_not_bypass_bearer_origin_or_one_time_websocket_tickets() {
    let f = Fixture::new().await;
    let data = profile(&f);
    f.state
        .mobile
        .save_listener_config(
            &data,
            ListenerConfig {
                allow_all_hosts: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let origin = format!("https://{PROXY_HOST}");
    let code = f.state.mobile.auth.lock().unwrap().pairing_code();
    let pair: Value = f
        .client
        .post(format!("{}/api/v1/pair", f.endpoint))
        .header("Host", PROXY_HOST)
        .header("Origin", &origin)
        .json(&json!({"endpoint_label":"proxy phone","pairing_code":code}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let token = pair["token"].as_str().unwrap();
    let unauth = f
        .client
        .get(format!("{}/api/v1/sessions", f.endpoint))
        .header("Host", PROXY_HOST)
        .header("Origin", &origin)
        .send()
        .await
        .unwrap();
    assert_eq!(unauth.status(), 401);
    let denied = f
        .client
        .get(format!("{}/api/v1/sessions", f.endpoint))
        .header("Host", PROXY_HOST)
        .header("Origin", "https://evil.example")
        .bearer_auth(token)
        .send()
        .await
        .unwrap();
    assert_eq!(denied.status(), 403);
    assert_eq!(
        denied.json::<Value>().await.unwrap(),
        json!({"error":"origin_denied"})
    );
    let allowed = f
        .client
        .get(format!("{}/api/v1/sessions", f.endpoint))
        .header("Host", PROXY_HOST)
        .header("Origin", &origin)
        .bearer_auth(token)
        .send()
        .await
        .unwrap();
    assert_eq!(allowed.status(), 200);
    let ticket: Value = f
        .client
        .post(format!("{}/api/v1/ws-ticket", f.endpoint))
        .header("Host", PROXY_HOST)
        .header("Origin", &origin)
        .bearer_auth(token)
        .json(&json!({}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let mut request = format!(
        "{}/api/v1/events?ticket={}",
        f.endpoint.replace("http:", "ws:"),
        ticket["ticket"].as_str().unwrap()
    )
    .into_client_request()
    .unwrap();
    request
        .headers_mut()
        .insert("Host", PROXY_HOST.parse().unwrap());
    request
        .headers_mut()
        .insert("Origin", origin.parse().unwrap());
    let (mut socket, _) = tokio_tungstenite::connect_async(request.clone())
        .await
        .unwrap();
    match tokio_tungstenite::connect_async(request).await.unwrap_err() {
        tokio_tungstenite::tungstenite::Error::Http(response) => assert_eq!(response.status(), 401),
        other => panic!("Expected an unauthorized ticket replay: {other}"),
    }
    socket.close(None).await.unwrap();
    f.finish().await;
}

#[tokio::test]
async fn failed_validation_or_persistence_leaves_live_and_saved_restrictions_unchanged() {
    let f = Fixture::new().await;
    let data = profile(&f);
    let config = ListenerConfig {
        allowed_hosts: vec![PROXY_HOST.into()],
        allow_all_hosts: false,
    };
    f.state
        .mobile
        .save_listener_config(&data, config.clone())
        .await
        .unwrap();
    assert_eq!(
        f.state
            .mobile
            .save_listener_config(
                &data,
                ListenerConfig {
                    allowed_hosts: vec!["https://bad.example/".into()],
                    allow_all_hosts: true
                }
            )
            .await
            .unwrap_err(),
        "invalid_mobile_host"
    );
    assert_eq!(ListenerConfig::load(&data).unwrap(), config);
    assert_eq!(health(&f, "unlisted.example").await.status(), 403);
    let file_as_directory = data.join("not-a-directory");
    std::fs::write(&file_as_directory, "obstruct config write").unwrap();
    assert_eq!(
        f.state
            .mobile
            .save_listener_config(
                &file_as_directory,
                ListenerConfig {
                    allow_all_hosts: true,
                    ..config.clone()
                }
            )
            .await
            .unwrap_err(),
        "mobile_listener_write_failed"
    );
    assert_eq!(f.state.mobile.listener_config(&data).await.unwrap(), config);
    assert_eq!(ListenerConfig::load(&data).unwrap(), config);
    assert_eq!(health(&f, "unlisted.example").await.status(), 403);
    assert_eq!(health(&f, PROXY_HOST).await.status(), 200);
    f.finish().await;
}
