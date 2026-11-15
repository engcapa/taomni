use super::Fixture;
use crate::viewer::html::{HtmlSession, close_html, serve};

fn open_html(path: &str, network: bool, scripts: bool, owner: &str) -> Result<HtmlSession, String> {
    crate::viewer::html::open_html(path, network, scripts, owner, None)
}
use std::fs;
use tauri::http::{Request, StatusCode};

fn get(url: &str, owner: &str) -> tauri::http::Response<Vec<u8>> {
    serve(
        &Request::builder().uri(url).body(Vec::new()).unwrap(),
        owner,
    )
}

#[test]
fn html_protocol_is_get_only_token_and_owner_scoped_and_revocable() {
    let fixture = Fixture::new("index.html", b"<!doctype html><h1>hello</h1>");
    let session = open_html(fixture.path(), false, true, "test-html").unwrap();
    let response = get(&session.url, "test-html");
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["Cache-Control"], "no-store");
    assert_eq!(response.headers()["Access-Control-Allow-Origin"], "null");
    assert!(String::from_utf8_lossy(response.body()).contains("taomni-html-preview"));
    assert_eq!(
        get(&session.url, "another-webview").status(),
        StatusCode::FORBIDDEN
    );
    for method in ["POST", "PUT", "HEAD", "DELETE", "OPTIONS"] {
        let request = Request::builder()
            .method(method)
            .uri(&session.url)
            .body(Vec::new())
            .unwrap();
        assert_eq!(
            serve(&request, "test-html").status(),
            StatusCode::METHOD_NOT_ALLOWED
        );
    }
    assert!(close_html(&session.token, "another-webview").is_err());
    close_html(&session.token, "test-html").unwrap();
    assert_eq!(
        get(&session.url, "test-html").status(),
        StatusCode::FORBIDDEN
    );
}

#[test]
fn html_local_descendants_load_but_all_traversal_and_bad_origins_are_denied() {
    let fixture = Fixture::new("中 文50%.html", b"<h1>hello</h1>");
    let root = fixture.path.parent().unwrap();
    fs::create_dir(root.join("assets")).unwrap();
    fs::write(root.join("assets/app.css"), b"h1{color:red}").unwrap();
    fs::write(root.join("50%.css"), b"body{}").unwrap();
    let session = open_html(fixture.path(), false, true, "test-paths").unwrap();
    assert_eq!(get(&session.url, "test-paths").status(), StatusCode::OK);
    let prefix = session.url.rsplit_once('/').unwrap().0;
    let style = get(&format!("{prefix}/assets/app.css?version=1"), "test-paths");
    assert_eq!(style.status(), StatusCode::OK);
    assert_eq!(style.headers()["Content-Type"], "text/css");
    assert_eq!(style.body(), b"h1{color:red}");
    assert_eq!(
        get(&format!("{prefix}/50%25.css"), "test-paths").status(),
        StatusCode::OK
    );
    for traversal in [
        "../secret",
        "%2e%2e/secret",
        "%252e%252e/secret",
        "assets/%2E%2E/secret",
        "%2ftmp/secret",
        "%5ctmp%5csecret",
        "C%3a/secret",
        "assets//app.css",
        "assets/./app.css",
        "assets/%00.css",
        "assets/%GG.css",
        "assets/%",
    ] {
        assert_eq!(
            get(&format!("{prefix}/{traversal}"), "test-paths").status(),
            StatusCode::FORBIDDEN,
            "{traversal}"
        );
    }
    for url in [
        format!("taomni-preview://evil/{}/index.html", session.token),
        format!("taomni-preview://localhost:80/{}/index.html", session.token),
        format!("http://evil.localhost/{}/index.html", session.token),
        format!(
            "http://user@taomni-preview.localhost/{}/index.html",
            session.token
        ),
    ] {
        assert_eq!(get(&url, "test-paths").status(), StatusCode::FORBIDDEN);
    }
    // The localhost spelling is accepted by the actual handler on every
    // platform; macOS uses it because WKWebView custom-scheme iframes fail to
    // commit, while Windows/Android already use it.
    let windows = format!(
        "http://taomni-preview.localhost/{}/50%25.css",
        session.token
    );
    assert_eq!(get(&windows, "test-paths").status(), StatusCode::OK);
    close_html(&session.token, "test-paths").unwrap();
}

#[cfg(unix)]
#[test]
fn html_protocol_rejects_file_and_directory_symlink_escapes_and_pins_root() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new("index.html", b"<p>root</p>");
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("secret.css"), b"secret").unwrap();
    let root = fixture.path.parent().unwrap();
    symlink(outside.path(), root.join("escape")).unwrap();
    symlink(outside.path().join("secret.css"), root.join("secret.css")).unwrap();
    let session = open_html(fixture.path(), false, true, "test-symlinks").unwrap();
    let prefix = session.url.rsplit_once('/').unwrap().0;
    for resource in ["escape/secret.css", "secret.css"] {
        assert_eq!(
            get(&format!("{prefix}/{resource}"), "test-symlinks").status(),
            StatusCode::FORBIDDEN
        );
    }
    let original = root.join("pinned");
    fs::create_dir(&original).unwrap();
    fs::write(original.join("index.html"), b"<p>pinned</p>").unwrap();
    let pinned = open_html(
        original.join("index.html").to_str().unwrap(),
        false,
        true,
        "test-symlinks",
    )
    .unwrap();
    fs::rename(&original, root.join("moved")).unwrap();
    symlink(outside.path(), &original).unwrap();
    assert_eq!(get(&pinned.url, "test-symlinks").status(), StatusCode::OK);
    let prefix = pinned.url.rsplit_once('/').unwrap().0;
    assert_ne!(
        get(&format!("{prefix}/secret.css"), "test-symlinks").status(),
        StatusCode::OK
    );
    close_html(&session.token, "test-symlinks").unwrap();
    close_html(&pinned.token, "test-symlinks").unwrap();
}

#[test]
fn html_csp_blocks_network_ipc_frames_forms_and_preserves_nonce_bridge() {
    let fixture = Fixture::new("index.html", br#"<!doctype html><meta http-equiv="refresh" content="0;url=https://evil.test"><base href="https://evil.test"><script>authorScript()</script><body onload="bad()"><a href="https://example.com">link</a></body>"#);
    let session = open_html(fixture.path(), false, false, "test-csp").unwrap();
    let response = get(&session.url, "test-csp");
    assert_eq!(response.status(), StatusCode::OK);
    let policy = response.headers()["Content-Security-Policy"]
        .to_str()
        .unwrap();
    assert!(policy.contains("sandbox allow-scripts"));
    assert!(!policy.contains("allow-same-origin"));
    assert!(
        !policy
            .split([' ', ';'])
            .any(|value| matches!(value, "http:" | "https:" | "*"))
    );
    assert!(!policy.contains("ipc:"));
    assert!(policy.contains("frame-src 'none'"));
    assert!(policy.contains("form-action 'none'"));
    assert!(policy.contains("script-src 'nonce-"));
    let body = String::from_utf8(response.body().clone()).unwrap();
    assert!(!body.contains("authorScript"));
    assert!(!body.contains("onload="));
    assert!(!body.contains("http-equiv=\"refresh\""));
    assert!(!body.contains("<base"));
    assert!(body.contains("taomni-html-preview"));
    assert!(body.contains("event.preventDefault()"));
    assert!(body.contains("Link is outside the preview root"));
    assert!(!body.contains("__TAURI"));
    let enabled = open_html(fixture.path(), true, true, "test-csp").unwrap();
    let response = get(&enabled.url, "test-csp");
    let policy = response.headers()["Content-Security-Policy"]
        .to_str()
        .unwrap();
    assert!(
        !policy
            .split([' ', ';'])
            .any(|value| matches!(value, "http:" | "https:" | "*"))
    );
    assert!(policy.contains("sandbox allow-scripts"));
    assert!(!policy.contains("allow-same-origin"));
    let body = String::from_utf8(response.body().clone()).unwrap();
    assert!(body.find("taomni-html-preview").unwrap() < body.find("authorScript").unwrap());
    // Parent never grants remote frame navigation, even network-resource opt-in.
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../../../tauri.conf.json")).unwrap();
    for key in ["csp", "devCsp"] {
        let csp = config["app"]["security"][key].as_str().unwrap();
        let frames = csp
            .split(';')
            .find(|directive| directive.trim().starts_with("frame-src"))
            .unwrap();
        assert!(frames.contains("taomni-preview:"));
        assert!(
            !frames
                .split_whitespace()
                .any(|value| value == "http:" || value == "https:" || value == "*")
        );
    }
    close_html(&session.token, "test-csp").unwrap();
    close_html(&enabled.token, "test-csp").unwrap();
}

#[test]
fn html_and_resource_read_limits_are_bounded() {
    let fixture = Fixture::new("index.html", b"<p>small</p>");
    let resource = fixture.path.parent().unwrap().join("large.css");
    let file = fs::File::create(&resource).unwrap();
    file.set_len(crate::viewer::HARD_BYTES + 1).unwrap();
    let session = open_html(fixture.path(), false, true, "test-limits").unwrap();
    let prefix = session.url.rsplit_once('/').unwrap().0;
    assert_eq!(
        get(&format!("{prefix}/large.css"), "test-limits").status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
    close_html(&session.token, "test-limits").unwrap();
    fs::OpenOptions::new()
        .write(true)
        .open(fixture.path())
        .unwrap()
        .set_len(crate::viewer::HARD_TEXT_BYTES + 1)
        .unwrap();
    assert!(
        open_html(fixture.path(), false, true, "test-limits")
            .unwrap_err()
            .starts_with("too_large:")
    );
}
