use super::authorization::is_authorized_origin;
use super::model::RdpControl;
use super::model::RdpSpawnConfig;
use super::model::WsIncomingText;
use super::outgoing::WsOutgoing;
use super::outgoing::WsOutgoingQueue;
use super::relay::run_relay;
use super::relay::spawn_rdp_relay;
use super::wire::channel;
use super::wire::frame_payload_with_header;
use super::wire::parse_binary_control;
use crate::rdp::RdpOptions;
use crate::rdp::frame::TileHeader;
use crate::rdp::session::RdpSessionHandle;
use crate::rdp::session::SessionOutput;
use futures::SinkExt;
use futures::StreamExt;
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tungstenite::Message;
use tungstenite::http::HeaderValue;
use tungstenite::http::header;

use std::time::{Duration, Instant};
use tokio_tungstenite::connect_async;
use tungstenite::client::IntoClientRequest;

#[test]
fn parse_key_event() {
    let buf = [channel::IN_KEY, 1, 0x00, 0x1c]; // Enter
    match parse_binary_control(&buf).unwrap() {
        RdpControl::Key(k) => {
            assert!(k.down);
            assert_eq!(k.scancode, 0x001c);
        }
        _ => panic!(),
    }
}

#[tokio::test]
async fn websocket_output_keeps_incremental_frame_batches_in_order() {
    let (sender, mut receiver) = WsOutgoingQueue::new();
    let _ = sender.send(WsOutgoing::Frame(vec![channel::FRAME, 1]));
    let _ = sender.send(WsOutgoing::Frame(vec![channel::FRAME_END]));
    let _ = sender.send(WsOutgoing::Frame(vec![channel::FRAME, 2]));
    let _ = sender.send(WsOutgoing::Frame(vec![channel::FRAME_END]));
    assert!(matches!(
        receiver.recv().await,
        Some(WsOutgoing::Frame(bytes)) if bytes == vec![channel::FRAME, 1]
    ));
    assert!(matches!(
        receiver.recv().await,
        Some(WsOutgoing::Frame(bytes)) if bytes == vec![channel::FRAME, 2]
    ));
    assert!(matches!(
        receiver.recv().await,
        Some(WsOutgoing::Frame(bytes)) if bytes == vec![channel::FRAME_END]
    ));
}

#[test]
fn parse_pointer_event() {
    let buf = [channel::IN_POINTER, 0x01, 0x01, 0x90, 0x01, 0x2c];
    match parse_binary_control(&buf).unwrap() {
        RdpControl::Pointer(p) => {
            assert_eq!(p.buttons, 1);
            assert_eq!(p.x, 0x0190);
            assert_eq!(p.y, 0x012c);
        }
        _ => panic!(),
    }
}

#[test]
fn parse_resize() {
    let buf = [channel::IN_RESIZE, 0x07, 0x80, 0x04, 0x38];
    match parse_binary_control(&buf).unwrap() {
        RdpControl::Resize { width, height } => {
            assert_eq!(width, 1920);
            assert_eq!(height, 1080);
        }
        _ => panic!(),
    }
}

#[test]
fn parse_wheel() {
    let buf = [channel::IN_WHEEL, 0x00, 0x01, 0x90, 0x01, 0x2c, 0xff, 0x88];
    match parse_binary_control(&buf).unwrap() {
        RdpControl::Wheel(w) => {
            assert!(w.is_vertical);
            assert_eq!(w.x, 0x0190);
            assert_eq!(w.y, 0x012c);
            assert_eq!(w.rotation_units, -120);
        }
        _ => panic!(),
    }
}

#[test]
fn parse_ping_and_ack_are_ack() {
    assert!(matches!(
        parse_binary_control(&[channel::IN_PING]),
        Some(RdpControl::Ack)
    ));
    assert!(matches!(
        parse_binary_control(&[channel::IN_ACK]),
        Some(RdpControl::Ack)
    ));
}

#[test]
fn parses_unicode_and_release_input_messages() {
    match serde_json::from_str::<WsIncomingText>(r#"{"type":"unicode","text":"中文😀"}"#).unwrap()
    {
        WsIncomingText::Unicode { text } => assert_eq!(text, "中文😀"),
        _ => panic!("expected Unicode input"),
    }
    assert!(matches!(
        serde_json::from_str::<WsIncomingText>(r#"{"type":"release_input"}"#).unwrap(),
        WsIncomingText::ReleaseInput
    ));
}

#[test]
fn parse_refresh() {
    assert!(matches!(
        parse_binary_control(&[channel::IN_REFRESH]),
        Some(RdpControl::Refresh)
    ));
}

#[test]
fn parse_truncated_returns_none() {
    assert!(parse_binary_control(&[channel::IN_KEY]).is_none());
    assert!(parse_binary_control(&[channel::IN_POINTER, 1]).is_none());
    assert!(parse_binary_control(&[channel::IN_WHEEL, 0]).is_none());
    assert!(parse_binary_control(&[channel::IN_WHEEL, 0, 0, 0, 0, 0, 0, 0]).is_none());
    assert!(parse_binary_control(&[]).is_none());
}

#[test]
fn frame_payload_layout() {
    let h = TileHeader {
        x: 10,
        y: 20,
        w: 30,
        h: 40,
    };
    let rgba = vec![0xff, 0x00, 0x00, 0xff];
    let p = frame_payload_with_header(h, &rgba);
    assert_eq!(&p[0..2], &10u16.to_be_bytes());
    assert_eq!(&p[2..4], &20u16.to_be_bytes());
    assert_eq!(&p[4..6], &30u16.to_be_bytes());
    assert_eq!(&p[6..8], &40u16.to_be_bytes());
    assert_eq!(&p[8..], &rgba[..]);
}

#[test]
fn relay_origin_allowlist_rejects_unrelated_pages() {
    assert!(is_authorized_origin("tauri://localhost"));
    assert!(is_authorized_origin("https://tauri.localhost"));
    assert!(!is_authorized_origin("https://attacker.example"));
    assert!(!is_authorized_origin("null"));
}

#[tokio::test]
async fn late_controls_do_not_replace_the_connection_error_in_the_websocket() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (session, output, receiver) = RdpSessionHandle::new();
    let original = r#"{"type":"error","code":"rdp-session","message":"rdp TLS upgrade failed: handshake error"}"#;
    output
        .send(SessionOutput::Text(original.to_string()))
        .unwrap();
    drop(receiver);
    let (controls, controls_rx) = mpsc::unbounded_channel();
    // Both branches are ready when the relay starts. Its biased control
    // branch used to queue a generic ctrl-channel error ahead of this one.
    controls.send(RdpControl::Refresh).unwrap();
    controls
        .send(RdpControl::Resize {
            width: 1280,
            height: 720,
        })
        .unwrap();
    let (ws_out, ws_rx) = WsOutgoingQueue::new();
    let cancel = CancellationToken::new();
    let task = tokio::spawn(run_relay(
        listener,
        session,
        ws_out,
        ws_rx,
        controls,
        controls_rx,
        cancel.clone(),
        "test-error".to_string(),
    ));
    let mut request = format!("ws://{address}").into_client_request().unwrap();
    request.headers_mut().insert(
        header::ORIGIN,
        HeaderValue::from_static("tauri://localhost"),
    );
    request.headers_mut().insert(
        header::SEC_WEBSOCKET_PROTOCOL,
        HeaderValue::from_static("taomni-rdp.test-error"),
    );
    let (mut socket, _) = connect_async(request).await.unwrap();
    let message = tokio::time::timeout(Duration::from_secs(5), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(message, Message::Text(original.into()));
    cancel.cancel();
    socket.close(None).await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires TAOMNI_RDP_LIVE_HOST/USER/PASS and a reachable Windows RDP server"]
async fn live_credssp_relay_authorizes_websocket_and_delivers_first_frame() {
    let host = std::env::var("TAOMNI_RDP_LIVE_HOST").expect("TAOMNI_RDP_LIVE_HOST is required");
    let port = std::env::var("TAOMNI_RDP_LIVE_PORT")
        .ok()
        .and_then(|raw| raw.parse::<u16>().ok())
        .unwrap_or(3389);
    let username = std::env::var("TAOMNI_RDP_LIVE_USER").expect("TAOMNI_RDP_LIVE_USER is required");
    let password = std::env::var("TAOMNI_RDP_LIVE_PASS").expect("TAOMNI_RDP_LIVE_PASS is required");
    let mut options = RdpOptions::default();
    options.screen_w = 1280;
    options.screen_h = 720;
    options.nla = true;
    if let Ok(pin) = std::env::var("TAOMNI_RDP_LIVE_CERTIFICATE_FINGERPRINT") {
        if !pin.trim().is_empty() {
            options.certificate_fingerprint = Some(pin);
        }
    }

    let started = Instant::now();
    let session = spawn_rdp_relay(RdpSpawnConfig {
        host,
        port,
        username: Some(username),
        password: Some(password),
        options,
        network: None,
    })
    .await
    .expect("start live RDP relay");

    let expected_protocol = format!("taomni-rdp.{}", session.ws_token);
    let mut request = format!("ws://127.0.0.1:{}", session.ws_port)
        .into_client_request()
        .expect("build relay WebSocket request");
    request.headers_mut().insert(
        header::ORIGIN,
        HeaderValue::from_static("tauri://localhost"),
    );
    request.headers_mut().insert(
        header::SEC_WEBSOCKET_PROTOCOL,
        HeaderValue::from_str(&expected_protocol).expect("generated protocol is valid"),
    );
    let (mut socket, response) = connect_async(request)
        .await
        .expect("connect to authorized live RDP relay");
    assert_eq!(
        response
            .headers()
            .get(header::SEC_WEBSOCKET_PROTOCOL)
            .and_then(|value| value.to_str().ok()),
        Some(expected_protocol.as_str())
    );

    let deadline = Instant::now() + Duration::from_secs(45);
    let mut connected_at = None;
    let mut first_frame_at = None;
    while Instant::now() < deadline && first_frame_at.is_none() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let message = tokio::time::timeout(remaining, socket.next())
            .await
            .expect("timed out waiting for live RDP relay output")
            .expect("live RDP relay closed before first frame")
            .expect("read live RDP relay message");
        match message {
            Message::Text(text) => {
                let value = serde_json::from_str::<serde_json::Value>(&text)
                    .expect("live relay status is valid JSON");
                match value.get("type").and_then(|value| value.as_str()) {
                    Some("connected") => {
                        connected_at = Some(started.elapsed());
                        socket
                            .send(Message::Binary(vec![channel::IN_ACK].into()))
                            .await
                            .expect("acknowledge live RDP relay");
                        socket
                            .send(Message::Binary(vec![channel::IN_REFRESH].into()))
                            .await
                            .expect("request live RDP refresh");
                    }
                    Some("error") => panic!("live RDP relay failed: {text}"),
                    _ => {}
                }
            }
            Message::Binary(frame) if frame.first() == Some(&channel::FRAME) && frame.len() > 9 => {
                first_frame_at = Some(started.elapsed());
            }
            _ => {}
        }
    }

    socket
        .send(Message::Text(r#"{"type":"disconnect"}"#.into()))
        .await
        .expect("disconnect live RDP relay");
    let _ = socket.close(None).await;
    tokio::time::timeout(Duration::from_secs(5), session.cancel.cancelled())
        .await
        .expect("live RDP relay shut down after disconnect");

    let connected_at = connected_at.expect("live RDP relay did not report connected");
    let first_frame_at = first_frame_at.expect("live RDP relay did not deliver a frame");
    eprintln!("live RDP relay timing: connected={connected_at:?}, first_frame={first_frame_at:?}");
}
