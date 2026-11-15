use super::Fixture;
use crate::proxy::ResolvedProxy;
use crate::viewer::html::{close_html, open_html, serve_async};
use base64::Engine;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::http::{Request, StatusCode};

fn route(session: &crate::viewer::html::HtmlSession, target: &str) -> String {
    format!(
        "{}/_net/{}",
        session.url.rsplit_once('/').unwrap().0,
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(target)
    )
}

async fn get(url: &str, owner: &str) -> tauri::http::Response<Vec<u8>> {
    serve_async(
        Request::builder().uri(url).body(Vec::new()).unwrap(),
        owner.into(),
    )
    .await
}

fn server(
    responses: Vec<(&'static str, Vec<u8>)>,
) -> (String, Arc<Mutex<Vec<String>>>, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let observed = requests.clone();
    let thread = std::thread::spawn(move || {
        for (headers, bytes) in responses {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut request = [0u8; 16384];
            let length = stream.read(&mut request).unwrap();
            observed
                .lock()
                .unwrap()
                .push(String::from_utf8_lossy(&request[..length]).into_owned());
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nConnection: close\r\n{headers}\r\nContent-Length: {}\r\n\r\n",
                bytes.len()
            )
            .unwrap();
            let _ = stream.write_all(&bytes);
        }
    });
    (endpoint, requests, thread)
}

#[tokio::test]
async fn proxy_transport_rewrites_html_and_remote_relative_css_without_browser_credentials() {
    let (endpoint, requests, thread) = server(vec![
        (
            "Content-Type: text/css",
            b"@import 'nested/theme.css'; body{background:url(../images/bg.png)}".to_vec(),
        ),
        (
            "Content-Type: text/javascript",
            b"console.log('remote script')".to_vec(),
        ),
    ]);
    let fixture = Fixture::new("index.html", format!("<link rel=stylesheet href='{endpoint}/styles/app.css'><img srcset='{endpoint}/a.png 1x, {endpoint}/b.png 2x'><script src='{endpoint}/app.js'></script>").as_bytes());
    let session = open_html(fixture.path(), true, true, "network-rewrite", None).unwrap();
    let local = get(&session.url, "network-rewrite").await;
    assert_eq!(local.status(), StatusCode::OK);
    let body = String::from_utf8(local.body().clone()).unwrap();
    assert!(body.contains("/_net/"));
    assert!(!body.contains(&format!("src=\"{endpoint}")));
    let css = get(
        &route(&session, &format!("{endpoint}/styles/app.css")),
        "network-rewrite",
    )
    .await;
    assert_eq!(css.status(), StatusCode::OK);
    let css = String::from_utf8(css.body().clone()).unwrap();
    for expected in [
        format!("{endpoint}/styles/nested/theme.css"),
        format!("{endpoint}/images/bg.png"),
    ] {
        assert!(css.contains(&base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(expected)));
    }
    let js = get(
        &route(&session, &format!("{endpoint}/app.js")),
        "network-rewrite",
    )
    .await;
    assert_eq!(js.status(), StatusCode::OK);
    assert_eq!(js.body(), b"console.log('remote script')");
    close_html(&session.token, "network-rewrite").unwrap();
    thread.join().unwrap();
    assert_eq!(requests.lock().unwrap().len(), 2);
    for request in requests.lock().unwrap().iter() {
        assert!(!request.to_ascii_lowercase().contains("authorization:"));
        assert!(!request.to_ascii_lowercase().contains("cookie:"));
        assert!(!request.to_ascii_lowercase().contains("referer:"));
    }
}

#[tokio::test]
async fn network_is_opt_in_owner_scoped_and_credentialless_get_only() {
    let fixture = Fixture::new("index.html", b"<p>hello</p>");
    let blocked = open_html(fixture.path(), false, true, "blocked", None).unwrap();
    let url = route(&blocked, "http://127.0.0.1:9/never");
    assert_eq!(get(&url, "blocked").await.status(), StatusCode::FORBIDDEN);
    close_html(&blocked.token, "blocked").unwrap();
    let session = open_html(fixture.path(), true, true, "network-validation", None).unwrap();
    for url in [
        "file:///etc/passwd",
        "ipc://localhost/x",
        "http://user:pass@example.com/x",
        "http://ipc.localhost/x",
        "http://taomni-preview.localhost/x",
    ] {
        assert_eq!(
            get(&route(&session, url), "network-validation")
                .await
                .status(),
            StatusCode::FORBIDDEN
        );
    }
    let url = route(&session, "http://127.0.0.1:9/never");
    assert_eq!(
        get(&url, "wrong-owner").await.status(),
        StatusCode::FORBIDDEN
    );
    let request = Request::builder()
        .method("POST")
        .uri(&url)
        .body(Vec::new())
        .unwrap();
    assert_eq!(
        serve_async(request, "network-validation".into())
            .await
            .status(),
        StatusCode::METHOD_NOT_ALLOWED
    );
    close_html(&session.token, "network-validation").unwrap();
    assert_eq!(
        get(&url, "network-validation").await.status(),
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn configured_proxy_failure_does_not_fall_back_to_reachable_direct_server() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let target = format!("http://{}/direct", listener.local_addr().unwrap());
    listener.set_nonblocking(true).unwrap();
    let unavailable_proxy = TcpListener::bind("127.0.0.1:0").unwrap();
    let proxy_port = unavailable_proxy.local_addr().unwrap().port();
    drop(unavailable_proxy);
    let proxy = ResolvedProxy {
        kind: "http".into(),
        host: "127.0.0.1".into(),
        port: proxy_port,
        username: String::new(),
        password: String::new(),
    };
    let fixture = Fixture::new("index.html", b"<p>hello</p>");
    let session = open_html(fixture.path(), true, true, "proxy-failure", Some(&proxy)).unwrap();
    let response = get(&route(&session, &target), "proxy-failure").await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert!(String::from_utf8_lossy(response.body()).contains("selected proxy"));
    assert!(listener.accept().is_err());
    close_html(&session.token, "proxy-failure").unwrap();
}

#[tokio::test]
async fn selected_http_proxy_receives_absolute_request_and_not_browser_auth() {
    let (endpoint, requests, thread) =
        server(vec![("Content-Type: text/plain", b"proxied".to_vec())]);
    let address = url::Url::parse(&endpoint).unwrap();
    let proxy = ResolvedProxy {
        kind: "http".into(),
        host: "127.0.0.1".into(),
        port: address.port().unwrap(),
        username: String::new(),
        password: String::new(),
    };
    let fixture = Fixture::new("index.html", b"<p>hello</p>");
    let session = open_html(fixture.path(), true, true, "proxy-success", Some(&proxy)).unwrap();
    let response = get(
        &route(&session, "http://example.invalid/resource"),
        "proxy-success",
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.body(), b"proxied");
    thread.join().unwrap();
    assert!(requests.lock().unwrap()[0].starts_with("GET http://example.invalid/resource "));
    close_html(&session.token, "proxy-success").unwrap();
}

#[tokio::test]
async fn closing_token_cancels_inflight_network_read() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/slow", listener.local_addr().unwrap());
    let fixture = Fixture::new("index.html", b"<p>hello</p>");
    let session = open_html(fixture.path(), true, true, "network-cancel", None).unwrap();
    let url = route(&session, &endpoint);
    let request = tokio::spawn(async move { get(&url, "network-cancel").await });
    let (_stream, _) = tokio::time::timeout(Duration::from_secs(2), listener.accept())
        .await
        .unwrap()
        .unwrap();
    close_html(&session.token, "network-cancel").unwrap();
    let result = tokio::time::timeout(Duration::from_millis(500), request)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result.status(), StatusCode::FORBIDDEN);
    assert!(String::from_utf8_lossy(result.body()).contains("closed"));
}

#[tokio::test]
async fn oversized_network_responses_and_redirects_to_credentials_are_rejected() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let target = format!("http://{}/huge", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut request = [0u8; 1024];
        let _ = stream.read(&mut request);
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
            crate::viewer::network::MAX_RESOURCE + 1
        )
        .unwrap();
    });
    let fixture = Fixture::new("index.html", b"<p>hello</p>");
    let session = open_html(fixture.path(), true, true, "network-limit", None).unwrap();
    assert_eq!(
        get(&route(&session, &target), "network-limit")
            .await
            .status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
    server.join().unwrap();
    close_html(&session.token, "network-limit").unwrap();
}

#[test]
fn no_proxy_client_explicitly_disables_implicit_environment_routing() {
    const CHILD: &str = "TAOMNI_VIEWER_NO_PROXY_CHILD_URL";
    if let Ok(target) = std::env::var(CHILD) {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let fixture = Fixture::new("index.html", b"<p>child</p>");
            let session = open_html(fixture.path(), true, true, "proxy-env-child", None).unwrap();
            let response = get(&route(&session, &target), "proxy-env-child").await;
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.body(), b"direct despite proxy environment");
            close_html(&session.token, "proxy-env-child").unwrap();
        });
        return;
    }
    // Set environment only for an isolated subprocess, never mutate the
    // multithreaded parent process environment (unsafe in Rust 2024).
    let (target, requests, thread) = server(vec![(
        "Content-Type: text/plain",
        b"direct despite proxy environment".to_vec(),
    )]);
    let implicit = TcpListener::bind("127.0.0.1:0").unwrap();
    implicit.set_nonblocking(true).unwrap();
    let proxy = format!("http://{}", implicit.local_addr().unwrap());
    let mut child = std::process::Command::new(std::env::current_exe().unwrap());
    child.args(["--exact", "viewer::tests::network::no_proxy_client_explicitly_disables_implicit_environment_routing", "--nocapture"])
        .env(CHILD, target).env("NO_PROXY", "").env("no_proxy", "");
    for key in [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ] {
        child.env(key, &proxy);
    }
    let output = child.output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    thread.join().unwrap();
    assert_eq!(requests.lock().unwrap().len(), 1);
    assert!(
        implicit.accept().is_err(),
        "No-proxy request reached the environment proxy"
    );
    let invalid = crate::proxy::AppProxyConfig {
        enabled: true,
        ..Default::default()
    };
    assert!(crate::proxy::resolve_strict_with_db(&invalid, None, None).is_err());
}
