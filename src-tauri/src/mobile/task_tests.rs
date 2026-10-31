//! Native core boundaries that browser renderer fixtures cannot establish.
use super::{Core, agent_view, file_view, service_tests::Fixture, session_view};
use serde_json::json;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

fn thread(state: &crate::state::AppState, id: &str, provider: &str) {
    let value = serde_json::from_value(json!({"id":id,"title":"QA task","provider_id":provider,
        "created_at":1,"updated_at":1,"source":"drawer","mode":"chat","linked_session_id":null}))
    .unwrap();
    crate::chat::store::create_thread(&state.db.lock().unwrap(), &value).unwrap();
}

#[tokio::test]
async fn headless_followup_is_a_real_turn_cancellable_and_never_overlaps() {
    use axum::{Router, response::IntoResponse, routing::post};
    let requests = Arc::new(AtomicUsize::new(0));
    let count = requests.clone();
    let router = Router::new().route("/v1/chat/completions",post(move || {
        let count = count.clone();
        async move {
            if count.fetch_add(1, Ordering::SeqCst) == 0 {
                std::future::pending::<()>().await;
            }
            ([("content-type","text/event-stream")],
                "data: {\"choices\":[{\"delta\":{\"content\":\"QA_REAL_FOLLOWUP\"}}]}\n\ndata: [DONE]\n\n").into_response()
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut config = crate::ai::config::AiConfig::default();
    let local = config.llm.providers.get_mut("local").unwrap();
    local.base_url = format!("http://{}/v1", listener.local_addr().unwrap());
    local.proxy_mode = "none".into();
    config.llm.active = "local".into();
    let mock = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let f = Fixture::with_config(config).await;
    thread(&f.state, "task", "local");
    let core = Core::Headless(f.state.clone());
    agent_view::message(core.clone(), "thread:task", "First turn")
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        while requests.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        session_view::detail(&f.state, "thread:task").await.unwrap()["status"],
        "running"
    );
    assert_eq!(
        agent_view::message(core.clone(), "thread:task", "Overlap")
            .await
            .unwrap_err(),
        "turn_in_progress"
    );
    agent_view::stop(&core, "thread:task").await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        while f
            .state
            .mobile
            .pending_turns
            .lock()
            .unwrap()
            .contains_key("task")
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        session_view::detail(&f.state, "thread:task").await.unwrap()["summary"],
        "stopped"
    );
    agent_view::message(core.clone(), "thread:task", "Second turn")
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        while f
            .state
            .mobile
            .pending_turns
            .lock()
            .unwrap()
            .contains_key("task")
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let messages = crate::chat::store::list_messages(&f.state.db.lock().unwrap(), "task").unwrap();
    assert_eq!(messages.iter().filter(|m| m.role == "user").count(), 2);
    assert!(
        messages
            .iter()
            .any(|m| m.content.contains("QA_REAL_FOLLOWUP"))
    );
    thread(&f.state, "cc", "claude-code");
    assert_eq!(
        agent_view::message(core, "thread:cc", "Unavailable")
            .await
            .unwrap_err(),
        "desktop_required"
    );
    agent_view::stop(&Core::Headless(f.state.clone()), "thread:task")
        .await
        .unwrap(); // idempotent
    mock.abort();
    f.finish().await;
}

#[tokio::test]
async fn confirmations_are_thread_scoped_and_first_answer_wins() {
    let f = Fixture::new().await;
    let (tx, rx) = tokio::sync::oneshot::channel();
    f.state
        .agent
        .cc_pending_permissions
        .lock()
        .unwrap()
        .insert("gate".into(), tx);
    f.state.mobile.confirmations.lock().unwrap().insert(
        "gate".into(),
        json!({"id":"gate","thread_id":"task","tool":"write","supported":true}),
    );
    assert!(agent_view::confirm(&f.state, "thread:other", "gate", "approve").is_err());
    assert!(agent_view::confirm(&f.state, "thread:task", "gate", "allow_session").is_err());
    agent_view::confirm(&f.state, "thread:task", "gate", "reject").unwrap();
    assert!(matches!(
        rx.await.unwrap(),
        crate::state::CcPermissionDecision::Deny
    ));
    assert_eq!(
        agent_view::confirm(&f.state, "thread:task", "gate", "approve").unwrap_err(),
        "already_resolved"
    );
    assert!(agent_view::confirmations(&f.state, "task").is_empty());
    f.finish().await;
}

#[tokio::test]
async fn real_git_file_diff_bounds_and_notifications_without_a_terminal() {
    let f = Fixture::new().await;
    let root = tempfile::tempdir().unwrap();
    let git = |args: &[&str]| {
        assert!(
            std::process::Command::new("git")
                .arg("-C")
                .arg(root.path())
                .args(args)
                .output()
                .unwrap()
                .status
                .success()
        );
    };
    git(&["init"]);
    git(&["config", "user.email", "qa@example.invalid"]);
    git(&["config", "user.name", "QA"]);
    std::fs::write(root.path().join("test.txt"), "old\n").unwrap();
    git(&["add", "test.txt"]);
    git(&["commit", "-m", "fixture"]);
    f.state
        .mobile
        .file_roots
        .lock()
        .unwrap()
        .insert("task".into(), root.path().to_owned());
    f.state.mobile.roots_changed.notify_one();
    // Watch establishment is asynchronous; wait for a real filesystem event.
    let mut events = f.state.mobile.events.tx.subscribe();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            std::fs::write(root.path().join("test.txt"), "new\n").unwrap();
            if let Ok(Ok(event)) =
                tokio::time::timeout(std::time::Duration::from_millis(50), events.recv()).await
            {
                if event["type"] == "file_changed" && event["path"] == "test.txt" {
                    break;
                }
            }
        }
    })
    .await
    .unwrap();
    assert!(f.state.mobile.broker.terminals.lock().unwrap().is_empty());
    let changes = file_view::changes(&f.state, "thread:task").await.unwrap();
    assert_eq!(changes["changes"][0]["path"], "test.txt");
    let diff = file_view::diff(&f.state, "thread:task", "test.txt")
        .await
        .unwrap();
    assert!(diff["hunks"].to_string().contains("+new"));
    git(&["add", "test.txt"]);
    assert!(
        file_view::diff(&f.state, "thread:task", "test.txt")
            .await
            .unwrap()["hunks"]
            .to_string()
            .contains("+new")
    );
    std::fs::remove_file(root.path().join("test.txt")).unwrap();
    assert!(
        file_view::diff(&f.state, "thread:task", "test.txt")
            .await
            .is_ok()
    );
    std::fs::write(root.path().join("large.txt"), vec![b'x'; 300_000]).unwrap();
    let large = file_view::file(&f.state, "thread:task", "large.txt")
        .await
        .unwrap();
    assert_eq!(large["truncated"], true);
    assert_eq!(large["content"].as_str().unwrap().len(), 256 * 1024);
    std::fs::write(root.path().join("binary"), b"a\0b").unwrap();
    assert_eq!(
        file_view::file(&f.state, "thread:task", "binary")
            .await
            .unwrap_err(),
        "binary_file"
    );
    assert!(
        file_view::file(&f.state, "thread:task", "../secret")
            .await
            .is_err()
    );
    assert_eq!(
        file_view::changes(&f.state, "thread:other")
            .await
            .unwrap_err(),
        "diff_unavailable"
    );
    f.finish().await;
}
