//! Command grammar, current-list resolution and post-resolution write safety.
use super::{
    actions,
    commands::{normalize, resolve, short_id},
    tests::{config, event, thread},
};
use crate::mobile::{Core, service_tests::Fixture};
use serde_json::{Value, json};

#[test]
fn private_chats_accept_prefix_free_aliases_and_unicode_separators() {
    for (text, expected) in [
        ("list", "list"),
        ("列表", "list"),
        ("List", "list"),
        ("/taomni list", "list"),
        ("/TAOMNI HELP", "help"),
        ("/taomni", "help"),
        ("  /taomni\u{3000} ", "help"),
        ("/taomni\u{3000}列表", "list"),
        ("帮助", "help"),
        ("查看\u{3000}\u{3000}abcd1234", "show abcd1234"),
        ("文件 abcd\t notes\u{3000}1.txt", "file abcd notes 1.txt"),
        (
            "发送 \u{3000} abcd   写\u{3000}测试\n第二行",
            "send abcd 写 测试 第二行",
        ),
        ("继续 abcd 继续写", "send abcd 继续写"),
        ("停止 abcd", "stop abcd"),
        ("同意 abcd cid", "approve abcd cid"),
        ("批准 abcd cid", "approve abcd cid"),
        ("拒绝 abcd cid", "reject abcd cid"),
        // Unknown private text still yields a help-pointer reply.
        ("hello\t there", "hello there"),
        ("继续写测试", "继续写测试"),
        ("/taomnilist", "/taomnilist"),
        ("/taomni列表", "/taomni列表"),
    ] {
        assert_eq!(normalize(text, true).as_deref(), Some(expected), "{text:?}");
    }
}

#[test]
fn group_chats_require_the_prefix() {
    for text in [
        "list",
        "列表",
        "hello",
        "/taomnilist",
        "/taomni列表",
        "查看 abcd",
    ] {
        assert_eq!(normalize(text, false), None, "{text:?}");
    }
    assert_eq!(normalize("/taomni", false).as_deref(), Some("help"));
    assert_eq!(
        normalize("/taomni\u{3000}列表", false).as_deref(),
        Some("list")
    );
    assert_eq!(
        normalize("/taomni\t 停止\n abcd", false).as_deref(),
        Some("stop abcd")
    );
    assert_eq!(normalize("/taomni hello", false).as_deref(), Some("hello"));
}

#[test]
fn message_events_apply_the_chat_type_rule() {
    let cfg = config();
    let private = actions::authorize(&cfg, &event("p2p-list", "列表"))
        .unwrap()
        .unwrap();
    assert_eq!(private.command, "list");
    assert!(private.private_chat);
    let bare = actions::authorize(&cfg, &event("p2p-bare", "/taomni"))
        .unwrap()
        .unwrap();
    assert_eq!(bare.command, "help");
    let mut group = event("group-list", "list");
    group["event"]["message"]["chat_type"] = json!("group");
    assert!(actions::authorize(&cfg, &group).unwrap().is_none());
    group["event"]["message"]["content"] = json!(json!({"text":"/taomni\u{3000}列表"}).to_string());
    let prefixed = actions::authorize(&cfg, &group).unwrap().unwrap();
    assert_eq!(prefixed.command, "list");
    assert!(!prefixed.private_chat);
    group["event"]["message"]
        .as_object_mut()
        .unwrap()
        .remove("chat_type");
    assert!(
        !actions::authorize(&cfg, &group)
            .unwrap()
            .unwrap()
            .private_chat
    );
}

fn sessions() -> Vec<Value> {
    vec![
        json!({"id":"term:terminal:11111111-aaaa","title":"终端一"}),
        json!({"id":"term:terminal:22222222-bbbb","title":"终端二"}),
        json!({"id":"thread:abcd1234-0000","title":"写测试"}),
        json!({"id":"thread:abcd5678-0000","title":"修复"}),
        json!({"id":"thread:feishu-task","title":"Feishu QA"}),
    ]
}

#[test]
fn short_ids_are_eight_characters_and_unique_prefixes_resolve() {
    let list = sessions();
    assert_eq!(short_id("thread:abcd1234-0000"), "abcd1234");
    assert_eq!(short_id("thread:feishu-task"), "feishu-t");
    assert_eq!(short_id("term:terminal:11111111-aaaa"), "terminal");
    assert_eq!(short_id("thread:中文会话编号测试九"), "中文会话编号测试");
    for session in &list {
        let id = session["id"].as_str().unwrap();
        assert_eq!(resolve(&list, id).unwrap(), id);
    }
    for (input, expected) in [
        ("abcd1", "thread:abcd1234-0000"),
        ("feis", "thread:feishu-task"),
        ("thread:abcd5", "thread:abcd5678-0000"),
        ("thread:f", "thread:feishu-task"),
        ("term:terminal:2", "term:terminal:22222222-bbbb"),
    ] {
        assert_eq!(resolve(&list, input).unwrap(), expected, "{input}");
    }
    let mut reordered = list.clone();
    reordered.reverse();
    assert_eq!(resolve(&list, "feis"), resolve(&reordered, "feis"));
    assert!(resolve(&list, "1").unwrap_err().contains("至少 4"));
}

#[test]
fn ambiguous_missing_and_short_ids_are_refused() {
    let list = sessions();
    let ambiguous = resolve(&list, "abcd").unwrap_err();
    assert!(ambiguous.contains("2 个会话"), "{ambiguous}");
    assert!(ambiguous.contains("abcd1234 · 写测试"), "{ambiguous}");
    assert!(ambiguous.contains("abcd5678 · 修复"), "{ambiguous}");
    assert!(resolve(&list, "terminal").unwrap_err().contains("2 个会话"));
    assert!(
        resolve(&list, "thread:abcd")
            .unwrap_err()
            .contains("2 个会话")
    );
    for missing in [
        "zzzz",
        "thread:elsewhere",
        "term:feishu",
        "thread:",
        "term:",
    ] {
        assert!(
            resolve(&list, missing).unwrap_err().contains("未找到"),
            "{missing}"
        );
    }
    for short in ["abc", "", "1"] {
        assert!(
            resolve(&list, short).unwrap_err().contains("至少 4"),
            "{short}"
        );
    }
    let many: Vec<Value> = (0..7)
        .map(|n| json!({"id":format!("thread:dupe{n}-x"),"title":format!("任务{n}")}))
        .collect();
    let error = resolve(&many, "dupe").unwrap_err();
    assert!(error.contains("7 个会话"), "{error}");
    assert_eq!(error.lines().count(), 1 + 5 + 1, "{error}");
    assert!(error.contains("仅列出前 5 个"));

    let exact = vec![
        json!({"id":"thread:abcd","title":"短"}),
        json!({"id":"thread:abcde","title":"长"}),
        json!({"id":"term:same-id","title":"终端"}),
        json!({"id":"thread:same-id","title":"线程"}),
        json!({"id":"thread:abc","title":"三字符"}),
    ];
    assert_eq!(resolve(&exact, "abcd").unwrap(), "thread:abcd");
    let twins = resolve(&exact, "same-id").unwrap_err();
    assert!(twins.contains("same-id · 终端（term）"), "{twins}");
    assert!(twins.contains("same-id · 线程（thread）"), "{twins}");
    assert_eq!(resolve(&exact, "thread:same-id").unwrap(), "thread:same-id");
    assert_eq!(resolve(&exact, "thread:abc").unwrap(), "thread:abc");
    assert!(resolve(&exact, "abc").unwrap_err().contains("至少 4"));
}

#[tokio::test]
async fn short_ids_resolve_before_the_thread_only_rule() {
    let f = Fixture::new().await;
    thread(&f.state);
    f.state.mobile.broker.register("pty-short-id-1");
    let core = Core::Headless(f.state.clone());
    let cfg = config();
    for command in [
        "send pty-short hi",
        "stop pty-s",
        "approve pty-short cid",
        "reject term:pty cid",
    ] {
        let reply = actions::execute(&core, &cfg, command).await.text();
        assert!(
            reply.contains("agent_only_no_pty_input"),
            "{command}: {reply}"
        );
    }
    assert!(
        actions::execute(&core, &cfg, "approve feis cid")
            .await
            .text()
            .contains("not_supported_on_mobile")
    );
    assert!(
        actions::execute(&core, &cfg, "stop feishu")
            .await
            .text()
            .contains("已请求停止当前轮次")
    );
    for (command, expected) in [
        ("stop zzzz", "未找到"),
        ("stop thread:zzzz", "未找到"),
        ("send fei hi", "至少 4"),
        ("show", "缺少会话 id"),
        ("hello", "发送“帮助”"),
        ("help", "短 id"),
    ] {
        let reply = actions::execute(&core, &cfg, command).await.text();
        assert!(reply.contains(expected), "{command}: {reply}");
    }
    // Unknown private text is actually replied to, not only admitted.
    let unknown = actions::authorize(&cfg, &event("unknown", "今天怎么样"))
        .unwrap()
        .unwrap();
    assert!(
        actions::execute_request(&core, &cfg, &unknown)
            .await
            .text()
            .contains("帮助")
    );
    f.finish().await;
}

#[test]
fn terminal_grammar_keeps_verbatim_input_text() {
    use super::commands::{key_bytes, parse, resolve_saved};
    let invocation = parse("输入 ls  -la\u{3000}--color", true).unwrap();
    assert_eq!(invocation.command, "input ls -la --color");
    assert_eq!(invocation.after_action, "ls  -la\u{3000}--color");
    assert_eq!(invocation.after_target, "-la\u{3000}--color");
    let invocation = parse("/taomni\u{3000}终端\u{3000}term:abcd1234", true).unwrap();
    assert_eq!(invocation.command, "term term:abcd1234");
    assert_eq!(invocation.after_action, "term:abcd1234");
    assert_eq!(invocation.after_target, "");
    for (text, expected) in [
        ("终端 abcd1234", "term abcd1234"),
        ("按键 ctrl-c", "key ctrl-c"),
        ("保存", "saved"),
        ("打开 生产机", "open 生产机"),
        ("新建", "new"),
        ("输入 ls -la", "input ls -la"),
    ] {
        assert_eq!(normalize(text, true).as_deref(), Some(expected), "{text:?}");
    }
    assert_eq!(key_bytes("Ctrl-C"), Some(&b"\x03"[..]));
    assert_eq!(key_bytes("enter"), Some(&b"\r"[..]));
    assert_eq!(key_bytes("up"), Some(&b"\x1b[A"[..]));
    assert_eq!(key_bytes("nope"), None);

    let saved = vec![
        json!({"id":"12345678-abcd-0000","name":"生产机","session_type":"SSH"}),
        json!({"id":"87654321-abcd-0000","name":"测试机","session_type":"LocalShell"}),
    ];
    assert_eq!(
        resolve_saved(&saved, "12345678-abcd-0000").unwrap(),
        "12345678-abcd-0000"
    );
    assert_eq!(
        resolve_saved(&saved, "生产机").unwrap(),
        "12345678-abcd-0000"
    );
    assert_eq!(
        resolve_saved(&saved, "87654321").unwrap(),
        "87654321-abcd-0000"
    );
    assert_eq!(resolve_saved(&saved, "测试").unwrap(), "87654321-abcd-0000");
    assert!(resolve_saved(&saved, "1").is_err());
    assert!(resolve_saved(&saved, "缺失").is_err());
}

#[test]
fn desktop_remote_commands_parse_aliases_and_group_prefix_rules() {
    use super::commands::parse;
    for (text, expected) in [
        ("screen", "screen"),
        ("屏幕", "screen"),
        ("截屏 disp-1", "screen disp-1"),
        ("windows", "windows"),
        ("窗口", "windows"),
        ("wininput win:1 hello   world", "wininput win:1 hello world"),
        ("窗口输入 1234 hello world", "wininput 1234 hello world"),
        ("窗口回车 win:1 ls -la", "winsend win:1 ls -la"),
        ("窗口按键 win:1 f5", "winkey win:1 f5"),
        ("浏览器 https://example.com", "browser https://example.com"),
    ] {
        assert_eq!(normalize(text, true).as_deref(), Some(expected), "{text:?}");
        assert_eq!(
            normalize(text, false),
            None,
            "group must require prefix: {text:?}"
        );
    }
    let verbatim = parse("窗口输入 win:9   a   b", true).unwrap();
    assert_eq!(verbatim.command, "wininput win:9 a b");
    assert_eq!(verbatim.after_target, "a   b");
}
