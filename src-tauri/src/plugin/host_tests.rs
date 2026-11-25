use super::*;
use serde_json::json;

#[test]
fn codec_handles_partial_frames_and_crlf() {
    let message = RpcMessage::Request(taomni_plugin_api::RpcRequest::new(
        "one",
        "ping",
        Some(json!({ "ok": true })),
    ));
    let encoded = JsonLineCodec::encode(&message).unwrap();
    let split = encoded.len() / 2;
    let mut codec = JsonLineCodec::default();
    assert!(codec.push(&encoded[..split]).unwrap().is_empty());
    let mut tail = encoded[split..].to_vec();
    assert_eq!(tail.pop(), Some(b'\n'));
    tail.push(b'\r');
    tail.push(b'\n');
    let messages = codec.push(&tail).unwrap();
    assert_eq!(messages, vec![message]);
    assert_eq!(codec.buffered_len(), 0);
}

#[test]
fn codec_rejects_oversized_partial_frame() {
    let mut codec = JsonLineCodec::new(3);
    assert_eq!(
        codec.push(b"abcd").unwrap_err(),
        FrameError::TooLarge { max: 3 }
    );
}

fn supervisor() -> HostSupervisor {
    HostSupervisor::new(
        "taomni-plugin-mfa",
        HostSupervisorConfig {
            request_timeout: Duration::from_millis(50),
            heartbeat_timeout: Duration::from_millis(100),
            max_restarts: 2,
            restart_window: Duration::from_millis(1_000),
            restart_backoff: Duration::from_millis(10),
        },
        0,
    )
}

#[test]
fn handshake_requires_plugin_and_token_then_tracks_requests() {
    let mut supervisor = supervisor();
    let mut request = HandshakeRequest::new(
        "taomni-plugin-mfa",
        "1.0.0",
        "secret",
        vec!["mfa.scan".into()],
        vec!["capture.screen".into()],
    );
    let rejected = supervisor.accept_handshake(&request, "secret", 10);
    assert!(rejected.accepted);
    assert_eq!(supervisor.state(), HostState::Running);
    assert!(supervisor.register_request("r1".into(), 10).is_ok());
    assert_eq!(
        supervisor
            .register_request("r1".into(), 10)
            .unwrap_err()
            .code,
        ErrorCode::DuplicateRequest.as_i32()
    );
    request.token = "wrong".into();
    assert!(!supervisor.accept_handshake(&request, "secret", 10).accepted);
}

#[test]
fn poll_emits_timeout_and_heartbeat_failure() {
    let mut supervisor = supervisor();
    let request = HandshakeRequest::new("taomni-plugin-mfa", "1", "secret", vec![], vec![]);
    assert!(supervisor.accept_handshake(&request, "secret", 0).accepted);
    supervisor.register_request("r1".into(), 0).unwrap();
    let events = supervisor.poll(50);
    assert!(matches!(events[0], SupervisorEvent::RequestTimeout(_)));
    assert_eq!(supervisor.pending_count(), 0);
    let events = supervisor.poll(100);
    assert!(matches!(
        events[0],
        SupervisorEvent::HeartbeatTimeout { elapsed_ms: 100 }
    ));
    assert_eq!(supervisor.state(), HostState::Crashed);
}

#[test]
fn cancellation_and_heartbeat_keep_host_running() {
    let mut supervisor = supervisor();
    let request = HandshakeRequest::new("taomni-plugin-mfa", "1", "secret", vec![], vec![]);
    assert!(supervisor.accept_handshake(&request, "secret", 0).accepted);
    supervisor.register_request("r1".into(), 0).unwrap();
    let notification = supervisor
        .cancel_request(&"r1".into(), Some("user".into()))
        .unwrap();
    assert_eq!(notification.method, CancelRequest::METHOD);
    assert!(supervisor.record_heartbeat(&Heartbeat { timestamp_ms: 20 }, 20));
    assert!(supervisor.poll(100).is_empty());
    assert_eq!(supervisor.state(), HostState::Running);
}

#[test]
fn crash_restart_is_bounded_and_uses_backoff() {
    let mut supervisor = supervisor();
    assert_eq!(
        supervisor.host_exited(0),
        RestartAction::Restart {
            attempt: 1,
            after: Duration::from_millis(10)
        }
    );
    supervisor.mark_restarted(10);
    assert_eq!(
        supervisor.host_exited(20),
        RestartAction::Restart {
            attempt: 2,
            after: Duration::from_millis(20)
        }
    );
    assert_eq!(supervisor.host_exited(30), RestartAction::Exhausted);
    assert_eq!(supervisor.state(), HostState::RestartExhausted);
}

#[test]
fn request_message_registers_before_encoding() {
    let mut supervisor = supervisor();
    let request = HandshakeRequest::new("taomni-plugin-mfa", "1", "secret", vec![], vec![]);
    assert!(supervisor.accept_handshake(&request, "secret", 0).accepted);
    let message = request_message(
        &mut supervisor,
        "r1".into(),
        "mfa.scan",
        Some(json!({ "full": true })),
        1,
    )
    .unwrap();
    assert!(matches!(message, RpcMessage::Request(_)));
    assert_eq!(supervisor.pending_count(), 1);
}

#[test]
fn peer_clock_cannot_extend_the_local_heartbeat_deadline() {
    let mut supervisor = supervisor();
    let request = HandshakeRequest::new("taomni-plugin-mfa", "1", "secret", vec![], vec![]);
    assert!(supervisor.accept_handshake(&request, "secret", 0).accepted);
    assert!(supervisor.record_heartbeat(
        &Heartbeat {
            timestamp_ms: u64::MAX
        },
        20
    ));
    assert_eq!(supervisor.last_heartbeat_ms(), Some(20));
    assert!(matches!(
        supervisor.poll(120).as_slice(),
        [SupervisorEvent::HeartbeatTimeout { elapsed_ms: 100 }]
    ));
}

#[test]
fn a_later_crash_window_can_recover_after_the_restart_budget_expires() {
    let mut supervisor = supervisor();
    assert!(matches!(
        supervisor.host_exited(0),
        RestartAction::Restart { attempt: 1, .. }
    ));
    assert!(matches!(
        supervisor.host_exited(1),
        RestartAction::Restart { attempt: 2, .. }
    ));
    assert_eq!(supervisor.host_exited(2), RestartAction::Exhausted);
    assert!(matches!(
        supervisor.host_exited(1_002),
        RestartAction::Restart { attempt: 1, .. }
    ));
}
