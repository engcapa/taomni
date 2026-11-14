use super::*;
use crate::mobile::{Core, service_tests::Fixture};
use image::RgbaImage;

#[test]
fn desktop_policy_defaults_off_and_persists_explicitly() {
    let dir = tempfile::tempdir().unwrap();
    let policy = DesktopState::default();
    assert!(!policy.screen_allowed());
    policy.ensure_loaded(dir.path());
    assert!(!policy.screen_allowed());

    policy.set_screen_allowed(dir.path(), true).unwrap();
    assert!(policy.screen_allowed());

    let reloaded = DesktopState::default();
    reloaded.ensure_loaded(dir.path());
    assert!(reloaded.screen_allowed());

    reloaded.set_screen_allowed(dir.path(), false).unwrap();
    assert!(!reloaded.screen_allowed());
}

#[test]
fn browser_url_normalization_accepts_http_https_and_rejects_unsafe_schemes() {
    assert_eq!(
        normalize_browser_url("example.com/path").unwrap().as_str(),
        "https://example.com/path"
    );
    assert_eq!(
        normalize_browser_url("127.0.0.1:8080/page")
            .unwrap()
            .as_str(),
        "http://127.0.0.1:8080/page"
    );
    assert_eq!(
        normalize_browser_url("  http://localhost:3000/a?b=1 ")
            .unwrap()
            .as_str(),
        "http://localhost:3000/a?b=1"
    );

    for bad in [
        "",
        "   ",
        "javascript:alert(1)",
        "file:///etc/passwd",
        "data:text/html,hi",
        "tauri://localhost",
        "ftp://example.com",
        "https://user:pass@example.com",
        "http://bad url.com",
    ] {
        assert_eq!(
            normalize_browser_url(bad).unwrap_err(),
            "invalid_browser_url",
            "{bad:?}"
        );
    }
}

#[test]
fn window_input_validation_and_resolution_enforce_bounds() {
    assert_eq!(
        validate_window_input(&WindowInputRequest::default()).unwrap_err(),
        "empty_window_input"
    );
    assert_eq!(
        validate_window_input(&WindowInputRequest {
            text: "x".repeat(4097),
            ..Default::default()
        })
        .unwrap_err(),
        "input_too_large"
    );
    assert_eq!(
        validate_window_input(&WindowInputRequest {
            key: Some("not_a_key".into()),
            ..Default::default()
        })
        .unwrap_err(),
        "invalid_window_key"
    );
    assert!(
        validate_window_input(&WindowInputRequest {
            key: Some("ctrl-c".into()),
            ..Default::default()
        })
        .unwrap()
        .is_some()
    );

    let list = vec![
        DesktopWindow {
            id: "tauri:mobile-remote-browser".into(),
            title: "Taomni Browser - https://example.com".into(),
            app_name: "Taomni".into(),
            pid: 1,
            x: 0,
            y: 0,
            width: 800,
            height: 600,
            minimized: false,
            focused: true,
            kind: "tauri".into(),
        },
        DesktopWindow {
            id: "win:42".into(),
            title: "Notes Editor".into(),
            app_name: "Notes".into(),
            pid: 2,
            x: 10,
            y: 10,
            width: 400,
            height: 300,
            minimized: false,
            focused: false,
            kind: "desktop".into(),
        },
    ];
    assert_eq!(resolve_window(&list, "win:42").unwrap().id, "win:42");
    assert_eq!(resolve_window(&list, "42").unwrap().id, "win:42");
    assert_eq!(resolve_window(&list, "2").unwrap().id, "win:42");
    assert_eq!(resolve_window(&list, "Notes").unwrap().id, "win:42");
    assert_eq!(
        resolve_window(&list, "missing").unwrap_err(),
        "window_not_found"
    );
}

#[test]
fn screen_png_encoder_preserves_header_and_bounds_large_captures() {
    let img = RgbaImage::from_pixel(2400, 1200, image::Rgba([20, 40, 80, 255]));
    let (png, width, height, screen_w, screen_h) = capture::encode_screen_png(img).unwrap();
    assert_eq!((screen_w, screen_h), (2400, 1200));
    assert!(width <= 1600 && height <= 1000);
    assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
}

#[tokio::test]
async fn headless_runtime_blocks_screen_without_opt_in_then_reports_desktop_required() {
    let f = Fixture::new().await;
    let core = Core::Headless(f.state.clone());
    assert_eq!(
        capture_screen(&core, None).await.unwrap_err(),
        "screen_capture_disabled"
    );
    f.state
        .mobile
        .desktop
        .set_screen_allowed(
            f.state
                .mobile
                .profile_data
                .lock()
                .unwrap()
                .as_ref()
                .unwrap(),
            true,
        )
        .unwrap();
    assert_eq!(
        capture_screen(&core, None).await.unwrap_err(),
        "desktop_required"
    );
    assert_eq!(list_windows(&core).await.unwrap_err(), "desktop_required");
    assert_eq!(
        open_browser(&core, "https://example.com")
            .await
            .unwrap_err(),
        "desktop_required"
    );
    f.finish().await;
}

struct MockDesktopDriver {
    sent_inputs: Mutex<Vec<(String, String, Option<String>, bool)>>,
    opened_urls: Mutex<Vec<String>>,
}

impl MockDesktopDriver {
    fn new() -> Self {
        Self {
            sent_inputs: Mutex::new(Vec::new()),
            opened_urls: Mutex::new(Vec::new()),
        }
    }
}

impl TestDesktopDriver for MockDesktopDriver {
    fn capture_screen(&self, display_id: Option<&str>) -> Result<ScreenCapture, String> {
        let img = RgbaImage::from_pixel(320, 200, image::Rgba([30, 60, 90, 255]));
        let (png, width, height, screen_width, screen_height) = capture::encode_screen_png(img)?;
        let selected = display_id.unwrap_or("display-1").to_owned();
        Ok(ScreenCapture {
            mime: "image/png".into(),
            width,
            height,
            screen_width,
            screen_height,
            display_id: selected.clone(),
            display_name: format!("Display {selected}"),
            displays: vec![DisplaySummary {
                id: "display-1".into(),
                name: "Primary".into(),
                width: 320,
                height: 200,
                primary: true,
            }],
            captured_at: 1700000000,
            png,
        })
    }

    fn list_windows(&self) -> Result<Vec<DesktopWindow>, String> {
        Ok(vec![DesktopWindow {
            id: "tauri:mobile-remote-browser".into(),
            title: "Taomni Browser - http://127.0.0.1:4321".into(),
            app_name: "Taomni".into(),
            pid: 99,
            x: 0,
            y: 0,
            width: 1120,
            height: 760,
            minimized: false,
            focused: true,
            kind: "tauri_browser".into(),
        }])
    }

    fn send_window_input(
        &self,
        window_id: &str,
        input: &WindowInputRequest,
    ) -> Result<WindowInputResult, String> {
        let _ = validate_window_input(input)?;
        if window_id != "tauri:mobile-remote-browser" {
            return Err("window_not_found".into());
        }
        self.sent_inputs.lock().unwrap().push((
            window_id.to_owned(),
            input.text.clone(),
            input.key.clone(),
            input.submit,
        ));
        Ok(WindowInputResult {
            ok: true,
            window_id: window_id.into(),
            title: "Taomni Browser - http://127.0.0.1:4321".into(),
        })
    }

    fn open_browser(&self, url: &url::Url) -> Result<BrowserOpenResult, String> {
        self.opened_urls.lock().unwrap().push(url.to_string());
        Ok(BrowserOpenResult {
            ok: true,
            url: url.to_string(),
            window_id: "tauri:mobile-remote-browser".into(),
            title: format!("Taomni Browser - {url}"),
        })
    }
}

#[tokio::test]
async fn http_desktop_endpoints_enforce_screen_opt_in_and_proxy_controls() {
    use base64::{Engine, engine::general_purpose::STANDARD as B64};
    use serde_json::{Value, json};
    use std::sync::Arc;

    let origin = "https://mobile.example";
    let f = Fixture::new().await;
    let driver = Arc::new(MockDesktopDriver::new());
    f.state.mobile.desktop.set_test_driver(Some(driver.clone()));
    f.state
        .mobile
        .desktop_available
        .store(true, Ordering::Relaxed);
    let (_, token) = f.pair().await;

    let sessions_before = f.get(&token, "/sessions").await;
    assert_eq!(sessions_before["capabilities"]["screen_capture"], false);
    assert_eq!(sessions_before["capabilities"]["desktop_control"], true);

    let denied = f
        .client
        .get(format!("{}/api/v1/desktop/screen", f.endpoint))
        .header("Origin", origin)
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(denied.status(), 403);
    assert_eq!(
        denied.json::<Value>().await.unwrap()["error"],
        "screen_capture_disabled"
    );

    let data_dir = f.state.mobile.profile_data.lock().unwrap().clone().unwrap();
    f.state
        .mobile
        .desktop
        .set_screen_allowed(&data_dir, true)
        .unwrap();

    let sessions_after = f.get(&token, "/sessions").await;
    assert_eq!(sessions_after["capabilities"]["screen_capture"], true);

    let screen = f.get(&token, "/desktop/screen").await;
    assert_eq!(screen["mime"], "image/png");
    let decoded = B64.decode(screen["image_b64"].as_str().unwrap()).unwrap();
    assert_eq!(&decoded[..8], b"\x89PNG\r\n\x1a\n");

    let windows = f.get(&token, "/desktop/windows").await;
    assert_eq!(windows["screen_capture_enabled"], true);
    assert_eq!(windows["windows"][0]["id"], "tauri:mobile-remote-browser");

    let bad_url = f
        .client
        .post(format!("{}/api/v1/desktop/browser", f.endpoint))
        .header("Origin", origin)
        .bearer_auth(&token)
        .json(&json!({ "url": "javascript:alert(1)" }))
        .send()
        .await
        .unwrap();
    assert_eq!(bad_url.status(), 400);
    assert_eq!(
        bad_url.json::<Value>().await.unwrap()["error"],
        "invalid_browser_url"
    );

    let opened = f
        .client
        .post(format!("{}/api/v1/desktop/browser", f.endpoint))
        .header("Origin", origin)
        .bearer_auth(&token)
        .json(&json!({ "url": "127.0.0.1:4321/demo" }))
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(opened["ok"], true);
    assert_eq!(opened["url"], "http://127.0.0.1:4321/demo");
    assert_eq!(opened["window_id"], "tauri:mobile-remote-browser");

    let input_ok = f
        .client
        .post(format!(
            "{}/api/v1/desktop/windows/tauri%3Amobile-remote-browser/input",
            f.endpoint
        ))
        .header("Origin", origin)
        .bearer_auth(&token)
        .json(&json!({ "text": "hello window", "submit": true }))
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(input_ok["ok"], true);
    assert_eq!(
        driver.sent_inputs.lock().unwrap().as_slice(),
        &[(
            "tauri:mobile-remote-browser".into(),
            "hello window".into(),
            None,
            true
        )]
    );
    assert_eq!(
        driver.opened_urls.lock().unwrap().as_slice(),
        &["http://127.0.0.1:4321/demo"]
    );
    f.finish().await;
}
