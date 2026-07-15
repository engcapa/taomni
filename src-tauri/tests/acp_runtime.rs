use serde_json::json;
use std::sync::Arc;
use std::time::Duration;
use taomni_lib::agent::acp_bridge::{
    AcpProcess, AcpProcessConfig, AcpProfileConfig, AcpRuntimeError, AcpRuntimeEvent,
    AcpStopReason, process_config,
};
use taomni_lib::agent::local::LocalAgentEvent;

fn fake_config(scenario: &str) -> AcpProcessConfig {
    AcpProcessConfig::new(
        env!("CARGO_BIN_EXE_acp-fake-agent"),
        vec![scenario.to_string()],
    )
    .with_request_timeout(Duration::from_secs(2))
}

async fn initialized_process(scenario: &str) -> Arc<AcpProcess> {
    let process = Arc::new(AcpProcess::spawn(fake_config(scenario)).await.unwrap());
    let info = process.initialize().await.unwrap();
    assert_eq!(info.protocol_version, 1);
    assert_eq!(info.name.as_deref(), Some("acp-fake-agent"));
    process.authenticate("cached_token").await.unwrap();
    process
}

#[tokio::test]
async fn streams_a_complete_turn_and_sanitizes_diagnostics() {
    let process = initialized_process("happy").await;
    let session_id = process.new_session("/workspace", vec![]).await.unwrap();
    let mut updates = process.subscribe();

    let result = process.prompt(&session_id, "hello").await.unwrap();
    assert_eq!(result.stop_reason, AcpStopReason::EndTurn);
    assert_eq!(
        result.usage.as_ref().and_then(|usage| usage.total_tokens),
        Some(14)
    );

    let mut events = Vec::new();
    while let Ok(event) = updates.try_recv() {
        events.push(event);
    }
    assert!(events.iter().any(|event| matches!(
        event,
        AcpRuntimeEvent::SessionUpdate(update)
            if update.event == Some(LocalAgentEvent::AssistantDelta { content: "Hello ".into() })
    )));
    assert!(events.iter().any(|event| matches!(
        event,
        AcpRuntimeEvent::SessionUpdate(update)
            if matches!(update.event, Some(LocalAgentEvent::ToolStarted { ref id, ref input, .. }) if id == "tool-1" && input.is_null())
    )));
    assert!(events.iter().any(|event| matches!(
        event,
        AcpRuntimeEvent::SessionUpdate(update)
            if matches!(update.event, Some(LocalAgentEvent::ToolCompleted { ref output, .. }) if output == "completed")
    )));

    let stderr = wait_for_stderr(&process).await;
    assert!(stderr.contains("[REDACTED]"));
    assert!(!stderr.contains("fake-runtime-secret"));
    process.stop().await;
    assert!(process.is_stopped());
}

#[tokio::test]
async fn loads_sessions_without_replaying_old_output() {
    let process = initialized_process("happy").await;
    let mut updates = process.subscribe();
    process
        .load_session("fake-session", "/workspace", vec![])
        .await
        .unwrap();

    let event = updates.recv().await.unwrap();
    assert!(matches!(
        event,
        AcpRuntimeEvent::SessionUpdate(update)
            if update.is_replay && update.event.is_none()
    ));
    process.stop().await;
}

#[tokio::test]
async fn cancel_notification_finishes_the_active_prompt() {
    let process = initialized_process("wait-for-cancel").await;
    let session_id = process.new_session("/workspace", vec![]).await.unwrap();
    let mut updates = process.subscribe();
    let prompt_process = process.clone();
    let prompt_session = session_id.clone();
    let prompt = tokio::spawn(async move { prompt_process.prompt(&prompt_session, "wait").await });

    let received = tokio::time::timeout(Duration::from_secs(2), updates.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(received, AcpRuntimeEvent::SessionUpdate(_)));
    assert!(process.is_turn_active());
    process.cancel(&session_id).await.unwrap();

    let result = prompt.await.unwrap().unwrap();
    assert_eq!(result.stop_reason, AcpStopReason::Cancelled);
    assert!(!process.is_turn_active());
    process.stop().await;
}

#[tokio::test]
async fn malformed_lines_do_not_poison_following_messages() {
    let process = initialized_process("malformed-then-valid").await;
    let session_id = process.new_session("/workspace", vec![]).await.unwrap();
    let mut updates = process.subscribe();
    process.prompt(&session_id, "hello").await.unwrap();

    let mut saw_warning = false;
    let mut saw_text = false;
    while let Ok(event) = updates.try_recv() {
        match event {
            AcpRuntimeEvent::ProtocolWarning { message } => {
                saw_warning = message.contains("invalid JSON")
            }
            AcpRuntimeEvent::SessionUpdate(update) => {
                saw_text |= matches!(update.event, Some(LocalAgentEvent::AssistantDelta { .. }));
            }
            AcpRuntimeEvent::Closed => {}
        }
    }
    assert!(saw_warning);
    assert!(saw_text);
    process.stop().await;
}

#[tokio::test]
async fn correlates_out_of_order_responses_by_request_id() {
    let process = initialized_process("out-of-order").await;
    let (first, second) = tokio::join!(
        process.request("test/first", json!({})),
        process.request("test/second", json!({})),
    );
    assert_eq!(first.unwrap(), json!({ "order": 1 }));
    assert_eq!(second.unwrap(), json!({ "order": 2 }));
    process.stop().await;
}

#[tokio::test]
async fn rejects_unadvertised_peer_capabilities() {
    let process = initialized_process("peer-request").await;
    let session_id = process.new_session("/workspace", vec![]).await.unwrap();
    let result = process.prompt(&session_id, "read a file").await.unwrap();
    assert_eq!(result.stop_reason, AcpStopReason::EndTurn);
    process.stop().await;
}

#[tokio::test]
async fn process_exit_fails_new_requests_without_hanging() {
    let process = AcpProcess::spawn(fake_config("exit-after-initialize"))
        .await
        .unwrap();
    process.initialize().await.unwrap();
    let error = process.new_session("/workspace", vec![]).await.unwrap_err();
    assert!(matches!(
        error,
        AcpRuntimeError::Stopped | AcpRuntimeError::ProcessExited | AcpRuntimeError::WriteFailed(_)
    ));
    process.stop().await;
}

#[tokio::test]
async fn request_timeout_removes_the_pending_request() {
    let config = fake_config("happy").with_request_timeout(Duration::from_millis(100));
    let process = AcpProcess::spawn(config).await.unwrap();
    process.initialize().await.unwrap();
    let error = process.request("test/hang", json!({})).await.unwrap_err();
    assert_eq!(
        error,
        AcpRuntimeError::RequestTimedOut {
            method: "test/hang".into(),
        }
    );
    process.stop().await;
}

#[tokio::test]
async fn process_proxy_policy_reaches_the_child_environment() {
    let direct = recorded_proxy_environment(None).await;
    for key in [
        "httpProxy",
        "httpsProxy",
        "allProxy",
        "httpProxyLower",
        "httpsProxyLower",
        "allProxyLower",
    ] {
        assert!(direct.get(key).is_none_or(serde_json::Value::is_null));
    }
    assert_eq!(
        direct.get("noProxy").and_then(serde_json::Value::as_str),
        Some("localhost,127.0.0.1,::1")
    );
    assert_eq!(
        direct
            .get("noProxyLower")
            .and_then(serde_json::Value::as_str),
        Some("localhost,127.0.0.1,::1")
    );

    let manual_url = "socks5://127.0.0.1:1080";
    let manual = recorded_proxy_environment(Some(manual_url)).await;
    for key in [
        "httpProxy",
        "httpsProxy",
        "allProxy",
        "httpProxyLower",
        "httpsProxyLower",
        "allProxyLower",
    ] {
        assert_eq!(
            manual.get(key).and_then(serde_json::Value::as_str),
            Some(manual_url)
        );
    }
}

async fn recorded_proxy_environment(proxy_url: Option<&str>) -> serde_json::Value {
    let record = tempfile::NamedTempFile::new().unwrap();
    let profile = AcpProfileConfig {
        id: "fixture".into(),
        command: env!("CARGO_BIN_EXE_acp-fake-agent").into(),
        args: vec!["happy".into()],
        ..Default::default()
    };
    let config = process_config(&profile, None, proxy_url, Duration::from_secs(2))
        .unwrap()
        .with_env("ACP_FAKE_RECORD", record.path().to_string_lossy());
    let process = AcpProcess::spawn(config).await.unwrap();
    process.initialize().await.unwrap();
    process.stop().await;

    let line = std::fs::read_to_string(record.path()).unwrap();
    serde_json::from_str(line.lines().next().unwrap()).unwrap()
}

async fn wait_for_stderr(process: &AcpProcess) -> String {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let stderr = process.stderr().await;
            if !stderr.is_empty() {
                break stderr;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap()
}
