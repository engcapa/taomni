use super::*;
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires TAOMNI_RDP_LIVE_HOST/USER/PASS and a reachable Windows RDP server"]
async fn live_credssp_session_emits_first_frame() {
    let host = std::env::var("TAOMNI_RDP_LIVE_HOST").expect("TAOMNI_RDP_LIVE_HOST is required");
    let port = std::env::var("TAOMNI_RDP_LIVE_PORT")
        .ok()
        .and_then(|raw| raw.parse::<u16>().ok())
        .unwrap_or(3389);
    let username = std::env::var("TAOMNI_RDP_LIVE_USER").expect("TAOMNI_RDP_LIVE_USER is required");
    let password = std::env::var("TAOMNI_RDP_LIVE_PASS").expect("TAOMNI_RDP_LIVE_PASS is required");

    let stream = TcpStream::connect((host.as_str(), port))
        .await
        .expect("connect live RDP TCP stream");
    let local_addr = stream.local_addr().expect("read live RDP local address");
    let mut options = RdpOptions::default();
    options.screen_w = 1280;
    options.screen_h = 720;
    options.nla = true;
    apply_live_certificate_pin(&mut options);
    options.redirect_audio = "play".to_owned();
    if let Ok(path) = std::env::var("TAOMNI_RDP_LIVE_DRIVE_PATH") {
        options.redirect_drive.enabled = true;
        options.redirect_drive.label = "taomni".to_owned();
        options.redirect_drive.path = path;
    }

    let mut handle = start_ironrdp_session(RdpSessionConfig {
        stream: RdpStream::Tcp(stream),
        local_addr,
        host,
        port,
        username: Some(username),
        password: Some(password),
        options,
        network: None,
    });

    let mut connected = false;
    let mut frame_tiles = 0usize;
    let mut cursor_updates = 0usize;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(45);

    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        assert!(!remaining.is_zero(), "timed out waiting for live RDP frame");

        let output = tokio::time::timeout(remaining, handle.next_outgoing())
            .await
            .expect("timed out waiting for live RDP output")
            .expect("live RDP session ended before first frame");

        match output {
            SessionOutput::Text(text) => {
                eprintln!("rdp live event: {}", text);
                assert!(
                    !text.contains("\"type\":\"error\""),
                    "live RDP session failed: {}",
                    text
                );
                if text.contains("\"type\":\"connected\"") {
                    connected = true;
                }
            }
            SessionOutput::Channel { tag, payload } if tag == channel::FRAME => {
                assert!(payload.len() >= 8, "frame payload missing tile header");
                frame_tiles += 1;
                if connected && cursor_updates > 0 {
                    break;
                }
            }
            SessionOutput::Channel { tag, payload } if tag == channel::CURSOR => {
                assert!(!payload.is_empty(), "cursor payload is empty");
                assert!(
                    matches!(
                        payload[0],
                        cursor::DEFAULT | cursor::HIDDEN | cursor::BITMAP
                    ),
                    "unknown cursor payload kind {}",
                    payload[0],
                );
                if payload[0] == cursor::BITMAP {
                    assert!(
                        payload.len() > cursor::BITMAP_HEADER_LEN,
                        "bitmap cursor payload is missing PNG data"
                    );
                }
                cursor_updates += 1;
                if connected && frame_tiles > 0 {
                    break;
                }
            }
            SessionOutput::Channel { .. } => {}
        }
    }

    let _ = handle.dispatch_control(RdpControl::Disconnect).await;
    assert!(connected, "live RDP session did not report connected");
    assert!(frame_tiles > 0, "live RDP session did not emit a frame");
    assert!(
        cursor_updates > 0,
        "live RDP session did not emit a cursor update"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires TAOMNI_RDP_LIVE_HOST/USER/PASS and a reachable Windows RDP server"]
async fn live_credssp_clipboard_text_channel_accepts_local_copy() {
    let host = std::env::var("TAOMNI_RDP_LIVE_HOST").expect("TAOMNI_RDP_LIVE_HOST is required");
    let port = std::env::var("TAOMNI_RDP_LIVE_PORT")
        .ok()
        .and_then(|raw| raw.parse::<u16>().ok())
        .unwrap_or(3389);
    let username = std::env::var("TAOMNI_RDP_LIVE_USER").expect("TAOMNI_RDP_LIVE_USER is required");
    let password = std::env::var("TAOMNI_RDP_LIVE_PASS").expect("TAOMNI_RDP_LIVE_PASS is required");

    let stream = TcpStream::connect((host.as_str(), port))
        .await
        .expect("connect live RDP TCP stream");
    let local_addr = stream.local_addr().expect("read live RDP local address");
    let mut options = RdpOptions::default();
    options.screen_w = 1280;
    options.screen_h = 720;
    options.nla = true;
    apply_live_certificate_pin(&mut options);
    options.redirect_clipboard = true;

    let mut handle = start_ironrdp_session(RdpSessionConfig {
        stream: RdpStream::Tcp(stream),
        local_addr,
        host,
        port,
        username: Some(username),
        password: Some(password),
        options,
        network: None,
    });

    let mut connected = false;
    let mut clipboard_ready = false;
    let mut copy_sent = false;
    let mut copy_advertised = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(45);

    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        assert!(
            !remaining.is_zero(),
            "timed out waiting for live RDP clipboard channel"
        );

        let output = tokio::time::timeout(remaining, handle.next_outgoing())
            .await
            .expect("timed out waiting for live RDP output")
            .expect("live RDP session ended before clipboard channel proof");

        match output {
            SessionOutput::Text(text) => {
                eprintln!("rdp live clipboard event: {}", text);
                let value = serde_json::from_str::<serde_json::Value>(&text).unwrap();
                match value.get("type").and_then(|v| v.as_str()) {
                    Some("connected") => connected = true,
                    Some("status") => match value.get("stage").and_then(|v| v.as_str()) {
                        Some("clipboard-ready") => clipboard_ready = true,
                        Some("clipboard-local-copy") => copy_advertised = true,
                        Some("clipboard-unavailable") => {
                            panic!("live RDP CLIPRDR channel was not negotiated: {}", text)
                        }
                        _ => {}
                    },
                    Some("error") => panic!("live RDP clipboard session failed: {}", text),
                    _ => {}
                }

                if connected && clipboard_ready && !copy_sent {
                    handle
                        .dispatch_control(RdpControl::ClipboardData {
                            format: ClipboardFormatId::CF_UNICODETEXT.value(),
                            data: b"taomni live clipboard text".to_vec(),
                        })
                        .await
                        .expect("send live clipboard control");
                    copy_sent = true;
                }

                if copy_advertised {
                    break;
                }
            }
            SessionOutput::Channel { .. } => {}
        }
    }

    let _ = handle.dispatch_control(RdpControl::Disconnect).await;
    assert!(connected, "live RDP session did not report connected");
    assert!(
        clipboard_ready,
        "live RDP CLIPRDR channel did not become ready"
    );
    assert!(copy_sent, "live RDP clipboard copy control was not sent");
    assert!(
        copy_advertised,
        "live RDP clipboard formats were not advertised"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires TAOMNI_RDP_LIVE_HOST/USER/PASS and a reachable Windows RDP server"]
async fn live_credssp_drive_channel_is_accepted() {
    let host = std::env::var("TAOMNI_RDP_LIVE_HOST").expect("TAOMNI_RDP_LIVE_HOST is required");
    let port = std::env::var("TAOMNI_RDP_LIVE_PORT")
        .ok()
        .and_then(|raw| raw.parse::<u16>().ok())
        .unwrap_or(3389);
    let username = std::env::var("TAOMNI_RDP_LIVE_USER").expect("TAOMNI_RDP_LIVE_USER is required");
    let password = std::env::var("TAOMNI_RDP_LIVE_PASS").expect("TAOMNI_RDP_LIVE_PASS is required");
    let drive_dir = tempfile::tempdir().expect("create live redirected drive directory");

    let stream = TcpStream::connect((host.as_str(), port))
        .await
        .expect("connect live RDP TCP stream");
    let local_addr = stream.local_addr().expect("read live RDP local address");
    let mut options = RdpOptions::default();
    options.screen_w = 1280;
    options.screen_h = 720;
    options.nla = true;
    apply_live_certificate_pin(&mut options);
    options.redirect_clipboard = false;
    options.redirect_audio = "off".to_owned();
    options.redirect_drive.enabled = true;
    options.redirect_drive.label = "taomni".to_owned();
    options.redirect_drive.path = drive_dir.path().to_string_lossy().into_owned();

    let mut handle = start_ironrdp_session(RdpSessionConfig {
        stream: RdpStream::Tcp(stream),
        local_addr,
        host,
        port,
        username: Some(username),
        password: Some(password),
        options,
        network: None,
    });

    let deadline = tokio::time::Instant::now() + Duration::from_secs(45);
    let mut connected = false;
    let mut drive_requested = false;
    let mut drive_ready = false;
    loop {
        if tokio::time::Instant::now() >= deadline {
            break;
        }
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(remaining, handle.next_outgoing()).await {
            Ok(Some(SessionOutput::Text(text))) => {
                let parsed = serde_json::from_str::<serde_json::Value>(&text).ok();
                let ty = parsed
                    .as_ref()
                    .and_then(|v| v.get("type"))
                    .and_then(|s| s.as_str());
                let stage = parsed
                    .as_ref()
                    .and_then(|v| v.get("stage"))
                    .and_then(|s| s.as_str());
                match (ty, stage) {
                    (Some("connected"), _) => connected = true,
                    (Some("status"), Some("drive-enabled")) => drive_requested = true,
                    (Some("status"), Some("drive-ready")) => {
                        drive_ready = true;
                    }
                    (Some("status"), Some("drive-rejected")) => {
                        panic!("live RDP drive redirection was rejected: {}", text)
                    }
                    (Some("error"), _) => panic!("live RDP drive session failed: {}", text),
                    _ => {}
                }
                if connected && drive_requested && drive_ready {
                    break;
                }
            }
            Ok(Some(SessionOutput::Channel { .. })) => {}
            Ok(None) | Err(_) => break,
        }
    }

    let _ = handle.dispatch_control(RdpControl::Disconnect).await;
    assert!(connected, "live RDP drive session did not report connected");
    assert!(drive_requested, "live RDP drive channel was not requested");
    assert!(drive_ready, "live RDP drive channel was not accepted");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires TAOMNI_RDP_LIVE_HOST/USER/PASS and a reachable Windows RDP server"]
async fn live_credssp_session_resizes_and_reactivates() {
    let host = std::env::var("TAOMNI_RDP_LIVE_HOST").expect("TAOMNI_RDP_LIVE_HOST is required");
    let port = std::env::var("TAOMNI_RDP_LIVE_PORT")
        .ok()
        .and_then(|raw| raw.parse::<u16>().ok())
        .unwrap_or(3389);
    let username = std::env::var("TAOMNI_RDP_LIVE_USER").expect("TAOMNI_RDP_LIVE_USER is required");
    let password = std::env::var("TAOMNI_RDP_LIVE_PASS").expect("TAOMNI_RDP_LIVE_PASS is required");

    let stream = TcpStream::connect((host.as_str(), port))
        .await
        .expect("connect live RDP TCP stream");
    let local_addr = stream.local_addr().expect("read live RDP local address");
    let mut options = RdpOptions::default();
    options.screen_w = 1280;
    options.screen_h = 720;
    options.nla = true;
    apply_live_certificate_pin(&mut options);

    let mut handle = start_ironrdp_session(RdpSessionConfig {
        stream: RdpStream::Tcp(stream),
        local_addr,
        host,
        port,
        username: Some(username),
        password: Some(password),
        options,
        network: None,
    });

    let resize_width = 1024;
    let resize_height = 768;
    let mut connected = false;
    let mut resize_sent = false;
    let mut resized = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);

    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        assert!(
            !remaining.is_zero(),
            "timed out waiting for live RDP resize reactivation"
        );

        let output = tokio::time::timeout(remaining, handle.next_outgoing())
            .await
            .expect("timed out waiting for live RDP output")
            .expect("live RDP session ended before resize reactivation");

        match output {
            SessionOutput::Text(text) => {
                eprintln!("rdp live resize event: {}", text);
                let value = serde_json::from_str::<serde_json::Value>(&text).unwrap();
                match value.get("type").and_then(|v| v.as_str()) {
                    Some("connected") => {
                        connected = true;
                        let width = value.get("width").and_then(|v| v.as_u64()).unwrap();
                        let height = value.get("height").and_then(|v| v.as_u64()).unwrap();
                        if resize_sent
                            && width == u64::from(resize_width)
                            && height == u64::from(resize_height)
                        {
                            resized = true;
                        }
                    }
                    Some("error") => panic!("live RDP resize session failed: {}", text),
                    _ => {}
                }
                if connected && !resize_sent {
                    handle
                        .dispatch_control(RdpControl::Resize {
                            width: resize_width,
                            height: resize_height,
                        })
                        .await
                        .expect("send live resize control");
                    resize_sent = true;
                }
            }
            SessionOutput::Channel { tag, payload } if tag == channel::FRAME => {
                assert!(payload.len() >= 8, "frame payload missing tile header");
                if resized {
                    break;
                }
            }
            SessionOutput::Channel { .. } => {}
        }
    }

    let _ = handle.dispatch_control(RdpControl::Disconnect).await;
    assert!(resize_sent, "live RDP resize request was not sent");
    assert!(
        resized,
        "live RDP session did not reactivate at the resized desktop size"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires TAOMNI_RDP_LIVE_HOST/USER/PASS and a reachable Windows RDP server"]
async fn live_credssp_connection_test_reaches_connected() {
    let host = std::env::var("TAOMNI_RDP_LIVE_HOST").expect("TAOMNI_RDP_LIVE_HOST is required");
    let port = std::env::var("TAOMNI_RDP_LIVE_PORT")
        .ok()
        .and_then(|raw| raw.parse::<u16>().ok())
        .unwrap_or(3389);
    let username = std::env::var("TAOMNI_RDP_LIVE_USER").expect("TAOMNI_RDP_LIVE_USER is required");
    let password = std::env::var("TAOMNI_RDP_LIVE_PASS").expect("TAOMNI_RDP_LIVE_PASS is required");

    let stream = TcpStream::connect((host.as_str(), port))
        .await
        .expect("connect live RDP TCP stream");
    let local_addr = stream.local_addr().expect("read live RDP local address");
    let mut options = RdpOptions::default();
    options.screen_w = 1280;
    options.screen_h = 720;
    options.nla = true;
    apply_live_certificate_pin(&mut options);

    let result = test_ironrdp_connection(
        RdpSessionConfig {
            stream: RdpStream::Tcp(stream),
            local_addr,
            host: host.clone(),
            port,
            username: Some(username),
            password: Some(password),
            options,
            network: None,
        },
        Duration::from_secs(45),
    )
    .await
    .expect("live RDP connection test should reach connected");

    assert_eq!(result.width, 1280);
    assert_eq!(result.height, 720);
    assert_eq!(result.protocol, "CredSSP/NLA");
    assert_eq!(result.server_name, host);
}
