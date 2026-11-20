use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    path::Path,
    process::{Child, Command, Stdio},
    sync::mpsc::{self, Receiver},
    thread,
    time::{Duration, Instant},
};

use futures::StreamExt;
use serde_json::{Value, json};
use taomni_plugin_api::{
    CancelRequest, ErrorCode, HandshakeRequest, RpcMessage, RpcRequest, RpcResponse,
    services::{HOST_PROFILE_ENV, HostProfileContext, ProfileGeneration},
};
use taomni_vnc_engine::ws::forward::ForwardRoute;
use tokio::net::TcpStream;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{Message, client::IntoClientRequest, http::header},
};

const TOKEN: &str = "vnc-host-fixture-token";
const WAIT: Duration = Duration::from_secs(15);

struct Host {
    child: Child,
    replies: Receiver<RpcMessage>,
}

impl Host {
    fn start(profile: &Path) -> Self {
        let context = HostProfileContext {
            owner: "vnc-client".into(),
            generation: ProfileGeneration::parse("a1234567-1234-1234-1234-123456789abc").unwrap(),
        };
        fs::write(
            profile.join(".profile-state.json"),
            json!({"formatVersion":1,"generation":context.generation}).to_string(),
        )
        .unwrap();
        let mut child = Command::new(env!("CARGO_BIN_EXE_taomni-plugin-vnc-client"))
            .env("TAOMNI_PLUGIN_TOKEN", TOKEN)
            .env(
                HOST_PROFILE_ENV,
                json!({"root":profile,"context":context}).to_string(),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let output = child.stdout.take().unwrap();
        let (sender, replies) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                let message = serde_json::from_str(&line.unwrap()).unwrap();
                if sender.send(message).is_err() {
                    break;
                }
            }
        });
        let mut host = Self { child, replies };
        let mut hello = HandshakeRequest::new(
            "taomni-plugin-vnc-client",
            env!("CARGO_PKG_VERSION"),
            TOKEN,
            vec!["vnc/start".into(), "vnc/close".into(), "vnc/test".into()],
            vec![],
        );
        hello.profile = Some(context.clone());
        let handshake = host.call(
            "handshake",
            "plugin/handshake",
            serde_json::to_value(hello).unwrap(),
        );
        assert_eq!(handshake["accepted"], true);
        assert_eq!(handshake["profile"], serde_json::to_value(context).unwrap());
        host
    }

    fn send(&mut self, message: RpcMessage) {
        let input = self.child.stdin.as_mut().unwrap();
        serde_json::to_writer(&mut *input, &message).unwrap();
        input.write_all(b"\n").unwrap();
        input.flush().unwrap();
    }

    fn response(&self, id: &str) -> RpcResponse {
        let RpcMessage::Response(response) = self.replies.recv_timeout(WAIT).unwrap() else {
            panic!("VNC host should respond to {id}");
        };
        assert_eq!(response.id, Some(id.into()));
        response
    }

    fn call(&mut self, id: &str, method: &str, params: Value) -> Value {
        self.send(RpcMessage::Request(RpcRequest::new(
            id,
            method,
            Some(params),
        )));
        let response = self.response(id);
        assert!(response.error.is_none(), "{method}: {:?}", response.error);
        response.result.unwrap()
    }

    fn exit(&mut self) {
        drop(self.child.stdin.take());
        let deadline = Instant::now() + WAIT;
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                assert!(status.success(), "{status}");
                return;
            }
            assert!(Instant::now() < deadline, "VNC host did not exit");
            thread::sleep(Duration::from_millis(10));
        }
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        if matches!(self.child.try_wait(), Ok(None)) {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
    }
}

fn desktop_fixture(relay: bool) -> (u16, thread::JoinHandle<()>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = thread::spawn(move || {
        let (mut peer, _) = listener.accept().unwrap();
        peer.set_read_timeout(Some(WAIT)).unwrap();
        peer.write_all(b"RFB 003.008\n").unwrap();
        let mut banner = [0_u8; 12];
        peer.read_exact(&mut banner).unwrap();
        assert_eq!(&banner, b"RFB 003.008\n");
        peer.write_all(&[1, 1]).unwrap();
        let mut security = [0];
        peer.read_exact(&mut security).unwrap();
        assert_eq!(security, [1]);
        peer.write_all(&[0; 4]).unwrap();
        let mut shared = [0];
        peer.read_exact(&mut shared).unwrap();
        assert_eq!(shared, [1]);
        peer.write_all(&[
            0, 1, 0, 1, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 0, 8, 16, 0, 0, 0,
        ])
        .unwrap();
        peer.write_all(b"\x00\x00\x00\x07fixture").unwrap();
        if !relay {
            match peer.read(&mut [0]) {
                Ok(size) => assert_eq!(size, 0, "a probe must not request framebuffer updates"),
                Err(error) => assert_eq!(error.kind(), std::io::ErrorKind::ConnectionReset),
            }
            return;
        }
        let mut format = [0; 20];
        peer.read_exact(&mut format).unwrap();
        assert_eq!(format[0], 0);
        let mut encodings = [0; 4];
        peer.read_exact(&mut encodings).unwrap();
        assert_eq!(encodings[0], 2);
        let count = usize::from(u16::from_be_bytes([encodings[2], encodings[3]]));
        peer.read_exact(&mut vec![0; count * 4]).unwrap();
        let mut refresh = [0; 10];
        peer.read_exact(&mut refresh).unwrap();
        assert_eq!(&refresh[..2], &[3, 0]);
        // Raw update for the single framebuffer pixel.
        peer.write_all(&[
            0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 42, 42, 42, 0,
        ])
        .unwrap();
        let result = peer.read_to_end(&mut Vec::new());
        if let Err(error) = result {
            assert_eq!(error.kind(), std::io::ErrorKind::ConnectionReset);
        }
    });
    (port, server)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "real sockets and a standalone VNC module process on GitHub"]
async fn relay_host_paints_and_closes_sessions_and_exits_with_live_streams() {
    let temporary = tempfile::tempdir().unwrap();
    let mut host = Host::start(&temporary.path().canonicalize().unwrap());
    for command in ["close", "exit"] {
        let (port, server) = desktop_fixture(true);
        let upstream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let (route, forward) = ForwardRoute::bind(upstream).await.unwrap();
        let params = serde_json::to_value(&route).unwrap();
        let mut invalid = params.clone();
        invalid["token"] = json!("0".repeat(64));
        let invalid: ForwardRoute = serde_json::from_value(invalid).unwrap();
        assert!(
            tokio::time::timeout(WAIT, invalid.connect())
                .await
                .unwrap()
                .is_err()
        );

        let session = host.call(
            command,
            "vnc/start",
            json!({
                "host":"vnc-fixture.example","port":5900,"forward":params,
                "securityPolicy":"allow-none","allowUnencrypted":true
            }),
        );
        let session = &session["Ok"];
        assert!(
            tokio::time::timeout(WAIT, route.connect())
                .await
                .unwrap()
                .is_err()
        );
        let ws_port = session["ws_port"].as_u64().unwrap();
        let mut request = format!("ws://127.0.0.1:{ws_port}/vnc")
            .into_client_request()
            .unwrap();
        request
            .headers_mut()
            .insert(header::ORIGIN, "tauri://localhost".parse().unwrap());
        let protocol = format!("taomni-vnc.{}", session["ws_token"].as_str().unwrap());
        request
            .headers_mut()
            .insert(header::SEC_WEBSOCKET_PROTOCOL, protocol.parse().unwrap());
        let (mut socket, _) = tokio::time::timeout(WAIT, connect_async(request))
            .await
            .unwrap()
            .unwrap();
        tokio::time::timeout(WAIT, async {
            let mut connected = false;
            while let Some(message) = socket.next().await {
                match message.unwrap() {
                    Message::Text(text) => {
                        let value: Value = serde_json::from_str(&text).unwrap();
                        if value["type"] == "connected" {
                            assert_eq!(value["name"], "fixture");
                            assert_eq!(value["width"], 1);
                            assert_eq!(value["height"], 1);
                            connected = true;
                        }
                    }
                    Message::Binary(bytes) if !bytes.is_empty() => {
                        assert!(connected);
                        assert_eq!(&bytes[bytes.len() - 4..], &[42, 42, 42, 255]);
                        return;
                    }
                    _ => {}
                }
            }
            panic!("VNC host closed before delivering a frame");
        })
        .await
        .unwrap();
        if command == "close" {
            let args = json!({"sessionId":session["session_id"]});
            assert_eq!(host.call("close-session", "vnc/close", args.clone()), true);
            assert_eq!(host.call("close-again", "vnc/close", args), false);
        } else {
            host.exit();
        }
        tokio::time::timeout(WAIT, forward).await.unwrap().unwrap();
        server.join().unwrap();
        tokio::time::timeout(WAIT, async {
            while let Some(Ok(message)) = socket.next().await {
                if message.is_close() {
                    break;
                }
            }
        })
        .await
        .unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "real sockets and a standalone VNC module process on GitHub"]
async fn forwarded_probe_authenticates_without_opening_a_frame_relay() {
    let temporary = tempfile::tempdir().unwrap();
    let mut host = Host::start(&temporary.path().canonicalize().unwrap());
    let (port, server) = desktop_fixture(false);
    let upstream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let (route, forward) = ForwardRoute::bind(upstream).await.unwrap();
    assert_eq!(
        host.call(
            "probe",
            "vnc/test",
            json!({"host":"vnc-fixture.example","port":5900,"forward":route,
                   "securityPolicy":"allow-none","allowUnencrypted":true}),
        ),
        json!({"Ok":"Connection successful: 1x1 - fixture"})
    );
    tokio::time::timeout(WAIT, forward).await.unwrap().unwrap();
    server.join().unwrap();
    host.exit();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "real sockets and a standalone VNC module process on GitHub"]
async fn cancellation_during_rfb_negotiation_releases_the_transport() {
    let temporary = tempfile::tempdir().unwrap();
    let mut host = Host::start(&temporary.path().canonicalize().unwrap());
    for (id, forwarded) in [("cancel-direct", false), ("cancel-forwarded", true)] {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let mut params = json!({"host":"127.0.0.1","port":port});
        let forward = if forwarded {
            let upstream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            let (route, task) = ForwardRoute::bind(upstream).await.unwrap();
            params["forward"] = serde_json::to_value(route).unwrap();
            Some(task)
        } else {
            None
        };
        host.send(RpcMessage::Request(RpcRequest::new(
            id,
            "vnc/start",
            Some(params),
        )));
        let (mut peer, _) = tokio::time::timeout(WAIT, listener.accept())
            .await
            .unwrap()
            .unwrap();
        // Complete banner exchange so cancellation exercises an open RFB socket.
        tokio::time::timeout(WAIT, async {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            peer.write_all(b"RFB 003.008\n").await.unwrap();
            let mut banner = [0; 12];
            peer.read_exact(&mut banner).await.unwrap();
            assert_eq!(&banner, b"RFB 003.008\n");
        })
        .await
        .unwrap();
        host.send(RpcMessage::Notification(
            CancelRequest {
                request_id: id.into(),
                reason: None,
            }
            .notification(),
        ));
        let response = host.response(id);
        assert_eq!(
            response.error.unwrap().code,
            ErrorCode::RequestCancelled.as_i32()
        );
        let mut byte = [0];
        let read = tokio::time::timeout(WAIT, tokio::io::AsyncReadExt::read(&mut peer, &mut byte))
            .await
            .unwrap();
        match read {
            Ok(size) => assert_eq!(size, 0),
            Err(error) => assert_eq!(error.kind(), std::io::ErrorKind::ConnectionReset),
        }
        if let Some(task) = forward {
            tokio::time::timeout(WAIT, task).await.unwrap().unwrap();
        }
    }
    host.exit();
}
