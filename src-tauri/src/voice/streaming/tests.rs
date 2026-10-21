use super::cloud::run_aliyun;
use super::cloud::run_deepgram;
use super::events::TranscriptSink;
use super::local::forward_until_idle;
use super::transport::connect_ws;
use super::transport::ws_request;
use crate::proxy::ResolvedProxy;
use futures::SinkExt;
use futures::StreamExt;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;

use std::time::Duration;
use tokio::net::TcpListener;

#[tokio::test]
async fn existing_providers_drain_finals_and_reject_early_disconnects() {
    for aliyun in [false, true] {
        for early_close in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let endpoint = format!("ws://{}", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                let (socket, _) = listener.accept().await.unwrap();
                let mut ws = tokio_tungstenite::accept_async(socket).await.unwrap();
                if aliyun {
                    let start = ws.next().await.unwrap().unwrap().into_text().unwrap();
                    let start: serde_json::Value = serde_json::from_str(&start).unwrap();
                    assert_eq!(start["header"]["action"], "run-task");
                    assert_eq!(
                        start["payload"]["parameters"]["vocabulary_id"],
                        "fixture-vocabulary"
                    );
                    ws.send(tungstenite::Message::Text(
                        r#"{"header":{"event":"task-started"}}"#.into(),
                    ))
                    .await
                    .unwrap();
                }
                assert!(ws.next().await.unwrap().unwrap().is_binary());
                if early_close {
                    ws.close(None).await.unwrap();
                    return;
                }
                let finish = ws.next().await.unwrap().unwrap().into_text().unwrap();
                assert!(finish.contains(if aliyun { "finish-task" } else { "CloseStream" }));
                tokio::time::sleep(Duration::from_millis(400)).await;
                let final_message = if aliyun {
                    r#"{"payload":{"output":{"sentence":{"text":"final words","sentence_end":true}}}}"#
                } else {
                    r#"{"type":"Results","is_final":true,"channel":{"alternatives":[{"transcript":"final words"}]}}"#
                };
                ws.send(tungstenite::Message::Text(final_message.into()))
                    .await
                    .unwrap();
                let done = if aliyun {
                    r#"{"header":{"event":"task-finished"}}"#
                } else {
                    r#"{"type":"Metadata"}"#
                };
                ws.send(tungstenite::Message::Text(done.into()))
                    .await
                    .unwrap();
            });
            let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
            let received = events.clone();
            let sink: TranscriptSink =
                std::sync::Arc::new(move |event| received.lock().unwrap().push(event));
            let (tx, mut rx) = tokio::sync::mpsc::channel(2);
            tx.send(vec![0.2; 1600]).await.unwrap();
            drop(tx);
            let run = async {
                if aliyun {
                    run_aliyun(
                        sink,
                        "fixture".into(),
                        &mut rx,
                        "paraformer-realtime-v2",
                        &endpoint,
                        "key",
                        "zh",
                        std::time::Instant::now(),
                        None,
                        "fixture-vocabulary",
                    )
                    .await
                } else {
                    run_deepgram(
                        sink,
                        "fixture".into(),
                        &mut rx,
                        "nova-3",
                        &endpoint,
                        "key",
                        "en",
                        std::time::Instant::now(),
                        None,
                        &["src/main.rs".into()],
                    )
                    .await
                }
            };
            let result = tokio::time::timeout(Duration::from_secs(3), run)
                .await
                .unwrap();
            server.await.unwrap();
            if early_close {
                assert!(result.is_err());
            } else {
                result.unwrap();
                let events = events.lock().unwrap();
                assert_eq!(events.len(), 1);
                assert!(events[0].final_text);
                assert_eq!(events[0].text, "final words");
            }
        }
    }
}

#[tokio::test]
async fn online_silence_closes_input_without_waiting_for_capture_owner() {
    let (tx, rx) = tokio::sync::mpsc::channel(2);
    let (target, mut received) = tokio::sync::mpsc::channel(2);
    tx.send(vec![0.0; 5 * 16000]).await.unwrap();
    tokio::time::timeout(Duration::from_secs(1), forward_until_idle(rx, target))
        .await
        .unwrap();
    assert_eq!(received.recv().await.unwrap().len(), 80000);
    assert!(received.recv().await.is_none());
    assert!(tx.send(vec![0.2; 1600]).await.is_err());
}

async fn handshake_through(route: &str) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let route = route.to_owned();
    let proxy = (!route.is_empty()).then(|| ResolvedProxy {
        host: "127.0.0.1".into(),
        port,
        kind: route.clone(),
        username: String::new(),
        password: String::new(),
    });
    // A deliberately unresolvable destination proves the selected proxy
    // handles origin DNS. The fixture terminates the tunnel as a WS server.
    let endpoint = if proxy.is_some() {
        "ws://asr-fixture.invalid:8080/listen?language=zh".to_owned()
    } else {
        format!("ws://127.0.0.1:{port}/listen?language=zh")
    };
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        match route.as_str() {
            "http" => {
                let mut header = Vec::new();
                while !header.ends_with(b"\r\n\r\n") {
                    assert!(header.len() < 4096);
                    header.push(stream.read_u8().await.unwrap());
                }
                assert!(
                    String::from_utf8(header)
                        .unwrap()
                        .starts_with("CONNECT asr-fixture.invalid:8080 HTTP/1.1\r\n")
                );
                stream
                    .write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
                    .await
                    .unwrap();
            }
            "socks5" => {
                let mut greeting = [0; 3];
                stream.read_exact(&mut greeting).await.unwrap();
                assert_eq!(greeting, [5, 1, 0]);
                stream.write_all(&[5, 0]).await.unwrap();
                let mut header = [0; 5];
                stream.read_exact(&mut header).await.unwrap();
                assert_eq!(&header[..4], &[5, 1, 0, 3]);
                let mut domain = vec![0; header[4] as usize];
                stream.read_exact(&mut domain).await.unwrap();
                assert_eq!(domain, b"asr-fixture.invalid");
                assert_eq!(stream.read_u16().await.unwrap(), 8080);
                stream
                    .write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 0])
                    .await
                    .unwrap();
            }
            "" => {}
            _ => panic!("unknown fixture route"),
        }
        let mut ws = tokio_tungstenite::accept_hdr_async(
            stream,
            |request: &tungstenite::handshake::server::Request, response| {
                assert_eq!(request.uri().path(), "/listen");
                assert_eq!(request.uri().query(), Some("language=zh"));
                assert_eq!(request.headers()["Authorization"], "Token fixture-key");
                Ok(response)
            },
        )
        .await
        .unwrap();
        let audio = ws.next().await.unwrap().unwrap();
        assert_eq!(audio.into_data().as_ref(), &[0u8, 1, 2, 3]);
        ws.send(tungstenite::Message::Text("fixture transcript".into()))
            .await
            .unwrap();
    });
    let exchange = async {
        let request = ws_request(&endpoint, &[("Authorization", "Token fixture-key")]).unwrap();
        let (mut client, response) = connect_ws(request, proxy.as_ref()).await.unwrap();
        assert_eq!(response.status(), 101);
        client
            .send(tungstenite::Message::Binary(vec![0, 1, 2, 3].into()))
            .await
            .unwrap();
        assert_eq!(
            client.next().await.unwrap().unwrap().into_text().unwrap(),
            "fixture transcript"
        );
        server.await.unwrap();
    };
    tokio::time::timeout(Duration::from_secs(5), exchange)
        .await
        .unwrap();
}

#[tokio::test]
async fn online_handshake_direct() {
    handshake_through("").await;
}

#[tokio::test]
async fn online_handshake_http_proxy() {
    handshake_through("http").await;
}

#[tokio::test]
async fn online_handshake_socks5_proxy() {
    handshake_through("socks5").await;
}

#[test]
fn request_rejects_invalid_endpoint_and_header_without_exposing_credentials() {
    assert!(ws_request("https://asr.example.test/listen", &[]).is_err());
    assert!(ws_request("ws:///", &[]).is_err());
    let error = ws_request(
        "wss://asr.example.test/listen",
        &[("Authorization", "secret\r\ninjected")],
    )
    .unwrap_err();
    assert!(error.starts_with("ASR_WS_REQUEST:"));
    assert!(!error.contains("secret"));
}
