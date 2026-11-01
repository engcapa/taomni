//! Regressions established from the independent P0/P1 review.
use super::{Core, agent_view, file_view, service_tests::Fixture, session_view};
use serde_json::json;
use std::sync::atomic::Ordering;

#[tokio::test]
async fn subdirectory_root_paths_stay_local_and_diff_is_literal() {
    let f = Fixture::new().await;
    let dir = tempfile::tempdir().unwrap();
    let git = |args: &[&str]| {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(dir.path())
            .args(args)
            .output()
            .unwrap();
        assert!(output.status.success(), "{args:?}");
    };
    std::fs::create_dir(dir.path().join("sub")).unwrap();
    std::fs::write(dir.path().join("outside.txt"), "old\n").unwrap();
    std::fs::write(dir.path().join("sub/inside.txt"), "old\n").unwrap();
    git(&["init"]);
    git(&["config", "user.email", "qa@example.invalid"]);
    git(&["config", "user.name", "QA"]);
    git(&["add", "."]);
    git(&["commit", "-m", "fixture"]);
    std::fs::write(dir.path().join("outside.txt"), "outside secret\n").unwrap();
    std::fs::write(dir.path().join("sub/inside.txt"), "new\n").unwrap();
    let root = dir.path().join("sub");
    f.state
        .mobile
        .file_roots
        .lock()
        .unwrap()
        .insert("task".into(), root.clone());
    let changes = file_view::changes(&f.state, "thread:task").await.unwrap();
    assert_eq!(changes["changes"].as_array().unwrap().len(), 1);
    assert_eq!(changes["changes"][0]["path"], "inside.txt");
    assert_eq!(
        file_view::file(&f.state, "thread:task", "inside.txt")
            .await
            .unwrap()["content"],
        "new\n"
    );
    let diff = file_view::diff(&f.state, "thread:task", "inside.txt")
        .await
        .unwrap();
    assert!(diff["hunks"].to_string().contains("+new"));
    assert!(!diff.to_string().contains("outside secret"));
    assert!(file_view::diff(&f.state, "thread:task", "*").await.is_err());
    let context = crate::agent::context::build_agent_thread_context(
        &f.state,
        crate::agent::context::AgentThreadContextInput {
            thread_id: "task".into(),
            linked_session_id: Some("desktop-tab-restored-from-thread".into()),
            ..Default::default()
        },
    )
    .unwrap();
    file_view::remember_root(&f.state, &context);
    assert_eq!(
        file_view::file(&f.state, "thread:task", "inside.txt")
            .await
            .unwrap()["content"],
        "new\n"
    );
    std::fs::write(root.join(".env"), "SECRET=private").unwrap();
    assert_eq!(
        file_view::file(&f.state, "thread:task", ".env")
            .await
            .unwrap_err(),
        "path_denied"
    );
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let fifo = std::ffi::CString::new(root.join("pipe").as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        assert_eq!(
            tokio::time::timeout(
                std::time::Duration::from_secs(1),
                file_view::file(&f.state, "thread:task", "pipe")
            )
            .await
            .unwrap()
            .unwrap_err(),
            "file_unavailable"
        );
    }
    let remote = crate::agent::context::build_agent_thread_context(
        &f.state,
        crate::agent::context::AgentThreadContextInput {
            thread_id: "task".into(),
            linked_session_id: Some("remote-tab".into()),
            cwd: Some(root.to_string_lossy().into_owned()),
            ..Default::default()
        },
    )
    .unwrap();
    file_view::remember_root(&f.state, &remote);
    assert!(
        file_view::file(&f.state, "thread:task", "inside.txt")
            .await
            .is_err()
    );
    f.finish().await;
}

#[tokio::test]
async fn revoked_origin_errors_and_missing_terminal_are_readable_over_the_wire() {
    use futures::StreamExt;
    let f = Fixture::new().await;
    let (device, token) = f.pair().await;
    let mut ws = f.ws(&token, "/terminals/term%3Amissing/stream").await;
    let message = ws.next().await.unwrap().unwrap();
    let value: serde_json::Value = serde_json::from_str(message.to_text().unwrap()).unwrap();
    assert_eq!(value, json!({"type":"error","code":"terminal_not_found"}));
    assert!(
        matches!(ws.next().await.unwrap().unwrap(), tokio_tungstenite::tungstenite::Message::Close(Some(close)) if close.code == 4004.into())
    );
    f.state.mobile.auth.lock().unwrap().revoke(&device).unwrap();
    let preflight = f
        .client
        .request(
            reqwest::Method::OPTIONS,
            format!("{}/api/v1/ws-ticket", f.endpoint),
        )
        .header("Origin", "https://mobile.example")
        .send()
        .await
        .unwrap();
    assert_eq!(preflight.status(), 204);
    assert_eq!(
        preflight.headers()["access-control-allow-origin"],
        "https://mobile.example"
    );
    let response = f
        .client
        .post(format!("{}/api/v1/ws-ticket", f.endpoint))
        .header("Origin", "https://mobile.example")
        .bearer_auth(&token)
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 403);
    assert_eq!(
        response.headers()["access-control-allow-origin"],
        "https://mobile.example"
    );
    assert_eq!(
        response.json::<serde_json::Value>().await.unwrap(),
        json!({"error":"origin_denied"})
    );
    let host = f
        .client
        .get(format!("{}/api/v1/health", f.endpoint))
        .header("Host", "rebind.example:8787")
        .send()
        .await
        .unwrap();
    assert_eq!(host.status(), 403);
    f.finish().await;
}

#[test]
fn exited_replay_and_poisoned_mobile_locks_do_not_break_desktop_output() {
    let events = std::sync::Arc::new(super::events::Events::default());
    let broker = std::sync::Arc::new(super::pty_broker::Broker::new(events.clone()));
    broker.enabled.store(true, Ordering::Relaxed);
    broker.register("t");
    broker.output("t", b"final output\n");
    broker.exit("t");
    let (_, frames) = broker.subscribe("t").unwrap();
    assert!(frames[0]["lines"].to_string().contains("final output"));
    assert_eq!(frames.last().unwrap()["type"], "exit");
    let cursor = events.seq();
    broker.exit("t");
    broker.exit("missing");
    assert_eq!(events.seq(), cursor);
    let b = broker.clone();
    let _ = std::thread::spawn(move || {
        let _lock = b.terminals.lock().unwrap();
        panic!("poison fixture");
    })
    .join();
    broker.register("alive");
    broker.output("alive", b"still works");
    assert!(broker.gate("alive").is_ok());
    assert!(
        broker.subscribe("alive").unwrap().1[0]["lines"]
            .to_string()
            .contains("still works")
    );
    for n in 0..70 {
        broker.register(&format!("exited-{n}"));
        broker.exit(&format!("exited-{n}"));
    }
    assert_eq!(
        broker
            .terminals
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .filter(|t| !t.running)
            .count(),
        64
    );
}

#[tokio::test]
async fn desktop_only_gates_are_visible_and_drop_cleans_up() {
    let f = Fixture::new().await;
    let core = Core::Headless(f.state.clone());
    let gate = super::confirmation::DesktopConfirmation::new(
        &f.state.mobile,
        "side-effect",
        "t",
        "run_in_terminal",
    );
    assert_eq!(
        agent_view::confirmations(&f.state, "t")[0]["supported"],
        false
    );
    assert_eq!(
        agent_view::confirm(&f.state, "thread:t", "side-effect", "approve").unwrap_err(),
        "not_supported_on_mobile"
    );
    drop(gate);
    assert!(agent_view::confirmations(&f.state, "t").is_empty());
    assert!(
        super::headless_ops::secret(None)
            .unwrap_err()
            .contains("TAOMNI_FEISHU_APP_SECRET")
    );
    f.state.mobile.broker.register("readonly");
    assert_eq!(
        agent_view::stop_as(&core, "term:readonly", Some("reader"))
            .await
            .unwrap_err(),
        "not_holder"
    );
    assert!(
        session_view::list(&f.state).await.unwrap()["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["id"] == "term:readonly")
    );
    f.finish().await;
}

#[tokio::test]
async fn slow_event_consumer_disconnects_and_can_request_a_bounded_resync() {
    use futures::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;
    let f = Fixture::new().await;
    let (_, token) = f.pair().await;
    let mut ws = f.ws(&token, "/events").await;
    let hello = ws.next().await.unwrap().unwrap();
    assert!(hello.to_text().unwrap().contains("hello"));
    // No await in this batch: the service observes a real broadcast Lagged.
    for n in 0..1000 {
        f.state
            .mobile
            .events
            .publish(json!({"type":"file_changed", "n":n}));
    }
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while let Some(Ok(message)) = ws.next().await {
            if matches!(message, Message::Close(_)) {
                return;
            }
        }
    })
    .await
    .expect("lagged websocket must close");
    let mut resumed = f.ws(&token, "/events").await;
    resumed.next().await.unwrap().unwrap();
    resumed
        .send(Message::Text(
            json!({"type":"resume", "after_seq":0}).to_string().into(),
        ))
        .await
        .unwrap();
    let value: serde_json::Value =
        serde_json::from_str(resumed.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
    assert_eq!(value["type"], "resync");
    assert!(value.get("seq").is_none());
    assert_eq!(value["last_seq"], 1000);
    f.finish().await;
}

#[tokio::test]
async fn concurrent_desktop_entry_rejects_before_persisting_and_tools_omit_details() {
    let f = Fixture::new().await;
    let thread = serde_json::from_value(json!({"id":"t","title":"Task","provider_id":"local","created_at":1,"updated_at":1,"source":"drawer","mode":"chat","linked_session_id":null})).unwrap();
    crate::chat::store::create_thread(&f.state.db.lock().unwrap(), &thread).unwrap();
    let guard = super::turn::TurnGuard::reserve(&f.state.mobile, "t").unwrap();
    let req =
        serde_json::from_value(json!({"thread_id":"t","content":"must not be persisted"})).unwrap();
    assert_eq!(
        crate::chat::chat_stream_inner(req, None, &f.state, None)
            .await
            .unwrap_err(),
        "turn_in_progress"
    );
    assert!(
        crate::chat::store::list_messages(&f.state.db.lock().unwrap(), "t")
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        agent_view::message(
            Core::Headless(f.state.clone()),
            "thread:t",
            &"中".repeat(11000)
        )
        .await
        .unwrap_err(),
        "message_too_large"
    );
    crate::chat::emit_stream_event(
        None,
        &f.state,
        "t",
        "unused",
        &crate::chat::StreamEventOut::CcToolActivity {
            id: "assistant".into(),
            call_id: "call".into(),
            phase: "use".into(),
            tool: "read_file".into(),
            detail: "PRIVATE_ARGUMENT".into(),
        },
    );
    let detail = session_view::detail(&f.state, "thread:t").await.unwrap();
    assert_eq!(detail["tools"][0]["name"], "read_file");
    assert_eq!(detail["tools"][0]["status"], "running");
    assert!(!detail.to_string().contains("PRIVATE_ARGUMENT"));
    drop(guard);
    f.finish().await;
}

#[tokio::test]
async fn desktop_shared_mode_and_headless_exclusive_mode_are_mutually_exclusive() {
    let dir = tempfile::tempdir().unwrap();
    let desktop = super::headless::ModeLease::acquire(dir.path(), false).unwrap();
    let other_desktop = super::headless::ModeLease::acquire(dir.path(), false).unwrap();
    assert!(super::headless::ModeLease::acquire(dir.path(), true).is_err());
    drop(desktop);
    drop(other_desktop);
    let headless = super::headless::ModeLease::acquire(dir.path(), true).unwrap();
    assert!(super::headless::ModeLease::acquire(dir.path(), false).is_err());
    drop(headless);
}

#[tokio::test]
async fn stopping_and_restarting_the_service_invalidates_unused_pairing_codes() {
    let f = Fixture::new().await;
    let code = f.state.mobile.auth.lock().unwrap().pairing_code();
    let data = f.state.mobile.profile_data.lock().unwrap().clone().unwrap();
    f.state.mobile.stop().await;
    let endpoint = f
        .state
        .mobile
        .start(Core::Headless(f.state.clone()), data, false, 0)
        .await
        .unwrap();
    let response = f
        .client
        .post(format!("{endpoint}/api/v1/pair"))
        .json(&json!({"endpoint_label":"phone","pairing_code":code}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 400);
    assert_eq!(
        response.json::<serde_json::Value>().await.unwrap()["error"],
        "invalid_or_expired_code"
    );
    f.finish().await;
}

#[tokio::test]
async fn malicious_websocket_origin_is_denied_before_upgrade() {
    use tokio_tungstenite::tungstenite::{Error, client::IntoClientRequest};
    let f = Fixture::new().await;
    let (_, token) = f.pair().await;
    let response = f
        .client
        .post(format!("{}/api/v1/ws-ticket", f.endpoint))
        .header("Origin", "https://mobile.example")
        .bearer_auth(token)
        .json(&json!({}))
        .send()
        .await
        .unwrap()
        .json::<serde_json::Value>()
        .await
        .unwrap();
    let mut request = format!(
        "{}/api/v1/events?ticket={}",
        f.endpoint.replace("http:", "ws:"),
        response["ticket"].as_str().unwrap()
    )
    .into_client_request()
    .unwrap();
    request
        .headers_mut()
        .insert("Origin", "https://evil.example".parse().unwrap());
    match tokio_tungstenite::connect_async(request).await {
        Err(Error::Http(response)) => assert_eq!(response.status(), 403),
        _ => panic!("unpaired Origin must not upgrade"),
    }
    f.finish().await;
}

#[tokio::test]
async fn session_list_keeps_each_runtime_key_and_projects_exited_state() {
    let f = Fixture::new().await;
    // Runtime keys are opaque: a shared saved-session prefix never merges them.
    f.state.mobile.broker.register("saved::first");
    f.state.mobile.broker.register("saved::second");
    f.state
        .mobile
        .broker
        .exit_with_code("saved::first", Some(7));
    let list = session_view::list(&f.state).await.unwrap();
    let sessions = list["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 2);
    assert_eq!(sessions[0]["id"], "term:saved::first");
    assert_eq!(sessions[0]["status"], "exited");
    assert_eq!(sessions[1]["id"], "term:saved::second");
    assert_eq!(sessions[1]["status"], "running");
    let (_, frames) = f.state.mobile.broker.subscribe("saved::first").unwrap();
    assert_eq!(frames.last().unwrap()["code"], 7);
    f.finish().await;
}
