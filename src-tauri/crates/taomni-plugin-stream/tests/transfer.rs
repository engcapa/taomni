//! Every test here opens real sockets or processes. Run only on GitHub runners:
//! cargo test -p taomni-plugin-stream --test transfer -- --ignored --test-threads=1
use std::{net::SocketAddrV4, process::Stdio, time::Duration};

use futures_util::{SinkExt, StreamExt};
use sha2::{Digest, Sha256};
use taomni_plugin_api::{BinaryRef, ErrorCode};
use taomni_plugin_stream::{CancellationToken, MAX_PAYLOAD_BYTES, TransferLimits, offer, receive};
use tokio::{
    io::AsyncWriteExt,
    net::{TcpListener, TcpStream},
    process::Command,
    time::timeout,
};
use tokio_tungstenite::{
    accept_async, client_async,
    tungstenite::{Message, client::IntoClientRequest, http::HeaderValue},
};

fn limits() -> TransferLimits {
    TransferLimits {
        timeout: Duration::from_secs(5),
        ..Default::default()
    }
}

fn address(descriptor: &BinaryRef) -> SocketAddrV4 {
    descriptor
        .stream_url
        .strip_prefix("ws://")
        .unwrap()
        .split('/')
        .next()
        .unwrap()
        .parse()
        .unwrap()
}

fn request(descriptor: &BinaryRef) -> tokio_tungstenite::tungstenite::handshake::client::Request {
    let mut request = descriptor
        .stream_url
        .as_str()
        .into_client_request()
        .unwrap();
    request.headers_mut().insert(
        "authorization",
        HeaderValue::from_str(&format!("Bearer {}", descriptor.token)).unwrap(),
    );
    request
}

fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[tokio::test]
#[ignore = "real process and loopback: GitHub only"]
async fn child_receives_empty_multichunk_and_full_hd_frame_and_token_cannot_replay() {
    for size in [0, 131_079, 1920 * 1080 * 4] {
        let bytes: Vec<u8> = (0..size).map(|index| (index % 251) as u8).collect();
        let expected = format!("{} {}", bytes.len(), digest(&bytes));
        let pending = offer(bytes, "application/octet-stream", limits())
            .await
            .unwrap();
        let descriptor = pending.descriptor().clone();
        let mut child = Command::new(env!("CARGO_BIN_EXE_plugin-stream-gate-receiver"))
            .kill_on_drop(true)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut input = child.stdin.take().unwrap();
        input
            .write_all(&serde_json::to_vec(&descriptor).unwrap())
            .await
            .unwrap();
        drop(input);
        let result = timeout(Duration::from_secs(20), child.wait_with_output())
            .await
            .unwrap()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        assert_eq!(String::from_utf8(result.stdout).unwrap().trim(), expected);
        assert_eq!(pending.finish().await.unwrap(), size as u64);
        assert!(TcpStream::connect(address(&descriptor)).await.is_err());
        assert_eq!(
            receive(&descriptor, limits(), &CancellationToken::new())
                .await
                .unwrap_err()
                .code,
            ErrorCode::PluginCrashed as i32
        );
        println!("child verified {size} bytes; listener closed; replay rejected");
    }
}

#[tokio::test]
#[ignore = "real loopback: GitHub only"]
async fn wrong_token_and_webview_origin_cannot_consume_the_offer() {
    let pending = offer(
        b"only native receiver".to_vec(),
        "application/octet-stream",
        limits(),
    )
    .await
    .unwrap();
    let descriptor = pending.descriptor();
    for origin in [false, true] {
        let stream = TcpStream::connect(address(descriptor)).await.unwrap();
        let mut attack = request(descriptor);
        if origin {
            attack
                .headers_mut()
                .insert("origin", HeaderValue::from_static("tauri://localhost"));
        } else {
            attack
                .headers_mut()
                .insert("authorization", HeaderValue::from_static("Bearer wrong"));
        }
        let error = client_async(attack, stream).await.unwrap_err();
        match error {
            tokio_tungstenite::tungstenite::Error::Http(response) => {
                assert_eq!(response.status(), 403)
            }
            _ => panic!("expected HTTP 403"),
        }
    }
    let bytes = receive(descriptor, limits(), &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(bytes, b"only native receiver");
    pending.finish().await.unwrap();
}

#[tokio::test]
#[ignore = "real loopback: GitHub only"]
async fn stalled_unauthenticated_peer_does_not_consume_or_hold_the_offer() {
    let pending = offer(b"live".to_vec(), "application/octet-stream", limits())
        .await
        .unwrap();
    let _stalled = TcpStream::connect(address(pending.descriptor()))
        .await
        .unwrap();
    assert_eq!(
        receive(pending.descriptor(), limits(), &CancellationToken::new())
            .await
            .unwrap(),
        b"live"
    );
    pending.finish().await.unwrap();
}

#[tokio::test]
#[ignore = "real loopback: GitHub only"]
async fn cancel_and_timeout_confirm_listener_reclamation() {
    let pending = offer(vec![1], "application/octet-stream", limits())
        .await
        .unwrap();
    let endpoint = address(pending.descriptor());
    assert_eq!(
        pending.cancel_and_wait().await.unwrap_err().code,
        ErrorCode::RequestCancelled as i32
    );
    assert!(TcpStream::connect(endpoint).await.is_err());

    let pending = offer(
        vec![1],
        "application/octet-stream",
        TransferLimits {
            timeout: Duration::from_millis(30),
            ..limits()
        },
    )
    .await
    .unwrap();
    let endpoint = address(pending.descriptor());
    assert_eq!(
        pending.finish().await.unwrap_err().code,
        ErrorCode::RequestTimeout as i32
    );
    assert!(TcpStream::connect(endpoint).await.is_err());
}

#[tokio::test]
#[ignore = "real loopback: GitHub only"]
async fn cancelling_a_blocked_large_transfer_reclaims_the_connected_socket() {
    let pending = offer(
        vec![8; MAX_PAYLOAD_BYTES],
        "application/octet-stream",
        limits(),
    )
    .await
    .unwrap();
    let endpoint = address(pending.descriptor());
    let stream = TcpStream::connect(endpoint).await.unwrap();
    let (mut unread, _) = client_async(request(pending.descriptor()), stream)
        .await
        .unwrap();
    assert_eq!(
        pending.cancel_and_wait().await.unwrap_err().code,
        ErrorCode::RequestCancelled as i32
    );
    assert!(TcpStream::connect(endpoint).await.is_err());
    let received = timeout(Duration::from_secs(2), async {
        let mut bytes = 0;
        while let Some(Ok(message)) = unread.next().await {
            if let Message::Binary(chunk) = message {
                bytes += chunk.len();
            }
        }
        bytes
    })
    .await
    .expect("cancelled sender must close its connected socket");
    assert!(
        received < MAX_PAYLOAD_BYTES,
        "cancel must stop the queued transfer"
    );
}

#[tokio::test]
#[ignore = "real loopback: GitHub only"]
async fn checksum_mismatch_never_returns_unverified_payload() {
    let pending = offer(b"actual".to_vec(), "application/octet-stream", limits())
        .await
        .unwrap();
    let mut wrong = pending.descriptor().clone();
    wrong.sha256 = digest(b"wrong!");
    assert_eq!(
        receive(&wrong, limits(), &CancellationToken::new())
            .await
            .unwrap_err()
            .code,
        ErrorCode::InvalidRequest as i32
    );
    pending.finish().await.unwrap();
}

#[tokio::test]
#[ignore = "real loopback: GitHub only"]
async fn receiver_deadline_and_cancellation_drop_a_stalled_connection() {
    for cancel in [true, false] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = listener.local_addr().unwrap();
        let descriptor = BinaryRef {
            stream_url: format!("ws://{endpoint}/stalled"),
            token: "fixture-token".into(),
            content_type: "application/octet-stream".into(),
            byte_len: 1,
            sha256: digest(&[0]),
        };
        let cancellation = CancellationToken::new();
        let server_cancel = cancellation.clone();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = accept_async(stream).await.unwrap();
            if cancel {
                server_cancel.cancel();
            }
            // Reading detects the client's actual TCP closure, rather than just
            // observing its cancellation flag or dropping our end of the socket.
            let disconnected = timeout(Duration::from_secs(2), socket.next())
                .await
                .unwrap();
            assert!(matches!(
                disconnected,
                None | Some(Err(_)) | Some(Ok(Message::Close(_)))
            ));
        });
        let error = receive(
            &descriptor,
            TransferLimits {
                timeout: Duration::from_millis(250),
                ..limits()
            },
            &cancellation,
        )
        .await
        .unwrap_err();
        assert_eq!(
            error.code,
            if cancel {
                ErrorCode::RequestCancelled
            } else {
                ErrorCode::RequestTimeout
            } as i32
        );
        server.await.unwrap();
    }
}

#[tokio::test]
#[ignore = "real loopback: GitHub only"]
async fn advertised_length_and_wire_message_limits_reject_malicious_peers() {
    for payload_size in [5, 65_537] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let descriptor = BinaryRef {
            stream_url: format!("ws://{}/malformed", listener.local_addr().unwrap()),
            token: "fixture-token".into(),
            content_type: "application/octet-stream".into(),
            byte_len: 4,
            sha256: digest(b"safe"),
        };
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = accept_async(stream).await.unwrap();
            let _ = socket
                .send(Message::Binary(vec![1; payload_size].into()))
                .await;
            let _ = socket.close(None).await;
        });
        let error = receive(&descriptor, limits(), &CancellationToken::new())
            .await
            .unwrap_err();
        assert!(
            matches!(error.code, code if code == ErrorCode::InvalidRequest as i32 || code == ErrorCode::PluginCrashed as i32)
        );
        server.await.unwrap();
    }
}

#[tokio::test]
#[ignore = "real loopback: GitHub only"]
async fn interrupted_truncated_and_text_messages_never_publish_bytes() {
    for scenario in ["interrupted", "truncated", "text"] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let descriptor = BinaryRef {
            stream_url: format!("ws://{}/incomplete", listener.local_addr().unwrap()),
            token: "fixture-token".into(),
            content_type: "application/octet-stream".into(),
            byte_len: 4,
            sha256: digest(b"safe"),
        };
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = accept_async(stream).await.unwrap();
            let message = if scenario == "text" {
                Message::Text("safe".into())
            } else {
                Message::Binary(b"sa".to_vec().into())
            };
            let _ = socket.send(message).await;
            if scenario != "interrupted" {
                let _ = socket.close(None).await;
            }
        });
        let error = receive(&descriptor, limits(), &CancellationToken::new())
            .await
            .unwrap_err();
        assert_eq!(
            error.code,
            if scenario == "interrupted" {
                ErrorCode::PluginCrashed
            } else {
                ErrorCode::InvalidRequest
            } as i32
        );
        server.await.unwrap();
    }
}

#[tokio::test]
#[ignore = "real loopback: GitHub only"]
async fn dropping_the_operation_owner_aborts_its_offer() {
    let pending = offer(vec![7], "application/octet-stream", limits())
        .await
        .unwrap();
    let endpoint = address(pending.descriptor());
    let dropped_at = std::time::Instant::now();
    drop(pending);
    // First observe actual kernel port ownership, without making a connection
    // against a listener whose task destruction has merely been scheduled.
    // A closed-port TCP probe can itself spend a platform-specific retry delay.
    timeout(limits().timeout, async {
        loop {
            match std::net::TcpListener::bind(endpoint) {
                Ok(rebound) => {
                    drop(rebound);
                    break;
                }
                Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
                Err(error) => panic!("cannot independently observe released port: {error}"),
            }
        }
    })
    .await
    .expect("dropped offer must release its actual kernel port");
    println!(
        "dropped owner: kernel port reusable after {:?}",
        dropped_at.elapsed()
    );
    let probed_at = std::time::Instant::now();
    let refused = timeout(limits().timeout, TcpStream::connect(endpoint))
        .await
        .expect("closed-port probe must complete within the transfer budget");
    assert!(
        refused.is_err(),
        "dropped offer must not accept another connection"
    );
    println!(
        "dropped owner: independent closed-port probe refused after {:?}",
        probed_at.elapsed()
    );
}
