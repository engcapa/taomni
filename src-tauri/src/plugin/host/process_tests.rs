use super::*;
use taomni_plugin_api::HandshakeRequest;

impl HostProcess {
    /// Registry barrier units own no child or pipe. Kernel/process behavior
    /// is tested by the hosted lifecycle gates with the production adapter.
    pub(crate) fn stopped_for_registry_test() -> Self {
        let mut process = process(Duration::ZERO);
        process.stop();
        process
    }
}

fn process(backoff: Duration) -> HostProcess {
    let mut supervisor = HostSupervisor::new(
        "test-plugin",
        HostSupervisorConfig {
            max_restarts: 2,
            restart_backoff: backoff,
            ..HostSupervisorConfig::default()
        },
        0,
    );
    let handshake = HandshakeRequest::new("test-plugin", "1.0.0", "secret", vec![], vec![]);
    assert!(
        supervisor
            .accept_handshake(&handshake, "secret", 0)
            .accepted
    );
    HostProcess {
        launch: LaunchConfig {
            plugin_id: "test-plugin".into(),
            plugin_version: "1.0.0".into(),
            host: PathBuf::new(),
            working_dir: PathBuf::new(),
            commands: vec![],
            permissions: vec![],
            profile: None,
        },
        transport: None,
        retired_transports: Vec::new(),
        supervisor,
        cancellation: HostCancellation::default(),
        token: "secret".into(),
        id_prefix: "independent-id-prefix".into(),
        next_id: 0,
        started_at: Instant::now(),
        next_heartbeat_ms: 0,
        restart_due: None,
        service_config: None,
        services: None,
        active_operation: None,
        instance: None,
        request_id_mode: RequestIdMode::Legacy,
    }
}

#[test]
fn ticks_schedule_each_crash_once_and_exhaust_the_shared_budget() {
    let mut process = process(Duration::ZERO);
    assert!(matches!(
        process.tick(),
        HostTick::RestartScheduled { attempt: 1, .. }
    ));
    assert_eq!(process.tick(), HostTick::RestartReady { attempt: 1 });
    assert_eq!(process.tick(), HostTick::RestartReady { attempt: 1 });
    process.restart_due.take();
    process.supervisor.mark_restarted(0);
    assert!(matches!(
        process.tick(),
        HostTick::RestartScheduled { attempt: 2, .. }
    ));
    process.restart_due.take();
    process.supervisor.mark_restarted(0);
    assert_eq!(process.tick(), HostTick::RestartExhausted);
    assert_eq!(process.tick(), HostTick::RestartExhausted);
}

#[test]
fn restart_cannot_bypass_backoff_or_restart_an_explicitly_stopped_host() {
    let mut process = process(Duration::from_secs(60));
    assert!(matches!(
        process.tick(),
        HostTick::RestartScheduled { attempt: 1, .. }
    ));
    assert_eq!(
        process.restart().unwrap_err().rpc_code(),
        ErrorCode::InvalidState.as_i32()
    );
    assert!(matches!(
        process.tick(),
        HostTick::RestartScheduled { attempt: 1, .. }
    ));
    process.stop();
    assert_eq!(process.tick(), HostTick::Stopped);
    assert!(process.restart().is_err());
}

#[test]
fn queued_cancellation_does_not_start_an_operation_and_releases_its_id() {
    let mut process = process(Duration::ZERO);
    let handle = process.cancellation_handle();
    let id = RequestId::from("queued-request");
    assert!(handle.register(&id));
    assert!(handle.cancel(&id));
    assert!(matches!(
        process.invoke_with_id(id.clone(), "ping", None),
        Err(HostProcessError::Cancelled)
    ));
    assert_eq!(process.state(), HostState::Running);
    assert_eq!(process.supervisor.pending_count(), 0);
    assert!(!handle.cancel(&id));
}

#[test]
fn internal_identifiers_never_embed_the_authentication_token() {
    let mut process = process(Duration::ZERO);
    let first = process.next_request_id().unwrap();
    let second = process.next_request_id().unwrap();
    assert_ne!(first, second);
    assert!(!first.to_string().contains(&process.token));
}

#[test]
fn request_sequence_exhaustion_never_reuses_the_last_id() {
    let mut process = process(Duration::ZERO);
    process.next_id = u64::MAX - 1;
    assert!(process.next_request_id().is_ok());
    assert!(process.next_request_id().is_err());
    assert!(process.next_request_id().is_err());
    assert_eq!(process.next_id, u64::MAX);
}

#[test]
fn sequenced_wire_mapping_keeps_cancellation_before_dispatch_and_releases_both_ids() {
    let mut process = process(Duration::ZERO);
    process.request_id_mode = RequestIdMode::MonotonicV1;
    process.instance = Some(
        taomni_plugin_api::services::HostInstanceId::parse("a1234567-1234-1234-1234-123456789abc")
            .unwrap(),
    );
    let handle = process.cancellation_handle();
    let id = RequestId::from("core/host/operation-uuid");
    assert!(handle.register(&id));
    assert!(handle.cancel(&id));
    assert!(matches!(
        process.invoke_with_id(id.clone(), "ping", None),
        Err(HostProcessError::Cancelled)
    ));
    assert!(!handle.cancel(&id));
    assert!(!handle.cancel(&RequestId::from(
        "core/a1234567-1234-1234-1234-123456789abc/1"
    )));
}
