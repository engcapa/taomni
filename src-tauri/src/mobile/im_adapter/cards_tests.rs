//! Deep links, list/show/confirmation card JSON and card callback parsing.
use super::{
    Runtime, actions,
    actions::Reply,
    cards::{self, CARD_BYTES},
    notifications::Notifications,
    tests::{config, event, thread},
    worker::Outbound,
};
use crate::mobile::{Core, service_tests::Fixture};
use serde_json::{Value, json};

const LINK: &str = "https://pc.example:8443/#/session/thread%3Aabcd1234-0000";

fn linked() -> super::Config {
    let mut cfg = config();
    cfg.mobile_endpoint = "https://pc.example:8443/".into();
    cfg
}
fn sessions() -> Vec<Value> {
    vec![
        json!({"id":"thread:abcd1234-0000","title":"写测试","status":"running"}),
        json!({"id":"thread:abcd5678-0000","title":"修复","status":"idle"}),
        json!({"id":"thread:wait0000-0000","title":"等确认","status":"awaiting_confirmation"}),
        json!({"id":"term:terminal:11111111","title":"终端","status":"running"}),
    ]
}
fn visible_chars(value: &Value) -> usize {
    match value {
        Value::Object(fields) => fields
            .iter()
            .map(|(key, value)| match key.as_str() {
                "content" => value.as_str().map_or(0, |text| text.chars().count()),
                "value" | "confirm" => 0,
                _ => visible_chars(value),
            })
            .sum(),
        Value::Array(values) => values.iter().map(visible_chars).sum(),
        _ => 0,
    }
}
fn buttons(element: &Value) -> Vec<String> {
    element["actions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b["text"]["content"].as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn deep_links_encode_like_encode_uri_component() {
    assert_eq!(cards::encode_component("thread:abc123"), "thread%3Aabc123");
    assert_eq!(
        cards::encode_component("a b/中?&=#+%"),
        "a%20b%2F%E4%B8%AD%3F%26%3D%23%2B%25"
    );
    assert_eq!(
        cards::encode_component("AZaz09-_.!~*'()"),
        "AZaz09-_.!~*'()"
    );
    let mut cfg = config();
    assert_eq!(cards::session_link(&cfg, "thread:abc123"), None);
    assert_eq!(cards::link_line(&cfg, "thread:abc123"), "");
    for endpoint in ["https://pc.example:8443", "https://pc.example:8443/"] {
        cfg.mobile_endpoint = endpoint.into();
        assert_eq!(
            cards::session_link(&cfg, "thread:abc123").unwrap(),
            "https://pc.example:8443/#/session/thread%3Aabc123"
        );
    }
    cfg.mobile_endpoint = "https://pc.example/mobile/".into();
    assert_eq!(
        cards::link_line(&cfg, "term:terminal:1"),
        "\nMobile Web：https://pc.example/mobile/#/session/term%3Aterminal%3A1"
    );
}

#[test]
fn list_card_numbers_sessions_and_offers_session_buttons() {
    let card = cards::list(&linked(), &sessions(), Some("oc_allowed"));
    assert_eq!(card["header"]["title"]["content"], "Taomni 会话（4）");
    let elements = card["elements"].as_array().unwrap();
    assert_eq!(
        elements[0]["text"]["content"],
        "1. abcd1234 · 写测试 · 运行中"
    );
    assert_eq!(
        elements[1],
        json!({"tag":"action","actions":[
            {"tag":"button","text":{"tag":"plain_text","content":"查看"},"type":"default",
                "value":{"action":"show","task_id":"thread:abcd1234-0000","p2p_chat_id":"oc_allowed"}},
            {"tag":"button","text":{"tag":"plain_text","content":"停止"},"type":"danger",
                "value":{"action":"stop","task_id":"thread:abcd1234-0000"},
                "confirm":{"title":{"tag":"plain_text","content":"停止当前轮次？"},"text":{"tag":"plain_text","content":"thread:abcd1234-0000"}}},
            {"tag":"button","text":{"tag":"plain_text","content":"打开手机页面"},"type":"default","url":LINK}
        ]})
    );
    assert_eq!(elements[2]["text"]["content"], "2. abcd5678 · 修复 · 空闲");
    assert_eq!(buttons(&elements[3]), ["查看", "打开手机页面"]);
    assert_eq!(
        elements[4]["text"]["content"],
        "3. wait0000 · 等确认 · 待确认"
    );
    assert_eq!(buttons(&elements[5]), ["查看", "停止", "打开手机页面"]);
    // Terminals are never stopped from Feishu: stop is Agent-only.
    assert_eq!(
        elements[6]["text"]["content"],
        "4. terminal · 终端 · 运行中"
    );
    assert_eq!(buttons(&elements[7]), ["查看", "打开手机页面"]);
    assert_eq!(elements[8]["tag"], "note");
    assert_eq!(elements.len(), 9);

    // Groups get no content-query buttons; stop stays available as in text.
    let group = cards::list(&config(), &sessions(), None);
    let text = group.to_string();
    assert!(!text.contains("\"show\""));
    assert!(!text.contains("\"url\""));
    assert!(text.contains("\"stop\""));
    assert!(text.contains("仅限私聊"));
    let empty = cards::list(&config(), &[], Some("oc_allowed"));
    assert!(empty.to_string().contains("暂无会话"));
}

#[test]
fn list_card_stays_within_text_and_size_budgets() {
    let mut cfg = config();
    cfg.mobile_endpoint = format!("https://{}.example", "h".repeat(480));
    let many: Vec<Value> = (0..30)
        .map(|n| {
            json!({"id":format!("thread:{n:03}{}", "x".repeat(200)),
                "title":"标".repeat(100),"status":"running"})
        })
        .collect();
    let card = cards::list(&cfg, &many, Some("oc_allowed"));
    assert!(cards::encoded_len(&card) <= CARD_BYTES);
    assert!(visible_chars(&card) <= cards::MESSAGE_CHARS);
    let rows: Vec<&str> = card["elements"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|e| e["text"]["content"].as_str())
        .collect();
    assert!(!rows.is_empty() && rows.len() < 20, "{}", rows.len());
    assert!(rows.iter().map(|r| r.chars().count()).sum::<usize>() <= 1200);
    assert!(card.to_string().contains("[已截断] 仅显示前"));
    // Visible text alone caps rows at the 1200-character body budget.
    let short: Vec<Value> = (0..30)
        .map(|n| json!({"id":format!("thread:{n:08}"),"title":"标".repeat(60),"status":"idle"}))
        .collect();
    let card = cards::list(&config(), &short, None);
    let shown = card["elements"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["tag"] == "div")
        .count();
    assert!(shown < 20, "{shown}");
}

#[test]
fn show_card_bounds_body_and_offers_session_actions() {
    let detail = json!({"id":"thread:abcd1234-0000","title":"写测试","status":"awaiting_confirmation",
        "confirmations":[{"id":"cid","tool":"write_file","supported":true},{"id":"desk","tool":"web","supported":false}]});
    let card = cards::show(
        &linked(),
        &detail,
        "abcd1234",
        &"中".repeat(2000),
        Some("oc_allowed"),
    );
    assert_eq!(card["header"]["title"]["content"], "Taomni 会话 abcd1234");
    let elements = card["elements"].as_array().unwrap();
    let body = elements[0]["text"]["content"].as_str().unwrap();
    assert!(body.ends_with("[已截断]"));
    assert!(body.chars().count() <= 1200 + "\n[已截断]".chars().count());
    assert_eq!(elements[1]["text"]["content"], "待确认：write_file");
    // Approve/reject keep the original confirmation-card value shape.
    assert_eq!(
        elements[2]["actions"][0]["value"],
        json!({"task_id":"thread:abcd1234-0000","confirmation_id":"cid","decision":"approve"})
    );
    assert_eq!(elements[2]["actions"][1]["value"]["decision"], "reject");
    assert_eq!(buttons(&elements[3]), ["查看", "停止", "打开手机页面"]);
    assert_eq!(
        elements[3]["actions"][0]["value"],
        json!({"action":"show","task_id":"thread:abcd1234-0000","p2p_chat_id":"oc_allowed"})
    );
    assert_eq!(
        elements[4]["text"]["content"],
        format!("Mobile Web：{LINK}")
    );
    assert_eq!(elements.len(), 5);
    assert!(cards::encoded_len(&card) <= CARD_BYTES);
    assert!(visible_chars(&card) <= cards::MESSAGE_CHARS);
    let idle = cards::show(
        &config(),
        &json!({"id":"thread:t","status":"idle"}),
        "t",
        "x",
        None,
    );
    assert!(!idle.to_string().contains("button"));
}

#[test]
fn confirmation_cards_link_to_their_session() {
    let cfg = linked();
    let task = "thread:abcd1234-0000";
    let supported = cards::confirmation_card(
        &cfg,
        task,
        &json!({"id":"cid","tool":"write_file","supported":true}),
    );
    let elements = supported["elements"].as_array().unwrap();
    assert_eq!(buttons(&elements[1]), ["同意", "拒绝", "打开手机页面"]);
    assert_eq!(elements[1]["actions"][2]["url"], LINK);
    assert_eq!(
        elements[2]["text"]["content"],
        format!("Mobile Web：{LINK}")
    );
    let desktop = cards::confirmation_card(&cfg, task, &json!({"id":"d","supported":false}));
    let text = desktop.to_string();
    assert!(text.contains("需在桌面确认") && text.contains(LINK));
    assert!(!text.contains("decision"));
}

fn card_event(event_id: &str, value: Value) -> Value {
    json!({"header":{"app_id":"cli_qa","event_type":"card.action.trigger","event_id":event_id,
            "create_time":chrono::Utc::now().timestamp_micros().to_string()},
        "event":{"operator":{"open_id":"ou_allowed"},"context":{"open_chat_id":"oc_allowed"},
            "action":{"tag":"button","value":value}}})
}

#[test]
fn card_callbacks_map_show_and_stop_and_reject_unknown_actions() {
    let cfg = config();
    let value = json!({"action":"show","task_id":"thread:t","p2p_chat_id":"oc_allowed"});
    let show = actions::authorize(&cfg, &card_event("e1", value.clone()))
        .unwrap()
        .unwrap();
    assert_eq!(show.command, "show thread:t");
    assert_eq!(show.chat, "oc_allowed");
    assert!(show.private_chat);
    // Same event id, same dedupe key; another click is a new event.
    let again = actions::authorize(&cfg, &card_event("e1", value.clone()))
        .unwrap()
        .unwrap();
    assert_eq!(show.key, again.key);
    let other = actions::authorize(&cfg, &card_event("e2", value))
        .unwrap()
        .unwrap();
    assert_ne!(show.key, other.key);
    // A forwarded card (other chat) or a card without the binding is not private.
    for value in [
        json!({"action":"show","task_id":"term:x","p2p_chat_id":"oc_other"}),
        json!({"action":"show","task_id":"term:x"}),
    ] {
        let request = actions::authorize(&cfg, &card_event("e3", value))
            .unwrap()
            .unwrap();
        assert_eq!(request.command, "show term:x");
        assert!(!request.private_chat);
    }
    let stop = actions::authorize(
        &cfg,
        &card_event("e4", json!({"action":"stop","task_id":"thread:t"})),
    )
    .unwrap()
    .unwrap();
    assert_eq!(stop.command, "stop thread:t");
    for value in [
        json!({"action":"delete","task_id":"thread:t"}),
        json!({"action":"send","task_id":"thread:t"}),
        json!({"action":"stop","task_id":"term:x"}),
        json!({"action":"show","task_id":"session:x"}),
        json!({"action":"show","task_id":"thread:a b"}),
        json!({"action":"show","task_id":"thread:"}),
        json!({"action":"show","task_id":"term:"}),
        json!({"action":"show","task_id":"thread:a\u{3000}b"}),
        json!({"action":false,"task_id":"thread:t","confirmation_id":"cid","decision":"approve"}),
        json!({"action":"show","task_id":"thread:t "}),
        json!({"action":"show","task_id":format!("thread:{}", "x".repeat(300))}),
        json!({"action":"show"}),
        json!({"task_id":"thread:t"}),
    ] {
        assert!(
            actions::authorize(&cfg, &card_event("bad", value.clone())).is_err(),
            "{value}"
        );
    }
    let stop = json!({"action":"stop","task_id":"thread:t"});
    let mut stranger = card_event("e5", stop.clone());
    stranger["event"]["operator"]["open_id"] = json!("ou_stranger");
    assert!(actions::authorize(&cfg, &stranger).is_err());
    let mut stale = card_event("e6", stop.clone());
    stale["header"]["create_time"] = json!("1");
    assert!(actions::authorize(&cfg, &stale).is_err());
    let mut elsewhere = card_event("e7", stop);
    elsewhere["event"]["context"]["open_chat_id"] = json!("oc_elsewhere");
    assert!(actions::authorize(&cfg, &elsewhere).is_err());
    let legacy = json!({"task_id":"thread:t","confirmation_id":"cid","decision":"approve"});
    assert_eq!(
        actions::authorize(&cfg, &card_event("e8", legacy))
            .unwrap()
            .unwrap()
            .command,
        "approve thread:t cid"
    );
}

#[tokio::test]
async fn private_queries_reply_with_cards_and_other_chats_are_refused() {
    let f = Fixture::new().await;
    thread(&f.state);
    let core = Core::Headless(f.state.clone());
    let cfg = linked();
    let request = actions::authorize(&cfg, &event("p2p-show", "查看 feis"))
        .unwrap()
        .unwrap();
    let Reply::Card(card) = actions::execute_request(&core, &cfg, &request).await else {
        panic!("show must reply with a card");
    };
    let text = card.to_string();
    assert!(text.contains("Feishu QA") && text.contains("查看"));
    assert!(text.contains("/#/session/thread%3Afeishu-task"));
    let outbound = Outbound::reply(request.chat, Reply::Card(card), &request.key);
    assert_eq!(outbound.kind, "interactive");
    assert_eq!(outbound.uuid.len(), 32);

    let list = actions::authorize(&cfg, &event("p2p-list", "列表"))
        .unwrap()
        .unwrap();
    let reply = actions::execute_request(&core, &cfg, &list).await;
    assert!(matches!(reply, Reply::Card(_)));
    assert!(reply.text().contains("1. feishu-t · Feishu QA · 空闲"));

    let forwarded = card_event(
        "forwarded",
        json!({"action":"show","task_id":"thread:feishu-task","p2p_chat_id":"oc_other"}),
    );
    let forwarded = actions::authorize(&cfg, &forwarded).unwrap().unwrap();
    let mut group = event("group-show", "/taomni 查看 feis");
    group["event"]["message"]["chat_type"] = json!("group");
    let group = actions::authorize(&cfg, &group).unwrap().unwrap();
    for request in [forwarded, group] {
        let reply = actions::execute_request(&core, &cfg, &request).await;
        assert!(matches!(reply, Reply::Text(_)));
        assert!(reply.text().contains("仅允许已绑定的私聊"));
    }
    f.finish().await;
}

#[test]
fn oversized_show_and_confirmation_metadata_never_break_the_message_limit() {
    let huge = "x".repeat(CARD_BYTES);
    let detail = json!({"id":format!("thread:{huge}"),"status":"running"});
    let show = cards::show(
        &linked(),
        &detail,
        "xxxxxxxx",
        &"中".repeat(1500),
        Some("oc_allowed"),
    );
    let confirmation =
        cards::confirmation_card(&linked(), "thread:t", &json!({"id":huge,"supported":true}));
    let mut long_endpoint = config();
    long_endpoint.mobile_endpoint = format!("https://pc.example/{}", "p".repeat(480));
    long_endpoint.validate().unwrap();
    let text_limit = cards::show(
        &long_endpoint,
        &json!({"id":format!("thread:{}", "中".repeat(80)),"status":"idle"}),
        "t",
        &"中".repeat(1200),
        Some("oc_allowed"),
    );
    for card in [show, confirmation, text_limit] {
        assert!(cards::encoded_len(&card) <= CARD_BYTES);
        assert!(visible_chars(&card) <= cards::MESSAGE_CHARS);
        assert!(card.to_string().contains("[已截断]"));
    }
}

#[tokio::test]
async fn stale_card_ids_never_resolve_to_another_session() {
    let f = Fixture::new().await;
    thread(&f.state);
    let core = Core::Headless(f.state.clone());
    let cfg = config();
    // Text prefixes may select the current thread, but full ids embedded in
    // old cards must never become prefixes for a different thread.
    for action in ["show", "stop"] {
        let value = json!({"action":action,"task_id":"thread:feishu","p2p_chat_id":"oc_allowed"});
        let request = actions::authorize(&cfg, &card_event(action, value))
            .unwrap()
            .unwrap();
        let reply = actions::execute_request(&core, &cfg, &request).await.text();
        assert!(reply.contains("卡片可能已过期"), "{reply}");
        assert!(!reply.contains("已请求停止"), "{reply}");
    }
    f.finish().await;
}

#[tokio::test]
async fn task_notifications_link_to_the_session() {
    let f = Fixture::new().await;
    let core = Core::Headless(f.state.clone());
    let (tx, mut rx) = tokio::sync::mpsc::channel(16);
    let runtime = Runtime::default();
    let cfg = linked();
    let mut notifications = Notifications::default();
    notifications.deliver(&runtime, &core, &cfg, &tx, &json!({"type":"task_status",
        "task_id":"thread:abcd1234-0000","turn_id":"one","status":"idle","summary":"turn_finished"}));
    let finished = rx.try_recv().unwrap();
    assert_eq!(finished.kind, "text");
    assert!(
        finished.content["text"]
            .as_str()
            .unwrap()
            .ends_with(&format!("\nMobile Web：{LINK}"))
    );
    let (sender, _receiver) = tokio::sync::oneshot::channel();
    f.state
        .agent
        .cc_pending_permissions
        .lock()
        .unwrap()
        .insert("cid".into(), sender);
    f.state.mobile.confirmations.lock().unwrap().insert(
        "cid".into(),
        json!({"id":"cid","thread_id":"abcd1234-0000","tool":"write_file","supported":true}),
    );
    notifications.deliver(&runtime, &core, &cfg, &tx, &json!({"type":"task_status",
        "task_id":"thread:abcd1234-0000","turn_id":"two","status":"awaiting_confirmation","summary":"write_file"}));
    let confirmation = rx.try_recv().unwrap();
    assert_eq!(confirmation.kind, "interactive");
    assert!(confirmation.content.to_string().contains(LINK));
    f.finish().await;
}

#[test]
fn terminal_card_offers_follow_refresh_and_key_buttons() {
    let card = cards::terminal(
        &linked(),
        "term:abcd1234-0000",
        "构建脚本",
        "running",
        "line 1\nline 2",
        true,
        Some("oc_allowed"),
    );
    assert_eq!(card["config"]["update_multi"], true);
    assert_eq!(card["header"]["title"]["content"], "Taomni 终端 abcd1234");
    let elements = card["elements"].as_array().unwrap();
    assert_eq!(elements[0]["text"]["content"], "构建脚本 · 运行中");
    assert_eq!(elements[1]["text"]["content"], "line 1\nline 2");
    assert_eq!(
        buttons(&elements[2]),
        ["刷新", "停止跟随", "Ctrl-C", "打开手机页面"]
    );
    let group = cards::terminal(
        &config(),
        "term:abcd1234-0000",
        "构建脚本",
        "running",
        "secrets",
        false,
        None,
    );
    assert!(!group.to_string().contains("secrets"));
    assert!(group.to_string().contains("仅限私聊"));
    let exited = cards::terminal(
        &config(),
        "term:abcd1234-0000",
        "构建脚本",
        "exited",
        "",
        true,
        Some("oc_allowed"),
    );
    assert!(!exited.to_string().contains("Ctrl-C"));
    assert!(exited.to_string().contains("（暂无输出）"));
}

#[test]
fn saved_sessions_card_opens_by_button_and_stays_bounded() {
    let sessions: Vec<Value> = (0..3)
        .map(|n| {
            json!({"id":format!("{n}2345678-abcd"),"name":format!("会话{n}"),
                "session_type":"SSH"})
        })
        .collect();
    let card = cards::saved(&linked(), &sessions, Some("oc_allowed"));
    assert_eq!(card["header"]["title"]["content"], "Taomni 已保存会话（3）");
    assert_eq!(buttons(&card["elements"][1]), ["打开"]);
    let group = cards::saved(&config(), &sessions, None);
    assert!(!group.to_string().contains("\"open\""));
    assert!(group.to_string().contains("仅限私聊"));
    let many: Vec<Value> = (0..40)
        .map(|n| json!({"id":format!("{n:08}"),"name":"会话","session_type":"SSH"}))
        .collect();
    let bounded = cards::saved(&config(), &many, Some("oc_allowed"));
    assert!(cards::encoded_len(&bounded) <= CARD_BYTES);
    assert!(visible_chars(&bounded) <= cards::MESSAGE_CHARS);
    assert!(bounded.to_string().contains("[已截断] 仅显示前"));
}

#[test]
fn terminal_card_callbacks_map_to_commands_and_privacy() {
    let refresh = json!({"action":"term","op":"refresh","task_id":"term:abcd1234","p2p_chat_id":"oc_allowed"});
    assert_eq!(
        cards::callback_command(&refresh, Some("oc_allowed")).unwrap(),
        ("term-refresh term:abcd1234".into(), true)
    );
    assert_eq!(
        cards::callback_command(&refresh, Some("oc_other"))
            .unwrap()
            .1,
        false
    );
    let unfollow = json!({"action":"term","op":"unfollow","task_id":"term:abcd1234","p2p_chat_id":"oc_allowed"});
    assert_eq!(
        cards::callback_command(&unfollow, Some("oc_allowed"))
            .unwrap()
            .0,
        "term-unfollow term:abcd1234"
    );
    let key =
        json!({"action":"key","key":"ctrl-c","task_id":"term:abcd1234","p2p_chat_id":"oc_allowed"});
    assert_eq!(
        cards::callback_command(&key, Some("oc_allowed")).unwrap().0,
        "key term:abcd1234 ctrl-c"
    );
    let open = json!({"action":"open","saved_id":"12345678","p2p_chat_id":"oc_allowed"});
    assert_eq!(
        cards::callback_command(&open, Some("oc_allowed")).unwrap(),
        ("open 12345678".into(), true)
    );
    assert_eq!(
        cards::callback_command(&json!({"action":"new"}), Some("oc_allowed")).unwrap(),
        ("new".into(), false)
    );
    assert!(
        cards::callback_command(
            &json!({"action":"term","op":"nope","task_id":"term:abcd1234"}),
            Some("oc")
        )
        .is_err()
    );
    assert!(
        cards::callback_command(&json!({"action":"open","saved_id":"a b"}), Some("oc")).is_err()
    );
    assert!(
        cards::callback_command(
            &json!({"action":"key","key":"ctrl-c","task_id":"thread:abcd"}),
            Some("oc")
        )
        .is_err()
    );
}

#[test]
fn desktop_remote_cards_bind_image_key_and_callback_actions() {
    use crate::mobile::desktop::DesktopWindow;
    let cfg = linked();
    assert_eq!(
        cards::desktop_link(&cfg).as_deref(),
        Some("https://pc.example:8443/#/desktop")
    );
    let pending = cards::screen(
        &cfg,
        "显示器 1",
        "display-0",
        1280,
        720,
        Some("已刷新"),
        Some("oc_allowed"),
    );
    assert!(cards::encoded_len(&pending) <= CARD_BYTES);
    let patched = cards::with_screen_image_key(pending, "img_v2_qa_key");
    let raw = patched.to_string();
    assert!(raw.contains("img_v2_qa_key"), "{raw}");
    assert!(!raw.contains(cards::SCREEN_IMAGE_PLACEHOLDER), "{raw}");

    let win_card = cards::windows(
        &cfg,
        &[DesktopWindow {
            id: "tauri:mobile-remote-browser".into(),
            title: "Taomni Browser".into(),
            app_name: "Taomni".into(),
            pid: 12,
            x: 0,
            y: 0,
            width: 800,
            height: 600,
            minimized: false,
            focused: true,
            kind: "tauri_browser".into(),
        }],
        Some("oc_allowed"),
    );
    assert!(win_card.to_string().contains("Taomni Browser"));
    assert!(win_card.to_string().contains("/#/desktop"));

    assert_eq!(
        cards::callback_command(
            &json!({"action":"screen","p2p_chat_id":"oc_allowed"}),
            Some("oc_allowed")
        )
        .unwrap(),
        ("screen".into(), true)
    );
    assert_eq!(
        cards::callback_command(
            &json!({"action":"windows","p2p_chat_id":"oc_other"}),
            Some("oc_allowed")
        )
        .unwrap(),
        ("windows".into(), false)
    );
}
