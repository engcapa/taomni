//! Native loopback platform fixture: real HTTP auth/send and protobuf WebSocket.
use super::{
    actions,
    network::Network,
    protocol::Frame,
    tests::{config, event, thread},
    *,
};
use axum::{
    Json, Router,
    extract::{
        State, WebSocketUpgrade,
        ws::{Message as AxumMessage, WebSocket},
    },
    response::IntoResponse,
    routing::{get, post},
};
use futures::{SinkExt, StreamExt};
use prost::Message;
use serde_json::{Value, json};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::broadcast;

#[derive(Clone)]
struct Platform {
    url: String,
    events: broadcast::Sender<Value>,
    sent: Arc<Mutex<Vec<Value>>>,
    connections: Arc<AtomicUsize>,
    pings: Arc<AtomicUsize>,
    tokens: Arc<AtomicUsize>,
    acks: Arc<AtomicUsize>,
    bad_acks: Arc<AtomicUsize>,
    attempts: Arc<Mutex<Vec<Value>>>,
}
async fn endpoint(State(p): State<Platform>, Json(body): Json<Value>) -> Json<Value> {
    assert_eq!(body, json!({"AppID":"cli_qa","AppSecret":"fixture-secret"}));
    Json(
        json!({"code":0,"data":{"URL":format!("{}/socket?service_id=7",p.url.replacen("http","ws",1)),"ClientConfig":{"PingInterval":1}}}),
    )
}
async fn token(State(p): State<Platform>, Json(body): Json<Value>) -> Json<Value> {
    assert_eq!(
        body,
        json!({"app_id":"cli_qa","app_secret":"fixture-secret"})
    );
    p.tokens.fetch_add(1, Ordering::SeqCst);
    Json(json!({"code":0,"tenant_access_token":"fixture-token","expire":7200}))
}
async fn send(
    State(p): State<Platform>,
    headers: axum::http::HeaderMap,
    Json(body): Json<Value>,
) -> axum::response::Response {
    assert_eq!(headers["authorization"], "Bearer fixture-token");
    assert_eq!(body["receive_id"], "oc_allowed");
    assert!(body["uuid"].as_str().unwrap().len() <= 50);
    let first = {
        let mut attempts = p.attempts.lock().unwrap();
        attempts.push(body.clone());
        attempts.len() == 1
    };
    if first {
        return axum::http::StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    p.sent.lock().unwrap().push(body);
    Json(json!({"code":0,"data":{"message_id":"om_fixture"}})).into_response()
}
async fn websocket(State(p): State<Platform>, upgrade: WebSocketUpgrade) -> impl IntoResponse {
    let events = p.events.subscribe();
    upgrade.on_upgrade(move |socket| stream(socket, p, events))
}
async fn stream(mut socket: WebSocket, p: Platform, mut events: broadcast::Receiver<Value>) {
    p.connections.fetch_add(1, Ordering::SeqCst);
    loop {
        tokio::select! {
            result=events.recv()=> {
                let Ok(value)=result else { break; };
                if value["close"]==true { let _=socket.close().await;break; }
                let payload = if value["invalid_json"] == true { b"not JSON".to_vec() } else { value.to_string().into_bytes() };
                let frame=Frame {service:7,method:1,headers:vec![protocol::Header {key:"type".into(),value:"event".into()}],payload:Some(payload),..Default::default()};
                if socket.send(AxumMessage::Binary(frame.encode_to_vec().into())).await.is_err() {break;}
            }
            result=socket.next()=> {
                let Some(Ok(AxumMessage::Binary(bytes)))=result else {break;};
                let frame=Frame::decode(bytes).unwrap();
                if frame.header("type")=="ping" {
                    p.pings.fetch_add(1,Ordering::SeqCst);
                    let mut pong=frame;pong.headers[0].value="pong".into();pong.payload=Some(json!({"PingInterval":1}).to_string().into_bytes());
                    if socket.send(AxumMessage::Binary(pong.encode_to_vec().into())).await.is_err() {break;}
                } else {
                    let code = serde_json::from_slice::<Value>(frame.payload.as_ref().unwrap()).unwrap()["code"].as_u64().unwrap();
                    if code == 500 { p.bad_acks.fetch_add(1, Ordering::SeqCst); }
                    else { assert_eq!(code, 200); p.acks.fetch_add(1, Ordering::SeqCst); }
                }
            }
        }
    }
}
async fn wait(mut predicate: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(12), async {
        while !predicate() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn real_long_connection_routes_once_notifies_confirms_and_reconnects() {
    let requests = Arc::new(AtomicUsize::new(0));
    let count = requests.clone();
    let provider = Router::new().route("/v1/chat/completions", post(move || {
        let count = count.clone();
        async move {
            if count.fetch_add(1, Ordering::SeqCst) == 0 {
                std::future::pending::<()>().await;
            }
            ([("content-type", "text/event-stream")],
                "data: {\"choices\":[{\"delta\":{\"content\":\"FEISHU_REAL_TURN\"}}]}\n\ndata: [DONE]\n\n")
        }
    }));
    let provider_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut ai = crate::ai::config::AiConfig::default();
    let local = ai.llm.providers.get_mut("local").unwrap();
    local.base_url = format!("http://{}/v1", provider_listener.local_addr().unwrap());
    local.proxy_mode = "none".into();
    ai.llm.active = "local".into();
    let provider_task = tokio::spawn(async move {
        axum::serve(provider_listener, provider).await.unwrap();
    });
    let f = crate::mobile::service_tests::Fixture::with_config(ai).await;
    thread(&f.state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let p = Platform {
        url: format!("http://{}", listener.local_addr().unwrap()),
        events: broadcast::channel(32).0,
        sent: Arc::default(),
        connections: Arc::default(),
        pings: Arc::default(),
        tokens: Arc::default(),
        acks: Arc::default(),
        bad_acks: Arc::default(),
        attempts: Arc::default(),
    };
    let router = Router::new()
        .route("/callback/ws/endpoint", post(endpoint))
        .route(
            "/open-apis/auth/v3/tenant_access_token/internal",
            post(token),
        )
        .route("/open-apis/im/v1/messages", post(send))
        .route("/socket", get(websocket))
        .with_state(p.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let mut net = Network::new(config(), Zeroizing::new("fixture-secret".into()), None).unwrap();
    net.base = p.url.clone();
    let core = Core::Headless(f.state.clone());
    let runtime = &f.state.mobile.im;
    runtime.start_network(core.clone(), net).await.unwrap();
    wait(|| p.pings.load(Ordering::SeqCst) > 0).await;
    p.events.send(event("om_list", "列表")).unwrap();
    wait(|| {
        p.sent.lock().unwrap().iter().any(|m| {
            m["content"]
                .as_str()
                .unwrap_or("")
                .contains("thread:feishu-task")
        })
    })
    .await;
    let list_card: Value = {
        let sent = p.sent.lock().unwrap();
        let message = sent
            .iter()
            .find(|m| m["msg_type"] == "interactive")
            .unwrap();
        serde_json::from_str(message["content"].as_str().unwrap()).unwrap()
    };
    assert!(list_card.to_string().contains("1. feishu-t · Feishu QA"));
    // Click the value actually emitted by the list card over real protobuf WS.
    let show = json!({"header":{"app_id":"cli_qa","event_type":"card.action.trigger","event_id":"show-card",
        "create_time":chrono::Utc::now().timestamp_millis().to_string()},"event":{
        "operator":{"open_id":"ou_allowed"},"context":{"open_chat_id":"oc_allowed"},
        "action":{"value":list_card["elements"][1]["actions"][0]["value"]}}});
    p.events.send(show.clone()).unwrap();
    wait(|| {
        p.sent.lock().unwrap().iter().any(|m| {
            m["msg_type"] == "interactive"
                && m["content"].as_str().unwrap_or("").contains("最近结果")
        })
    })
    .await;
    p.events.send(show).unwrap();
    wait(|| runtime.snapshot().duplicates == 1).await;
    // A duplicate platform event ID is not sufficient: message_id is canonical.
    let mut duplicate = event("om_list", "/taomni list");
    duplicate["header"]["event_id"] = json!("another-event");
    p.events.send(duplicate).unwrap();
    wait(|| runtime.snapshot().duplicates == 2).await;
    p.events.send(json!({"invalid_json":true})).unwrap();
    wait(|| p.bad_acks.load(Ordering::SeqCst) == 1).await;
    assert_eq!(
        p.connections.load(Ordering::SeqCst),
        1,
        "poison messages must not reconnect the socket"
    );
    let mut denied = event("om_bad", "/taomni stop thread:feishu-task");
    denied["event"]["sender"]["sender_id"]["open_id"] = json!("ou_stranger");
    p.events.send(denied).unwrap();
    wait(|| runtime.snapshot().rejected == 2).await;
    f.state.mobile.broker.register("blocked");
    p.events
        .send(event("om_pty", "/taomni send term:blocked text"))
        .unwrap();
    wait(|| {
        p.sent.lock().unwrap().iter().any(|m| {
            m["content"]
                .as_str()
                .unwrap_or("")
                .contains("agent_only_no_pty_input")
        })
    })
    .await;
    p.events
        .send(event(
            "om_send1",
            "继续\u{3000}feis\u{3000}First Feishu turn",
        ))
        .unwrap();
    wait(|| requests.load(Ordering::SeqCst) == 1).await;
    p.events
        .send(event(
            "om_overlap",
            "/taomni send thread:feishu-task Overlap",
        ))
        .unwrap();
    wait(|| {
        p.sent.lock().unwrap().iter().any(|m| {
            m["content"]
                .as_str()
                .unwrap_or("")
                .contains("turn_in_progress")
        })
    })
    .await;
    let stop = json!({"header":{"app_id":"cli_qa","event_type":"card.action.trigger","event_id":"stop-card",
        "create_time":chrono::Utc::now().timestamp_millis().to_string()},"event":{
        "operator":{"open_id":"ou_allowed"},"context":{"open_chat_id":"oc_allowed"},
        "action":{"value":{"action":"stop","task_id":"thread:feishu-task"}}}});
    p.events.send(stop).unwrap();
    wait(|| {
        !f.state
            .mobile
            .pending_turns
            .lock()
            .unwrap()
            .contains_key("feishu-task")
    })
    .await;
    p.events
        .send(event(
            "om_send2",
            "/taomni send thread:feishu-task Second Feishu turn",
        ))
        .unwrap();
    wait(|| {
        requests.load(Ordering::SeqCst) == 2
            && !f
                .state
                .mobile
                .pending_turns
                .lock()
                .unwrap()
                .contains_key("feishu-task")
    })
    .await;
    let messages =
        crate::chat::store::list_messages(&f.state.db.lock().unwrap(), "feishu-task").unwrap();
    assert_eq!(messages.iter().filter(|m| m.role == "user").count(), 2);
    assert!(
        messages
            .iter()
            .any(|m| m.content.contains("FEISHU_REAL_TURN"))
    );
    assert!(
        actions::execute(&core, &config(), "show thread:feishu-task")
            .await
            .text()
            .contains("FEISHU_REAL_TURN")
    );
    let (tx, rx) = tokio::sync::oneshot::channel();
    f.state
        .agent
        .cc_pending_permissions
        .lock()
        .unwrap()
        .insert("confirmation".into(), tx);
    f.state.mobile.confirmations.lock().unwrap().insert(
        "confirmation".into(),
        json!({"id":"confirmation","thread_id":"feishu-task","tool":"write_file","supported":true}),
    );
    f.state.mobile.events.publish(json!({"type":"task_status","task_id":"thread:feishu-task","status":"awaiting_confirmation","summary":"write_file"}));
    wait(|| {
        p.sent.lock().unwrap().iter().any(|m| {
            m["msg_type"] == "interactive"
                && m["content"]
                    .as_str()
                    .unwrap_or("")
                    .contains("Taomni 等待确认")
        })
    })
    .await;
    let card = json!({"header":{"app_id":"cli_qa","event_type":"card.action.trigger","event_id":"card-id","create_time":chrono::Utc::now().timestamp_micros().to_string()},
        "event":{"operator":{"open_id":"ou_allowed"},"context":{"open_chat_id":"oc_allowed"},"action":{"value":{"task_id":"thread:feishu-task","confirmation_id":"confirmation","decision":"approve"}}}});
    p.events.send(card).unwrap();
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(10), rx)
            .await
            .unwrap()
            .unwrap(),
        crate::state::CcPermissionDecision::Allow
    ));
    wait(|| p.acks.load(Ordering::SeqCst) >= 9).await;
    p.events.send(json!({"close":true})).unwrap();
    wait(|| p.connections.load(Ordering::SeqCst) >= 2 && p.pings.load(Ordering::SeqCst) >= 2).await;
    p.events.send(event("om_list", "/taomni list")).unwrap();
    wait(|| runtime.snapshot().duplicates == 3).await;
    f.state.mobile.events.publish(json!({"type":"task_status","task_id":"thread:feishu-task","status":"idle","summary":"turn_finished"}));
    wait(|| {
        p.sent.lock().unwrap().iter().any(|m| {
            m["content"]
                .as_str()
                .unwrap_or("")
                .contains("turn_finished")
        })
    })
    .await;
    assert_eq!(p.tokens.load(Ordering::SeqCst), 1);
    {
        let attempts = p.attempts.lock().unwrap();
        assert_eq!(
            attempts[0], attempts[1],
            "retry must retain the platform dedup UUID"
        );
    }
    wait(|| p.acks.load(Ordering::SeqCst) >= 10).await;
    runtime.stop().await;
    assert_eq!(runtime.snapshot().state, "stopped");
    assert!(runtime.idle().await);
    assert!(
        p.sent
            .lock()
            .unwrap()
            .iter()
            .any(|m| m["content"].as_str().unwrap_or("").contains("已停止"))
    );
    assert_eq!(
        f.state
            .db
            .lock()
            .unwrap()
            .query_row("SELECT count(*) FROM mobile_feishu_events", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        8
    );
    provider_task.abort();
    server.abort();
    f.finish().await;
}
#[tokio::test]
async fn selected_proxy_failure_never_falls_back_and_none_resolves_direct() {
    let f = crate::mobile::service_tests::Fixture::new().await;
    let mut c = config();
    c.proxy_mode = "custom".into();
    c.custom_proxy = crate::proxy::AppProxyConfig {
        enabled: true,
        mode: "manual".into(),
        kind: "http".into(),
        host: "127.0.0.1".into(),
        port: 1,
        ..Default::default()
    };
    let proxy = c.resolve_proxy(&f.state).unwrap().unwrap();
    assert_eq!(proxy.port, 1);
    let n = Network::new(c.clone(), Zeroizing::new("secret".into()), Some(proxy)).unwrap();
    assert!(n.connect().await.unwrap_err().contains("network_failed"));
    c.proxy_mode = "none".into();
    assert!(c.resolve_proxy(&f.state).unwrap().is_none());
    c.proxy_mode = "custom".into();
    c.custom_proxy.host.clear();
    assert!(c.resolve_proxy(&f.state).is_err());
    f.finish().await;
}

#[tokio::test]
async fn feishu_image_upload_uses_multipart_and_card_follow_updates_use_http_patch() {
    use axum::{body::Bytes, extract::Path, routing::patch};

    #[derive(Clone, Default)]
    struct UploadMock {
        uploads: Arc<Mutex<Vec<Vec<u8>>>>,
        patched: Arc<Mutex<Vec<(String, Value)>>>,
        sent: Arc<Mutex<Vec<Value>>>,
    }

    let mock = UploadMock::default();
    let app = Router::new()
        .route(
            "/open-apis/auth/v3/tenant_access_token/internal",
            post(|| async {
                Json(json!({"code":0,"tenant_access_token":"fixture-token","expire":7200}))
            }),
        )
        .route(
            "/open-apis/im/v1/images",
            post({
                let mock = mock.clone();
                move |headers: axum::http::HeaderMap, body: Bytes| {
                    let mock = mock.clone();
                    async move {
                        assert_eq!(headers["authorization"], "Bearer fixture-token");
                        mock.uploads.lock().unwrap().push(body.to_vec());
                        Json(json!({"code":0,"data":{"image_key":"img_v2_mock_screen"}}))
                    }
                }
            }),
        )
        .route(
            "/open-apis/im/v1/messages",
            post({
                let mock = mock.clone();
                move |headers: axum::http::HeaderMap, Json(body): Json<Value>| {
                    let mock = mock.clone();
                    async move {
                        assert_eq!(headers["authorization"], "Bearer fixture-token");
                        mock.sent.lock().unwrap().push(body);
                        Json(json!({"code":0,"data":{"message_id":"om_card_1"}}))
                    }
                }
            }),
        )
        .route(
            "/open-apis/im/v1/messages/{message_id}",
            patch({
                let mock = mock.clone();
                move |headers: axum::http::HeaderMap,
                      Path(id): Path<String>,
                      Json(body): Json<Value>| {
                    let mock = mock.clone();
                    async move {
                        assert_eq!(headers["authorization"], "Bearer fixture-token");
                        mock.patched.lock().unwrap().push((id, body));
                        Json(json!({"code":0,"data":{}}))
                    }
                }
            }),
        );

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    let mut net = Network::new(config(), Zeroizing::new("fixture-secret".into()), None).unwrap();
    net.base = base;

    let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
    png.extend_from_slice(&[1, 2, 3, 4]);
    let key = net.upload_image(&png, "desktop-screen.png").await.unwrap();
    assert_eq!(key, "img_v2_mock_screen");
    {
        let uploads = mock.uploads.lock().unwrap();
        assert_eq!(uploads.len(), 1);
        assert!(uploads[0].windows(8).any(|w| w == b"\x89PNG\r\n\x1a\n"));
    }

    let card = cards::screen(
        &config(),
        "Primary",
        "display-0",
        1280,
        720,
        Some("已刷新"),
        Some("oc_allowed"),
    );
    let updated_card = cards::with_screen_image_key(card, &key);
    let sent = worker::Outbound::reply(
        "oc_allowed".into(),
        actions::Reply::Screen {
            card: updated_card.clone(),
            png: png.clone(),
            filename: "desktop-screen.png".into(),
        },
        "screen-key-1",
    );
    assert_eq!(sent.image.as_ref().unwrap().1, "desktop-screen.png");

    let msg_id = net
        .send(&sent.chat, sent.kind, &sent.content, &sent.uuid)
        .await
        .unwrap();
    assert_eq!(msg_id, "om_card_1");
    assert!(
        mock.sent.lock().unwrap()[0]["content"]
            .as_str()
            .unwrap()
            .contains("img_v2_mock_screen")
    );

    net.update_card(
        &msg_id,
        &json!({"header":{"title":{"tag":"plain_text","content":"Updated"}}}),
    )
    .await
    .unwrap();
    {
        let patched = mock.patched.lock().unwrap();
        assert_eq!(patched.len(), 1);
        assert_eq!(patched[0].0, "om_card_1");
        assert!(
            patched[0].1["content"]
                .as_str()
                .unwrap()
                .contains("Updated")
        );
    }

    server.abort();
}
