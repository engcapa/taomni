use super::*;
use crate::mobile::service_tests::Fixture;
use serde_json::{Value, json};

pub(super) fn config() -> Config {
    Config {
        app_id: "cli_qa".into(),
        bindings: vec![config::Binding {
            open_id: "ou_allowed".into(),
            chat_id: "oc_allowed".into(),
        }],
        proxy_mode: "none".into(),
        ..Default::default()
    }
}
pub(super) fn event(id: &str, text: &str) -> Value {
    json!({"schema":"2.0","header":{"app_id":"cli_qa","event_type":"im.message.receive_v1","event_id":format!("event-{id}"),"create_time":chrono::Utc::now().timestamp_millis().to_string()},
        "event":{"sender":{"sender_type":"user","sender_id":{"open_id":"ou_allowed"}},"message":{"message_id":id,"chat_id":"oc_allowed","message_type":"text","chat_type":"p2p","content":json!({"text":text}).to_string()}}})
}
pub(super) fn thread(state: &crate::state::AppState) {
    let value=serde_json::from_value(json!({"id":"feishu-task","title":"Feishu QA","provider_id":"local","created_at":1,"updated_at":1,"source":"drawer","mode":"chat","linked_session_id":null})).unwrap();
    crate::chat::store::create_thread(&state.db.lock().unwrap(), &value).unwrap();
}
#[test]
fn identity_application_freshness_and_message_id_dedup_keys() {
    let cfg = config();
    let message = event("message-a", "/taomni list");
    let a = actions::authorize(&cfg, &message).unwrap().unwrap();
    assert_eq!(a.command, "list");
    let mut replay = message.clone();
    replay["header"]["event_id"] = json!("different-platform-event");
    assert_eq!(
        a.key,
        actions::authorize(&cfg, &replay).unwrap().unwrap().key
    );
    replay["event"]["sender"]["sender_id"]["open_id"] = json!("ou_stranger");
    assert!(actions::authorize(&cfg, &replay).is_err());
    replay = message.clone();
    replay["event"]["message"]["chat_id"] = json!("oc_elsewhere");
    assert!(actions::authorize(&cfg, &replay).is_err());
    replay = message.clone();
    replay["header"]["app_id"] = json!("cli_other");
    assert!(actions::authorize(&cfg, &replay).is_err());
    replay = message;
    replay["header"]["create_time"] = json!("1");
    assert!(actions::authorize(&cfg, &replay).is_err());
    assert!(
        actions::authorize(&cfg, &event("ignore", "hello"))
            .unwrap()
            .is_none()
    );
}
#[test]
fn fragments_roundtrip_out_of_order_duplicate_and_bounds() {
    use prost::Message;
    use protocol::{Fragments, Frame, Header};
    let mut first = Frame {
        method: 1,
        payload: Some(b"hello ".to_vec()),
        headers: vec![
            Header {
                key: "sum".into(),
                value: "2".into(),
            },
            Header {
                key: "seq".into(),
                value: "0".into(),
            },
            Header {
                key: "message_id".into(),
                value: "msg".into(),
            },
        ],
        ..Default::default()
    };
    let mut last = first.clone();
    last.headers[1].value = "1".into();
    last.payload = Some(b"world".to_vec());
    let mut parts = Fragments::default();
    assert!(parts.accept(&last).unwrap().is_none());
    assert!(parts.accept(&last).unwrap().is_none());
    assert_eq!(parts.accept(&first).unwrap().unwrap(), b"hello world");
    let decoded = Frame::decode(first.encode_to_vec().as_slice()).unwrap();
    assert_eq!(decoded, first);
    first.headers[0].value = "999999".into();
    assert!(parts.accept(&first).is_err());
    first.headers[0].value = "2".into();
    first.headers[1].value = "2".into();
    assert!(parts.accept(&first).is_err());
    first.payload = Some(vec![0; 300 * 1024]);
    assert!(parts.accept(&first).is_err());
    let ack = last.response(true, Some(json!({"toast":{"type":"info","content":"ok"}})));
    let value: Value = serde_json::from_slice(ack.payload.as_ref().unwrap()).unwrap();
    assert_eq!(value["code"], 200);
    assert!(value["data"].as_str().unwrap().len() > 10);
}
#[tokio::test]
async fn real_confirmation_scoping_durable_admission_and_no_pty_commands() {
    let f = Fixture::new().await;
    thread(&f.state);
    let core = Core::Headless(f.state.clone());
    let cfg = config();
    actions::prepare(&core).unwrap();
    assert!(actions::claim(&core, "first").unwrap());
    assert!(!actions::claim(&core, "first").unwrap());
    actions::prepare(&core).unwrap();
    assert!(!actions::claim(&core, "first").unwrap());
    assert!(
        actions::execute(&core, &cfg, "send term:terminal bad")
            .await
            .contains("agent_only_no_pty_input")
    );
    assert!(
        actions::execute(&core, &cfg, "stop term:terminal")
            .await
            .contains("agent_only_no_pty_input")
    );
    assert!(
        actions::execute(&core, &cfg, "list")
            .await
            .contains("thread:feishu-task")
    );
    let (tx, rx) = tokio::sync::oneshot::channel();
    f.state
        .agent
        .cc_pending_permissions
        .lock()
        .unwrap()
        .insert("cid".into(), tx);
    f.state.mobile.confirmations.lock().unwrap().insert(
        "cid".into(),
        json!({"id":"cid","thread_id":"feishu-task","tool":"write_file","supported":true}),
    );
    assert!(
        actions::execute(&core, &cfg, "approve thread:wrong cid")
            .await
            .contains("not_supported")
    );
    assert!(
        actions::execute(&core, &cfg, "approve thread:feishu-task cid")
            .await
            .contains("确认已处理")
    );
    assert!(matches!(
        rx.await.unwrap(),
        crate::state::CcPermissionDecision::Allow
    ));
    assert!(
        actions::execute(&core, &cfg, "approve thread:feishu-task cid")
            .await
            .contains("already_resolved")
    );
    let card = json!({"header":{"app_id":"cli_qa","event_type":"card.action.trigger","event_id":"card-event","create_time":chrono::Utc::now().timestamp_micros().to_string()},
        "event":{"operator":{"open_id":"ou_allowed"},"context":{"open_chat_id":"oc_allowed"},"action":{"value":{"task_id":"thread:feishu-task","confirmation_id":"cid","decision":"reject"}}}});
    assert_eq!(
        actions::authorize(&cfg, &card).unwrap().unwrap().command,
        "reject thread:feishu-task cid"
    );
    let mut millis = card.clone();
    millis["header"]["create_time"] = json!(chrono::Utc::now().timestamp_millis().to_string());
    assert_eq!(
        actions::authorize(&cfg, &millis).unwrap().unwrap().command,
        "reject thread:feishu-task cid"
    );
    let mut stranger = card.clone();
    stranger["event"]["operator"]["open_id"] = json!("ou_stranger");
    assert!(actions::authorize(&cfg, &stranger).is_err());
    let unsupported = actions::confirmation_card(
        &cfg,
        "thread:feishu-task",
        &json!({"id":"desktop", "supported":false}),
    );
    assert!(!unsupported.to_string().contains("button"));
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("notes.txt"), "中".repeat(2000)).unwrap();
    f.state
        .mobile
        .file_roots
        .lock()
        .unwrap()
        .insert("feishu-task".into(), root.path().into());
    let mut private = actions::authorize(
        &cfg,
        &event("file-private", "/taomni file thread:feishu-task notes.txt"),
    )
    .unwrap()
    .unwrap();
    assert!(
        actions::execute_request(&core, &cfg, &private)
            .await
            .contains("file_content_disabled")
    );
    private.private_chat = false;
    assert!(
        actions::execute_request(&core, &cfg, &private)
            .await
            .contains("仅允许已绑定的私聊")
    );
    let long = actions::authorize(
        &cfg,
        &event(
            "too-long",
            &format!("/taomni send thread:feishu-task {}", "中".repeat(3000)),
        ),
    )
    .unwrap()
    .unwrap();
    assert!(
        actions::execute_request(&core, &cfg, &long)
            .await
            .contains("8192 UTF-8")
    );
    let mut linked = cfg.clone();
    linked.allow_file_content = true;
    linked.mobile_endpoint = "https://mobile.example.invalid".into();
    let snapshot = actions::execute(&core, &linked, "file thread:feishu-task notes.txt").await;
    assert!(snapshot.contains("[已截断]"));
    assert!(snapshot.ends_with(&linked.mobile_endpoint));
    assert!(
        actions::execute(&core, &cfg, "file thread:feishu-task ../secret")
            .await
            .contains("操作失败")
    );
    let text = actions::bounded(&"中".repeat(2000));
    assert!(text.ends_with("[已截断]"));
    f.finish().await;
}
#[test]
fn persisted_config_has_only_vault_reference_and_is_strict() {
    let dir = tempfile::tempdir().unwrap();
    let mut c = config();
    c.secret_ref = "vault:test".into();
    c.save(dir.path()).unwrap();
    assert_eq!(Config::load(dir.path()).unwrap().secret_ref, "vault:test");
    c.secret_ref = "plain-secret".into();
    assert!(c.save(dir.path()).is_err());
    c.secret_ref.clear();
    c.proxy_mode = "system".into();
    assert!(c.save(dir.path()).is_err());
    c.proxy_mode = "none".into();
    c.mobile_endpoint = "https://a.invalid/?token=secret".into();
    assert!(c.validate().is_err());
    assert!(Config::default().bindings.is_empty());
    assert_eq!(Config::default().proxy_mode, "app");
}
