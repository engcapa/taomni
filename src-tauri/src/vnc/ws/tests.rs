use super::*;
use crate::vnc::encodings::ENCODING_DESKTOP_SIZE;
use tokio::sync::oneshot;
use tokio_tungstenite::connect_async;
use tungstenite::client::IntoClientRequest;

fn ws_request(
    port: u16,
    path: &str,
    protocol: &str,
    origin: &'static str,
) -> tungstenite::handshake::client::Request {
    let mut request = format!("ws://127.0.0.1:{port}{path}")
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert(header::ORIGIN, HeaderValue::from_static(origin));
    request.headers_mut().insert(
        header::SEC_WEBSOCKET_PROTOCOL,
        HeaderValue::from_str(protocol).unwrap(),
    );
    request
}

#[test]
fn binary_control_decodes_key_pointer_and_refresh() {
    match parse_binary_control(&[2, 1, 0, 0, 0xff, 0x0d]) {
        Some(VncControl::Key { down, keysym }) => {
            assert!(down);
            assert_eq!(keysym, 0xff0d);
        }
        other => panic!("expected key control, got {:?}", other),
    }

    match parse_binary_control(&[3, 1, 0x01, 0x02, 0x03, 0x04]) {
        Some(VncControl::Pointer { x, y, buttons }) => {
            assert_eq!(x, 0x0102);
            assert_eq!(y, 0x0304);
            assert_eq!(buttons, 1);
        }
        other => panic!("expected pointer control, got {:?}", other),
    }

    assert!(matches!(
        parse_binary_control(&[4]),
        Some(VncControl::Refresh)
    ));
    assert!(parse_binary_control(&[4, 0]).is_none());
}

#[test]
fn binary_control_decodes_ack_and_ignores_ping() {
    assert!(matches!(parse_binary_control(&[0]), Some(VncControl::Ack)));
    assert!(parse_binary_control(&[1]).is_none());
    assert!(parse_binary_control(&[3, 0]).is_none());
}

#[test]
fn frame_flow_waits_for_frontend_ack_after_pixel_damage() {
    let mut flow = FrameFlow::new();
    assert!(
        !flow.note_update([FbRect::new(0, 0, 32, 32)]),
        "a pixel update must occupy the one canvas frame in flight"
    );
    assert!(flow.request_deferred);

    // Once the frame has been painted and acknowledged, an empty update
    // can be polled immediately because it does not create another paint.
    flow.frontend_ready = true;
    flow.damage.clear();
    flow.request_deferred = false;
    assert!(flow.note_update(std::iter::empty::<FbRect>()));
    assert!(!flow.request_deferred);

    // An unsolicited update while a frame is still in flight is held for
    // the next ACK as well.
    flow.frontend_ready = false;
    assert!(!flow.note_update(std::iter::empty::<FbRect>()));
    assert!(flow.request_deferred);
}

#[tokio::test]
async fn deferred_request_waits_for_accumulated_damage_to_be_painted() {
    let limits = crate::vnc::limits::DecodeLimits::default();
    let framebuffer = crate::vnc::framebuffer::Framebuffer::new(2, 2, &limits)
        .unwrap()
        .shared();
    let flow = Arc::new(std::sync::Mutex::new(FrameFlow::new()));
    let (tx, rx) = FrameQueueSender::new(limits);

    assert!(!flow.lock().unwrap().note_update([FbRect::new(0, 0, 1, 1)]));
    assert!(flush_frame(&flow, &framebuffer, &tx));
    assert!(matches!(rx.recv().await, Some(QueuedWsOutgoing::Frame(_))));

    // A refresh/probe response arrives while the first frame is painting.
    assert!(!flow.lock().unwrap().note_update([FbRect::new(1, 1, 1, 1)]));
    flow.lock().unwrap().frontend_ready = true; // First paint ACK.
    assert!(flush_frame(&flow, &framebuffer, &tx));
    assert!(matches!(rx.recv().await, Some(QueuedWsOutgoing::Frame(_))));
    assert!(
        !flow.lock().unwrap().take_deferred_request(),
        "the newly sent damage still needs its own paint ACK"
    );

    flow.lock().unwrap().frontend_ready = true; // Second paint ACK.
    assert!(!flush_frame(&flow, &framebuffer, &tx));
    assert!(flow.lock().unwrap().take_deferred_request());
    assert!(!flow.lock().unwrap().take_deferred_request());
}

#[test]
fn rich_cursor_serializes_as_a_bounded_png_message() {
    let json = serialize_cursor(DecodedCursor {
        hotspot_x: 0,
        hotspot_y: 0,
        width: 1,
        height: 1,
        rgba: vec![0x12, 0x34, 0x56, 0xff],
    })
    .unwrap();
    let value: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(value["type"], "cursor");
    assert_eq!(value["visible"], true);
    assert_eq!(value["width"], 1);
    assert!(
        value["png_base64"]
            .as_str()
            .unwrap()
            .starts_with("iVBORw0KGgo")
    );
}

#[test]
fn pointer_position_serializes_as_a_small_control_message() {
    let json = serde_json::to_string(&WsOutgoingText::PointerPos { x: 123, y: 456 }).unwrap();
    let value: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(
        value,
        serde_json::json!({ "type": "pointer_pos", "x": 123, "y": 456 })
    );
}

#[test]
fn native_pointer_messages_carry_the_canvas_geometry() {
    let on: WsIncoming = serde_json::from_str(
            r#"{"type":"native_pointer","on":true,"left":10,"top":20,"width":800,"height":450,"dpr":1.5,"fb_width":1600,"fb_height":900}"#,
        )
        .unwrap();
    let WsIncoming::NativePointer {
        on,
        left,
        top,
        width,
        height,
        dpr,
        fb_width,
        fb_height,
    } = on
    else {
        panic!("expected native_pointer");
    };
    let target =
        native_pointer_target(on, left, top, width, height, dpr, fb_width, fb_height).unwrap();
    // Physical (615, 367.5) is CSS (410, 245): the middle of the canvas.
    assert_eq!(target.framebuffer_point(615.0, 367.5), Some((800, 450)));

    let off: WsIncoming = serde_json::from_str(r#"{"type":"native_pointer","on":false}"#).unwrap();
    assert!(matches!(off, WsIncoming::NativePointer { on: false, .. }));
    assert_eq!(
        native_pointer_target(false, left, top, width, height, dpr, fb_width, fb_height),
        None
    );
    // Incomplete or degenerate geometry stops sampling instead of guessing.
    assert_eq!(
        native_pointer_target(true, left, None, width, height, dpr, fb_width, fb_height),
        None
    );
    assert_eq!(
        native_pointer_target(true, left, top, Some(0.0), height, dpr, fb_width, fb_height),
        None
    );

    let limits = crate::vnc::limits::DecodeLimits::default();
    let start = VncControl::NativePointer(Some(target));
    assert!(control_allowed(
        &start,
        false,
        VncClipboardPolicy::Disabled,
        &limits
    ));
    assert!(!control_allowed(
        &start,
        true,
        VncClipboardPolicy::Disabled,
        &limits
    ));
}

#[test]
fn native_samples_lead_and_the_webview_owns_presses() {
    let start = Instant::now();
    let at = |ms: u64| start + Duration::from_millis(ms);
    let mut arbiter = PointerArbiter::default();
    // Without sampling every WebView event goes out; samples do not.
    assert!(arbiter.web(10, 10, 0, at(0)));
    assert!(!arbiter.sample(11, 11, at(1)));

    arbiter.set_native(true);
    assert!(arbiter.sample(12, 12, at(2)));
    // The WebView's copy of that move (and a stale one) is dropped...
    assert!(!arbiter.web(12, 12, 0, at(12)));
    assert!(!arbiter.web(11, 11, 0, at(20)));
    // ...a repeated sample of the same position is no move...
    assert!(!arbiter.sample(12, 12, at(21)));
    // ...and once samples stop, the WebView's moves count again.
    assert!(arbiter.web(13, 13, 0, at(80)));

    // A press goes out and pauses samples until the release.
    assert!(arbiter.sample(14, 14, at(81)));
    assert!(arbiter.web(14, 14, 1, at(82)));
    assert!(!arbiter.sample(20, 20, at(83)));
    assert!(arbiter.web(20, 20, 1, at(84)));
    assert!(
        arbiter.web(20, 20, 0, at(85)),
        "the release is never dropped"
    );
    // The sampler's first position after the release equals it.
    assert!(!arbiter.sample(20, 20, at(86)));
    assert!(arbiter.sample(21, 20, at(87)));

    // A wheel notch (press/release pair) keeps its release.
    assert!(arbiter.web(21, 20, 0x10, at(88)));
    assert!(arbiter.web(21, 20, 0, at(89)));

    arbiter.set_native(false);
    assert!(arbiter.web(22, 22, 0, at(90)));
    assert!(!arbiter.sample(23, 23, at(91)));
}

#[test]
fn connected_message_offers_native_pointer_sampling() {
    let json = serde_json::to_value(&WsOutgoingText::Connected {
        width: 1024,
        height: 768,
        name: "desk".into(),
        protocol: "3.8".into(),
        security: "VNC password".into(),
        encrypted: false,
        native_pointer: true,
    })
    .unwrap();
    assert_eq!(json["native_pointer"], serde_json::json!(true));
}

#[test]
fn backend_enforces_view_only_and_clipboard_direction() {
    let limits = crate::vnc::limits::DecodeLimits::default();
    let key = VncControl::Key {
        down: true,
        keysym: 0x41,
    };
    assert!(!control_allowed(
        &key,
        true,
        VncClipboardPolicy::Bidirectional,
        &limits,
    ));
    assert!(control_allowed(
        &VncControl::Ack,
        true,
        VncClipboardPolicy::Disabled,
        &limits,
    ));
    assert!(!control_allowed(
        &VncControl::Clipboard("secret".into()),
        false,
        VncClipboardPolicy::ServerToClient,
        &limits,
    ));
    assert!(control_allowed(
        &VncControl::Clipboard("ok".into()),
        false,
        VncClipboardPolicy::ClientToServer,
        &limits,
    ));
}

#[test]
fn backend_rejects_oversized_clipboard_controls() {
    let mut limits = crate::vnc::limits::DecodeLimits::default();
    limits.max_clipboard_format_bytes = 4;
    limits.max_clipboard_decompressed_bytes = 6;
    assert!(!control_allowed(
        &VncControl::Clipboard("12345".into()),
        false,
        VncClipboardPolicy::Bidirectional,
        &limits,
    ));
    assert!(!control_allowed(
        &VncControl::ExtendedClipboard(ClipboardFormats {
            text: Some("1234".into()),
            html: Some("5678".into()),
            rtf: None,
        }),
        false,
        VncClipboardPolicy::Bidirectional,
        &limits,
    ));
}

#[test]
fn clipboard_caps_remain_available_for_one_way_client_sync() {
    let caps = ExtendedClipboardMsg::Caps {
        formats: FORMAT_TEXT,
        actions: SUPPORTED_ACTIONS,
        sizes: vec![1024],
    };
    assert!(server_clipboard_message_allowed(
        &caps,
        VncClipboardPolicy::ClientToServer,
    ));
    assert!(!server_clipboard_message_allowed(
        &ExtendedClipboardMsg::Notify {
            formats: FORMAT_TEXT,
        },
        VncClipboardPolicy::ClientToServer,
    ));
}

#[test]
fn relay_origin_allowlist_rejects_untrusted_pages() {
    assert!(is_authorized_origin("tauri://localhost"));
    assert!(!is_authorized_origin("https://attacker.example"));
}

#[test]
fn stats_window_merges_back_to_back_updates_into_one_line_speed_sample() {
    let mut window = StatsWindow::new();
    let labels = StatsLabels {
        requested: "ZRLE",
        quality: "automatic",
        level: "high",
    };
    let t0 = Instant::now();
    let update = |start_ms: u64, end_ms: u64, bytes: u64, updates: u64| RuntimeStats {
        wire_bytes: 0,
        updates,
        last_encoding: Some(16),
        last_update_wire_bytes: bytes,
        last_update_micros: (end_ms - start_ms) * 1000,
        last_update_started_at: Some(t0 + Duration::from_millis(start_ms)),
        last_update_finished_at: Some(t0 + Duration::from_millis(end_ms)),
        ..RuntimeStats::default()
    };
    // Two halves of one 1 MB transfer 10 ms apart, then a later small update.
    window.observe(update(0, 40, 500_000, 1), 1, &labels);
    window.observe(update(50, 100, 500_000, 2), 1, &labels);
    assert!(window.line_kbps.is_none(), "burst still open");
    window.observe(update(600, 601, 1_000, 3), 2, &labels);
    // 1_000_000 bytes over 100 ms = 80_000 kbit/s.
    assert_eq!(window.line_kbps, Some(80_000));
    // A lone small transfer never produces a sample.
    window.observe(update(2_000, 2_001, 1_000, 4), 3, &labels);
    assert_eq!(window.line_kbps, Some(80_000));
}

#[test]
fn desktop_size_notification_carries_a_monotonic_generation() {
    let json = serde_json::to_string(&WsOutgoingText::DesktopSize {
        width: 2560,
        height: 1440,
        generation: 3,
    })
    .unwrap();
    assert_eq!(
        json,
        r#"{"type":"desktop_size","width":2560,"height":1440,"generation":3}"#
    );
}

#[tokio::test]
async fn authenticated_websocket_rejects_bad_requests_and_is_single_use() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let cancel = CancellationToken::new();
    let server_cancel = cancel.clone();
    let (accepted_tx, accepted_rx) = oneshot::channel();
    let (release_tx, release_rx) = oneshot::channel();
    let server = tokio::spawn(async move {
        let socket = accept_authorized_ws(listener, "single-use", &server_cancel)
            .await
            .unwrap();
        let _ = accepted_tx.send(());
        let _ = release_rx.await;
        drop(socket);
    });

    assert!(
        connect_async(ws_request(
            port,
            "/vnc",
            "taomni-vnc.wrong",
            "tauri://localhost",
        ))
        .await
        .is_err()
    );
    assert!(
        connect_async(ws_request(
            port,
            "/vnc",
            "taomni-vnc.single-use",
            "https://attacker.example",
        ))
        .await
        .is_err()
    );
    assert!(
        connect_async(ws_request(
            port,
            "/wrong",
            "taomni-vnc.single-use",
            "tauri://localhost",
        ))
        .await
        .is_err()
    );

    let (mut client, response) = connect_async(ws_request(
        port,
        "/vnc",
        "taomni-vnc.single-use",
        "tauri://localhost",
    ))
    .await
    .unwrap();
    assert_eq!(
        response
            .headers()
            .get(header::SEC_WEBSOCKET_PROTOCOL)
            .and_then(|value| value.to_str().ok()),
        Some("taomni-vnc.single-use")
    );
    accepted_rx.await.unwrap();

    let second = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        connect_async(ws_request(
            port,
            "/vnc",
            "taomni-vnc.single-use",
            "tauri://localhost",
        )),
    )
    .await;
    assert!(!matches!(second, Ok(Ok(_))));

    let _ = client.close(None).await;
    let _ = release_tx.send(());
    server.await.unwrap();
}

/// Minimal RFB 3.8 server for relay tests: None security, 4x2 desktop.
/// Sends one Raw update, then waits for the client to acknowledge the
/// corresponding WebView frame before reading the next incremental update
/// request. It then resizes to 2x2 with a DesktopSize rect followed by a
/// Raw rect. Without the ACK boundary the resize can arrive while the
/// first frame is still queued, and the relay rightly drops frames of the
/// old geometry.
fn start_pipeline_fixture() -> (
    u16,
    std::thread::JoinHandle<Vec<u8>>,
    std::sync::mpsc::Sender<()>,
    tokio::sync::oneshot::Receiver<()>,
) {
    use std::io::{Read as _, Write as _};
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    let (delivered, first_frame_delivered) = std::sync::mpsc::channel::<()>();
    let (waiting, no_request_before_ack) = tokio::sync::oneshot::channel();
    let handle = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(10)))
            .unwrap();
        stream.write_all(b"RFB 003.008\n").unwrap();
        let mut banner = [0u8; 12];
        stream.read_exact(&mut banner).unwrap();
        stream.write_all(&[1, 1]).unwrap();
        let mut chosen = [0u8; 1];
        stream.read_exact(&mut chosen).unwrap();
        stream.write_all(&0u32.to_be_bytes()).unwrap();
        let mut shared = [0u8; 1];
        stream.read_exact(&mut shared).unwrap();
        let mut init = Vec::new();
        init.extend_from_slice(&4u16.to_be_bytes());
        init.extend_from_slice(&2u16.to_be_bytes());
        init.extend_from_slice(&[32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 0, 8, 16, 0, 0, 0]);
        init.extend_from_slice(&4u32.to_be_bytes());
        init.extend_from_slice(b"test");
        stream.write_all(&init).unwrap();

        // Client setup: SetPixelFormat, SetEncodings, first (full) request.
        let mut pixel_format = [0u8; 20];
        stream.read_exact(&mut pixel_format).unwrap();
        let mut encodings = [0u8; 4];
        stream.read_exact(&mut encodings).unwrap();
        let count = u16::from_be_bytes([encodings[2], encodings[3]]) as usize;
        let mut list = vec![0u8; count * 4];
        stream.read_exact(&mut list).unwrap();
        let mut first_request = [0u8; 10];
        stream.read_exact(&mut first_request).unwrap();

        let raw_rect = |x: u16, y: u16, w: u16, h: u16, value: u8| {
            let mut rect = Vec::new();
            for field in [x, y, w, h] {
                rect.extend_from_slice(&field.to_be_bytes());
            }
            rect.extend_from_slice(&0i32.to_be_bytes());
            for _ in 0..(w as usize * h as usize) {
                rect.extend_from_slice(&[value, value, value, 0]);
            }
            rect
        };
        let mut first = vec![0, 0, 0, 1];
        first.extend_from_slice(&raw_rect(0, 0, 4, 2, 7));
        stream.write_all(&first).unwrap();

        first_frame_delivered
            .recv_timeout(std::time::Duration::from_secs(10))
            .expect("first frame delivered to the WebSocket");

        // The relay must wait for the WebView ACK before asking the old
        // server to encode another update.
        stream
            .set_read_timeout(Some(std::time::Duration::from_millis(150)))
            .unwrap();
        let mut byte = [0u8; 1];
        let error = stream
            .read(&mut byte)
            .expect_err("no RFB request is allowed before the paint ACK");
        assert!(matches!(
            error.kind(),
            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
        ));
        waiting.send(()).unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(10)))
            .unwrap();
        let mut next_request = [0u8; 10];
        stream.read_exact(&mut next_request).unwrap();

        let mut resized = vec![0, 0, 0, 2];
        for field in [0u16, 0, 2, 2] {
            resized.extend_from_slice(&field.to_be_bytes());
        }
        resized.extend_from_slice(&ENCODING_DESKTOP_SIZE.to_be_bytes());
        resized.extend_from_slice(&raw_rect(0, 0, 2, 2, 9));
        stream.write_all(&resized).unwrap();

        let mut rest = Vec::new();
        let _ = stream.read_to_end(&mut rest);
        next_request.to_vec()
    });
    (port, handle, delivered, no_request_before_ack)
}

#[tokio::test]
async fn relay_waits_for_paint_ack_and_repaints_after_desktop_size() {
    let (port, server, delivered, no_request_before_ack) = start_pipeline_fixture();
    let mut no_request_before_ack = Some(no_request_before_ack);
    let session = spawn_vnc_relay(
        "127.0.0.1".into(),
        port,
        None,
        None,
        None,
        VncSecurityPolicy::AllowNone,
        false,
        VncClipboardPolicy::Disabled,
        VncRelayOptions::default(),
        CancellationToken::new(),
    )
    .await
    .unwrap();
    let (mut client, _) = connect_async(ws_request(
        session.ws_port,
        "/vnc",
        &format!("taomni-vnc.{}", session.ws_token),
        "tauri://localhost",
    ))
    .await
    .unwrap();

    let mut texts = Vec::new();
    let mut frames: Vec<Vec<Vec<u8>>> = vec![Vec::new()];
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    let mut acked_first_frame = false;
    while frames.iter().filter(|frame| !frame.is_empty()).count() < 2 {
        let message = tokio::time::timeout_at(deadline, client.next())
            .await
            .expect("relay frames before timeout")
            .expect("socket open")
            .expect("valid message");
        match message {
            Message::Text(text) => texts.push(text.to_string()),
            Message::Binary(bytes) if bytes.is_empty() => {
                if !frames.last().unwrap().is_empty() {
                    let _ = delivered.send(());
                    if !acked_first_frame {
                        no_request_before_ack
                            .take()
                            .unwrap()
                            .await
                            .expect("server verified the ACK boundary");
                        client
                            .send(Message::Binary(vec![0].into()))
                            .await
                            .expect("send framebuffer ACK");
                        acked_first_frame = true;
                    }
                }
                frames.push(Vec::new());
            }
            Message::Binary(bytes) => frames.last_mut().unwrap().push(bytes.to_vec()),
            _ => {}
        }
    }
    // The server saw an incremental request only after the first frame ACK.
    let _ = client.close(None).await;
    drop(session);
    let next_request = tokio::task::spawn_blocking(move || server.join().unwrap())
        .await
        .unwrap();
    assert_eq!(next_request[0], 3, "FramebufferUpdateRequest");
    assert_eq!(next_request[1], 1, "incremental");

    assert!(
        texts
            .iter()
            .any(|text| text.contains("\"type\":\"connected\""))
    );
    assert!(
        texts
            .iter()
            .any(|text| text.contains("\"type\":\"desktop_size\"") && text.contains("\"width\":2")),
        "desktop_size notification: {texts:?}"
    );
    let painted: Vec<&Vec<Vec<u8>>> = frames.iter().filter(|frame| !frame.is_empty()).collect();
    // First frame: one 4x2 rect of value 7.
    assert_eq!(painted[0].len(), 1);
    assert_eq!(&painted[0][0][..8], &[0, 0, 0, 0, 0, 4, 0, 2]);
    assert!(painted[0][0][12..].chunks(4).all(|px| px == [7, 7, 7, 255]));
    // After the resize the whole new 2x2 surface is repainted.
    assert_eq!(&painted[1][0][..8], &[0, 0, 0, 0, 0, 2, 0, 2]);
    assert!(painted[1][0][12..].chunks(4).all(|px| px == [9, 9, 9, 255]));
}
