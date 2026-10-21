use super::*;
use std::time::Duration;
use tokio::net::TcpStream;

#[test]
fn network_characteristics_become_a_network_event() {
    use ironrdp::pdu::rdp::autodetect::{AutoDetectRequest, NETCHAR_RESULT_RTT};
    let result = AutoDetectRequest::NetworkCharacteristicsResult {
        sequence_number: 7,
        request_type: NETCHAR_RESULT_RTT,
        base_rtt_ms: Some(3),
        bandwidth_kbps: None,
        average_rtt_ms: 5,
    };
    let event: serde_json::Value =
        serde_json::from_str(&network_characteristics_event(&result).unwrap()).unwrap();
    assert_eq!(event["type"], "network");
    assert_eq!(event["baseRttMs"], 3);
    assert_eq!(event["averageRttMs"], 5);
    assert!(event["bandwidthKbps"].is_null());
    assert!(network_characteristics_event(&AutoDetectRequest::rtt_continuous(1)).is_none());
}

/// Live RDP fixtures commonly use a self-signed certificate. Keep the
/// production default fail-closed, while letting an operator explicitly
/// supply the known SHA-256 leaf pin for ignored live tests.
fn apply_live_certificate_pin(options: &mut RdpOptions) {
    let Ok(pin) = std::env::var("TAOMNI_RDP_LIVE_CERTIFICATE_FINGERPRINT") else {
        return;
    };
    if !pin.trim().is_empty() {
        options.certificate_fingerprint = Some(pin);
    }
}

#[tokio::test]
async fn handle_round_trip_via_channels() {
    let (mut handle, out_tx, _ctrl_rx) = RdpSessionHandle::new();
    let _ = out_tx.send(SessionOutput::Channel {
        tag: 1,
        payload: vec![1, 2, 3],
    });
    match handle.next_outgoing().await.unwrap() {
        SessionOutput::Channel { tag, payload } => {
            assert_eq!(tag, 1);
            assert_eq!(payload, vec![1, 2, 3]);
        }
        SessionOutput::Text(_) => panic!("expected channel output"),
    }
}

#[tokio::test]
async fn slow_output_consumer_keeps_incremental_frame_batches_in_order() {
    let (mut handle, out_tx, _ctrl_rx) = RdpSessionHandle::new();
    for value in [1_u8, 2_u8] {
        let _ = out_tx.send(SessionOutput::Channel {
            tag: channel::FRAME,
            payload: vec![value],
        });
        let _ = out_tx.send(SessionOutput::Channel {
            tag: channel::FRAME_END,
            payload: Vec::new(),
        });
    }
    assert!(matches!(
        handle.next_outgoing().await,
        Some(SessionOutput::Channel { tag: channel::FRAME, payload }) if payload == vec![1]
    ));
    assert!(matches!(
        handle.next_outgoing().await,
        Some(SessionOutput::Channel { tag: channel::FRAME, payload }) if payload == vec![2]
    ));
    assert!(matches!(
        handle.next_outgoing().await,
        Some(SessionOutput::Channel {
            tag: channel::FRAME_END,
            ..
        })
    ));
}

#[tokio::test]
async fn dispatch_control_returns_err_when_dropped() {
    let (handle, _out_tx, ctrl_rx) = RdpSessionHandle::new();
    drop(ctrl_rx);
    let res = handle
        .dispatch_control(RdpControl::Resize {
            width: 1,
            height: 1,
        })
        .await;
    assert!(res.is_err());
}

#[test]
fn pointer_operations_track_button_edges() {
    let mut last = 0;
    let ops = pointer_operations(
        PointerEvent {
            x: 10,
            y: 20,
            buttons: 0x01,
        },
        &mut last,
    );
    assert!(matches!(
        ops[0],
        Operation::MouseMove(MousePosition { x: 10, y: 20 })
    ));
    assert!(matches!(
        ops[1],
        Operation::MouseButtonPressed(MouseButton::Left)
    ));
    assert_eq!(last, 0x01);

    let ops = pointer_operations(
        PointerEvent {
            x: 11,
            y: 21,
            buttons: 0x00,
        },
        &mut last,
    );
    assert!(matches!(
        ops[1],
        Operation::MouseButtonReleased(MouseButton::Left)
    ));
    assert_eq!(last, 0x00);
}

#[test]
fn connector_uses_client_side_cursor_rendering() {
    let settings = RdpConnectionSettings {
        host: "rdp.example.test".to_owned(),
        port: 3389,
        username: Some("user".to_owned()),
        password: Some("password".to_owned()),
        options: RdpOptions::default(),
        network: None,
    };

    let config = build_ironrdp_config(&settings);

    assert!(config.enable_server_pointer);
    assert!(!config.pointer_software_rendering);
    assert_eq!(
        config.compression_type,
        Some(ironrdp::pdu::rdp::client_info::CompressionType::Rdp61)
    );
}

#[test]
fn cursor_bitmap_payload_preserves_shape_and_hotspot_as_png() {
    let pointer = DecodedPointer {
        width: 2,
        height: 1,
        hotspot_x: 1,
        hotspot_y: 0,
        bitmap_data: vec![
            0xff, 0x00, 0x00, 0xff, // opaque red
            0x00, 0xff, 0x00, 0x80, // translucent green
        ],
    };

    let payload = cursor_bitmap_payload(&pointer).expect("encode cursor payload");

    assert_eq!(payload[0], cursor::BITMAP);
    assert_eq!(u16::from_be_bytes([payload[1], payload[2]]), 1);
    assert_eq!(u16::from_be_bytes([payload[3], payload[4]]), 0);
    assert_eq!(u16::from_be_bytes([payload[5], payload[6]]), 2);
    assert_eq!(u16::from_be_bytes([payload[7], payload[8]]), 1);
    let decoded = image::load_from_memory(&payload[cursor::BITMAP_HEADER_LEN..])
        .expect("decode cursor PNG")
        .to_rgba8();
    assert_eq!(decoded.into_raw(), pointer.bitmap_data);
}

#[test]
fn cursor_bitmap_payload_hides_empty_and_rejects_invalid_shapes() {
    assert_eq!(
        cursor_bitmap_payload(&DecodedPointer::new_invisible()).unwrap(),
        vec![cursor::HIDDEN]
    );

    let invalid = DecodedPointer {
        width: 1,
        height: 1,
        hotspot_x: 1,
        hotspot_y: 0,
        bitmap_data: vec![0; 4],
    };
    assert!(cursor_bitmap_payload(&invalid).is_err());
}

#[test]
fn wheel_operations_preserve_position_axis_and_units() {
    let ops = wheel_operations(PointerWheelEvent {
        x: 25,
        y: 40,
        is_vertical: false,
        rotation_units: -120,
    });

    assert!(matches!(
        ops[0],
        Operation::MouseMove(MousePosition { x: 25, y: 40 })
    ));
    match ops[1] {
        Operation::WheelRotations(rotations) => {
            assert!(!rotations.is_vertical);
            assert_eq!(rotations.rotation_units, -120);
        }
        _ => panic!("expected wheel rotation"),
    }
}

#[test]
fn key_operations_preserve_frontend_extended_flag() {
    let ops = key_operations(KeyEvent {
        down: true,
        scancode: 0x0148,
    });
    match &ops[0] {
        Operation::KeyPressed(scancode) => assert_eq!(scancode.as_u8(), (true, 0x48)),
        _ => panic!("expected key press"),
    }
}

#[test]
fn unicode_operations_press_and_release_each_character() {
    let ops = unicode_operations("中😀");
    assert_eq!(ops.len(), 4);
    assert!(matches!(ops[0], Operation::UnicodeKeyPressed('中')));
    assert!(matches!(ops[1], Operation::UnicodeKeyReleased('中')));
    assert!(matches!(ops[2], Operation::UnicodeKeyPressed('😀')));
    assert!(matches!(ops[3], Operation::UnicodeKeyReleased('😀')));
}

#[test]
fn negotiation_transport_cause_survives_error_formatting() {
    for kind in [
        std::io::ErrorKind::ConnectionReset,
        std::io::ErrorKind::UnexpectedEof,
    ] {
        let cause = std::io::Error::new(kind, "not enough bytes");
        let error = connector::custom_err!("read frame by hint", cause);
        let message = negotiation_error(error);
        assert!(is_retryable_rdp_error(&message), "{message}");
    }
    let error = connector::custom_err!("read frame by hint", std::io::Error::other("invalid PDU"));
    assert!(!is_retryable_rdp_error(&negotiation_error(error)));
}

#[test]
fn retryable_error_classifier_excludes_authentication_failures() {
    assert!(is_retryable_rdp_error(
        "RDP TLS handshake timed out after 15 seconds"
    ));
    assert!(is_retryable_rdp_error(
        "rdp read frame: Connection reset by peer"
    ));
    assert!(!is_retryable_rdp_error(
        "rdp connection finalization failed: invalid credentials"
    ));
    assert!(!is_retryable_rdp_error(
        "RDP_CERTIFICATE_CHANGED host=server"
    ));
}

#[test]
fn normalize_width_is_even_and_in_range() {
    assert_eq!(normalize_width(199), 200);
    assert_eq!(normalize_width(201), 200);
    assert_eq!(normalize_width(8191), 8190);
    assert_eq!(normalize_width(8193), 8192);
}

#[test]
fn rdpsnd_backend_advertises_pcm_44100_stereo() {
    let (_handle, out_tx, _ctrl_rx) = RdpSessionHandle::new();
    let backend = RdpsndWsBackend::new(out_tx);
    let formats = backend.get_formats();
    assert_eq!(formats.len(), 1);
    assert_eq!(formats[0].format, IronWaveFormat::PCM);
    assert_eq!(formats[0].n_channels, 2);
    assert_eq!(formats[0].n_samples_per_sec, 44_100);
    assert_eq!(formats[0].bits_per_sample, 16);
    assert_eq!(formats[0].n_block_align, 4);
}

#[test]
fn audio_payload_layout() {
    let payload = audio_payload_with_header(7, 0x1234_5678, &[0xaa, 0xbb, 0xcc]);
    assert_eq!(&payload[0..4], &44_100u32.to_be_bytes());
    assert_eq!(&payload[4..6], &2u16.to_be_bytes());
    assert_eq!(&payload[6..8], &16u16.to_be_bytes());
    assert_eq!(&payload[8..12], &0x1234_5678u32.to_be_bytes());
    assert_eq!(&payload[12..14], &7u16.to_be_bytes());
    assert_eq!(&payload[14..16], &0u16.to_be_bytes());
    assert_eq!(&payload[16..], &[0xaa, 0xbb, 0xcc]);
}

#[test]
fn local_clipboard_files_build_relative_descriptors() {
    let dir = tempfile::tempdir().unwrap();
    let root_file = dir.path().join("note.txt");
    std::fs::write(&root_file, b"hello").unwrap();
    let folder = dir.path().join("folder");
    std::fs::create_dir(&folder).unwrap();
    std::fs::write(folder.join("child.txt"), b"child").unwrap();

    let files = collect_local_clipboard_files(&[
        root_file.to_string_lossy().into_owned(),
        folder.to_string_lossy().into_owned(),
    ])
    .unwrap();

    let names: Vec<_> = files.iter().map(|file| file.name.as_str()).collect();
    assert!(names.contains(&"note.txt"));
    assert!(names.contains(&"folder"));
    assert!(names.contains(&"folder\\child.txt"));
    assert!(
        files
            .iter()
            .any(|file| file.name == "folder" && file.is_directory)
    );
}

#[test]
fn local_file_contents_response_reads_size_and_range() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("payload.bin");
    std::fs::write(&file, b"abcdef").unwrap();
    let files = collect_local_clipboard_files(&[file.to_string_lossy().into_owned()]).unwrap();
    let (_handle, out_tx, _ctrl_rx) = RdpSessionHandle::new();
    let bridge = ClipboardBridge::new(out_tx);
    bridge.set_local_files(files);

    let size = bridge.local_file_contents_response(&FileContentsRequest {
        stream_id: 7,
        index: 0,
        flags: FileContentsFlags::SIZE,
        position: 0,
        requested_size: 8,
        data_id: None,
    });
    assert_eq!(size.stream_id(), 7);
    assert_eq!(size.data_as_size().unwrap(), 6);

    let data = bridge.local_file_contents_response(&FileContentsRequest {
        stream_id: 8,
        index: 0,
        flags: FileContentsFlags::RANGE,
        position: 2,
        requested_size: 3,
        data_id: None,
    });
    assert_eq!(data.stream_id(), 8);
    assert_eq!(data.data(), b"cde");
}

#[tokio::test]
async fn remote_file_contents_response_stages_files_and_notifies_frontend() {
    let (mut handle, out_tx, _ctrl_rx) = RdpSessionHandle::new();
    let bridge = ClipboardBridge::new(out_tx);
    bridge.start_remote_file_receive(PackedFileList {
        files: vec![
            IronClipboardFileDescriptor::new("remote.txt")
                .with_attributes(ClipboardFileAttributes::NORMAL)
                .with_file_size(3),
        ],
    });

    let actions = bridge.drain_actions();
    let request = match actions.as_slice() {
        [ClipboardAction::RequestRemoteFileContents(requests)] => requests[0].clone(),
        _ => panic!("expected remote file contents request"),
    };
    assert_eq!(request.index, 0);
    assert_eq!(request.position, 0);
    assert_eq!(request.requested_size, 3);

    bridge.handle_remote_file_contents_response(FileContentsResponse::new_data_response(
        request.stream_id,
        b"abc".to_vec(),
    ));

    let output = tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            if let Some(SessionOutput::Text(text)) = handle.next_outgoing().await {
                let value: serde_json::Value = serde_json::from_str(&text).unwrap();
                if value.get("type").and_then(|v| v.as_str()) == Some("clipboard_files") {
                    return value;
                }
            }
        }
    })
    .await
    .expect("clipboard_files notification");
    let path = output["paths"][0].as_str().unwrap();
    assert_eq!(std::fs::read(path).unwrap(), b"abc");
    let staged_path = PathBuf::from(path);
    drop(bridge);
    assert!(!staged_path.exists());
}

#[test]
fn remote_file_clipboard_rejects_declared_size_over_quota() {
    let error = build_remote_file_transfer(PackedFileList {
        files: vec![
            IronClipboardFileDescriptor::new("too-large.bin")
                .with_attributes(ClipboardFileAttributes::NORMAL)
                .with_file_size(MAX_CLIPBOARD_FILE_BYTES + 1),
        ],
    })
    .unwrap_err();

    assert!(error.contains("per-file quota"));
}

#[cfg(unix)]
#[test]
fn local_file_clipboard_does_not_follow_nested_symlinks() {
    use std::os::unix::fs::symlink;

    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::NamedTempFile::new().unwrap();
    symlink(outside.path(), root.path().join("linked-secret")).unwrap();

    let error =
        collect_local_clipboard_files(&[root.path().to_string_lossy().into_owned()]).unwrap_err();

    assert!(error.contains("symbolic link"));
}

#[test]
fn parse_connected_event_extracts_desktop_metadata() {
    let result = parse_connected_event(
            r#"{"type":"connected","width":1280,"height":720,"protocol":"CredSSP/NLA","server_name":"win10"}"#,
        )
        .expect("connected event parses")
        .expect("connected event yields result");

    assert_eq!(
        result,
        RdpConnectionTestResult {
            width: 1280,
            height: 720,
            protocol: "CredSSP/NLA".to_owned(),
            server_name: "win10".to_owned(),
        }
    );
}

#[test]
fn parse_connected_event_ignores_non_terminal_status() {
    assert_eq!(
        parse_connected_event(r#"{"type":"status","stage":"credssp"}"#)
            .expect("status event parses"),
        None
    );
    assert_eq!(
        parse_connected_event("not-json").expect("invalid json is ignored"),
        None
    );
}

#[test]
fn parse_connected_event_maps_terminal_failures() {
    assert_eq!(
        parse_connected_event(r#"{"type":"error","message":"bad credentials"}"#)
            .expect_err("error event aborts"),
        "bad credentials"
    );
    assert_eq!(
        parse_connected_event(r#"{"type":"disconnected","reason":"server closed"}"#)
            .expect_err("disconnect event aborts"),
        "server closed"
    );
}

#[test]
fn parse_connected_event_rejects_invalid_desktop_size() {
    assert!(parse_connected_event(r#"{"type":"connected","width":70000,"height":720}"#).is_err());
    assert!(parse_connected_event(r#"{"type":"connected","width":1280,"height":"720"}"#).is_err());
}

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
