//! Real loopback HTTP/WS, filesystem and PTY tests; no Tauri or display fixture.
use super::*;
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use futures::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream,
    tungstenite::{Message, client::IntoClientRequest},
};
type Ws = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;
const ORIGIN: &str = "https://mobile.example";
pub(super) struct Fixture {
    _dir: tempfile::TempDir,
    pub(super) state: Arc<AppState>,
    endpoint: String,
    client: reqwest::Client,
}
impl Fixture {
    pub(super) async fn new() -> Self {
        Self::with_config(crate::ai::config::AiConfig::default()).await
    }
    pub(super) async fn with_config(config: crate::ai::config::AiConfig) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let state = Arc::new(headless::initialize_with_config(dir.path(), config).unwrap());
        let endpoint = state
            .mobile
            .start(
                Core::Headless(state.clone()),
                dir.path().to_owned(),
                false,
                0,
            )
            .await
            .unwrap();
        Self {
            _dir: dir,
            state,
            endpoint,
            client: reqwest::Client::builder().no_proxy().build().unwrap(),
        }
    }
    async fn pair(&self) -> (String, String) {
        let code = self.state.mobile.auth.lock().unwrap().pairing_code();
        let value: Value = self
            .client
            .post(format!("{}/api/v1/pair", self.endpoint))
            .header("Origin", ORIGIN)
            .json(&json!({"endpoint_label":"phone","pairing_code":code}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        (
            value["device_id"].as_str().unwrap().into(),
            value["token"].as_str().unwrap().into(),
        )
    }
    async fn ticket(&self, token: &str) -> String {
        let value: Value = self
            .client
            .post(format!("{}/api/v1/ws-ticket", self.endpoint))
            .header("Origin", ORIGIN)
            .bearer_auth(token)
            .json(&json!({}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        value["ticket"].as_str().unwrap().into()
    }
    async fn ws(&self, token: &str, path: &str) -> Ws {
        let ticket = self.ticket(token).await;
        let mut request = format!(
            "{}/api/v1{path}?ticket={ticket}",
            self.endpoint.replace("http:", "ws:")
        )
        .into_client_request()
        .unwrap();
        request
            .headers_mut()
            .insert("Origin", ORIGIN.parse().unwrap());
        tokio_tungstenite::connect_async(request).await.unwrap().0
    }
    async fn get(&self, token: &str, path: &str) -> Value {
        self.client
            .get(format!("{}/api/v1{path}", self.endpoint))
            .header("Origin", ORIGIN)
            .bearer_auth(token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap()
    }
    pub(super) async fn finish(self) {
        self.state.mobile.stop().await;
    }
}
async fn frame(ws: &mut Ws, kind: &str) -> Value {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let message = ws.next().await.expect("WS closed").unwrap();
            if let Message::Text(text) = message {
                let v: Value = serde_json::from_str(&text).unwrap();
                if v["type"] == kind {
                    return v;
                }
            }
        }
    })
    .await
    .expect("Expected WS frame")
}
async fn send(ws: &mut Ws, value: Value) {
    ws.send(Message::Text(value.to_string().into()))
        .await
        .unwrap();
}

#[tokio::test]
async fn http_security_cors_revocation_and_listener_shutdown() {
    let f = Fixture::new().await;
    let health = f
        .client
        .get(format!("{}/api/v1/health", f.endpoint))
        .header("Origin", ORIGIN)
        .send()
        .await
        .unwrap();
    assert_eq!(health.headers()["access-control-allow-origin"], ORIGIN);
    assert_eq!(
        health.json::<Value>().await.unwrap()["run_mode"],
        "headless"
    );
    let unauth = f
        .client
        .get(format!("{}/api/v1/sessions", f.endpoint))
        .send()
        .await
        .unwrap();
    assert_eq!(unauth.status(), 401);
    let (device, token) = f.pair().await;
    let response = f
        .client
        .request(
            reqwest::Method::OPTIONS,
            format!("{}/api/v1/sessions", f.endpoint),
        )
        .header("Origin", ORIGIN)
        .header(
            "Access-Control-Request-Headers",
            "authorization,content-type",
        )
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 204);
    assert_eq!(response.headers()["access-control-allow-origin"], ORIGIN);
    assert!(
        response
            .headers()
            .get("access-control-allow-credentials")
            .is_none()
    );
    let response = f
        .client
        .get(format!("{}/api/v1/sessions", f.endpoint))
        .header("Origin", "https://evil.example")
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 403);
    assert!(
        response
            .headers()
            .get("access-control-allow-origin")
            .is_none()
    );
    let mut ws = f.ws(&token, "/events").await;
    assert_eq!(frame(&mut ws, "hello").await["run_mode"], "headless");
    f.state
        .mobile
        .events
        .publish(json!({"type":"task_status","task_id":"thread:test","status":"running"}));
    assert_eq!(
        frame(&mut ws, "task_status").await["task_id"],
        "thread:test"
    );
    f.state.mobile.auth.lock().unwrap().revoke(&device).unwrap();
    f.state.mobile.devices_changed.notify_waiters();
    let close = tokio::time::timeout(std::time::Duration::from_secs(2), ws.next())
        .await
        .unwrap();
    assert!(close.is_none() || close.unwrap().is_ok_and(|m| matches!(m, Message::Close(_))));
    assert_eq!(f.get(&token, "/sessions").await["error"], "origin_denied");
    assert_eq!(
        f.client
            .get(format!("{}/api/v1/sessions", f.endpoint))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    let endpoint = f.endpoint.clone();
    let client = f.client.clone();
    f.finish().await;
    assert!(
        client
            .get(format!("{endpoint}/api/v1/health"))
            .send()
            .await
            .is_err()
    );
}

#[tokio::test]
async fn two_viewers_share_real_pty_with_readonly_resize_control_and_replay() {
    use crate::terminal::{ActiveTerminal, pty};
    use std::{io::Read, sync::Mutex};
    let f = Fixture::new().await;
    let program = if cfg!(windows) { "cmd.exe" } else { "/bin/sh" };
    let args = if cfg!(windows) {
        vec!["/Q".into()]
    } else {
        vec![]
    };
    let (pty, mut reader) = pty::create_command_pty(80, 24, program, &args).unwrap();
    let id = "opaque-running-key";
    f.state.mobile.broker.register(id);
    f.state.terminal.terminals.write().await.insert(
        id.into(),
        ActiveTerminal::Local {
            _route: crate::database::forward::ForwardGuard(None),
            writer: Mutex::new(pty.writer),
            master: Mutex::new(pty.master),
            child: Mutex::new(pty.child),
        },
    );
    let broker = f.state.mobile.broker.clone();
    let read = std::thread::spawn(move || {
        let mut bytes = [0; 4096];
        while let Ok(n) = reader.read(&mut bytes) {
            if n == 0 {
                break;
            }
            broker.output(id, &bytes[..n]);
        }
        broker.exit(id);
    });
    let (d1, t1) = f.pair().await;
    let (_, t2) = f.pair().await;
    let sessions = f.get(&t1, "/sessions").await;
    assert!(
        sessions["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["id"] == "term:opaque-running-key")
    );
    let mut a = f
        .ws(&t1, "/terminals/term%3Aopaque-running-key/stream")
        .await;
    let mut b = f
        .ws(&t2, "/terminals/term%3Aopaque-running-key/stream")
        .await;
    frame(&mut a, "replay").await;
    frame(&mut b, "replay").await;
    send(&mut a, json!({"type":"resize","cols":200,"rows":50})).await;
    assert_eq!(frame(&mut a, "error").await["code"], "not_holder");
    send(&mut a, json!({"type":"take-control"})).await;
    loop {
        if frame(&mut a, "control").await["holder"] == format!("mobile:{d1}") {
            break;
        }
    }
    send(
        &mut a,
        json!({"type":"input","data_b64":B64.encode(b"echo QA_MOBILE_REAL_PTY\r")}),
    )
    .await;
    for ws in [&mut a, &mut b] {
        let mut all = String::new();
        loop {
            let output = frame(ws, "output").await;
            all.push_str(&String::from_utf8_lossy(
                &B64.decode(output["data_b64"].as_str().unwrap()).unwrap(),
            ));
            if all.contains("QA_MOBILE_REAL_PTY") {
                break;
            }
        }
    }
    send(&mut a, json!({"type":"resize","cols":999,"rows":999})).await;
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            if f.state.mobile.broker.terminals.lock().unwrap()[id].size == Some((300, 100)) {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let gate = f.state.mobile.broker.gate(id).unwrap();
    {
        let _guard = gate.lock().await;
        f.state.mobile.broker.desktop(id, Some((80, 24)));
        crate::terminal::resize_terminal_inner(&f.state, id, 80, 24)
            .await
            .unwrap();
    }
    assert_eq!(
        frame(&mut a, "control-lost").await["reason"],
        "desktop_resize"
    );
    send(&mut a, json!({"type":"input","data_b64":B64.encode(b"no")})).await;
    assert_eq!(frame(&mut a, "error").await["code"], "not_holder");
    send(&mut a, json!({"type":"resume","after_seq":0})).await;
    assert_eq!(frame(&mut a, "output").await["type"], "output");
    let _ = a.close(None).await;
    let _ = b.close(None).await;
    crate::terminal::send_terminal_signal_inner(&f.state, id, "SIGKILL")
        .await
        .unwrap();
    let _ = tokio::task::spawn_blocking(move || read.join()).await;
    assert!(!f.state.mobile.broker.terminals.lock().unwrap()[id].running);
    f.finish().await;
}
