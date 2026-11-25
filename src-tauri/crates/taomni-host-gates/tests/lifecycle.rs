mod support;

use std::time::{Duration, Instant};

use taomni_host_gates::host::{HostProcessError, HostState, HostTick};
use taomni_plugin_api::{ErrorCode, RequestId};

#[test]
#[ignore = "cross-process gate: execute only on GitHub hosted runners"]
fn startup_waits_for_the_declared_enable_hook_before_returning_the_host() {
    let mut process = support::start(support::config());
    let identity = process.invoke("hello/ping", None).unwrap();
    assert_eq!(identity["pluginId"], "taomni-plugin-hello-plugin");
    assert_eq!(identity["version"], "0.1.0");
    assert_eq!(identity["enabled"], true);
    process
        .stop_confirmed(Instant::now() + Duration::from_secs(5))
        .unwrap();
    assert_eq!(process.state(), HostState::Stopped);
}

#[test]
#[ignore = "cross-process gate: execute only on GitHub hosted runners"]
fn idle_heartbeats_keep_the_real_host_alive_and_stop_is_final() {
    let mut process = support::start(support::config());
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        assert_eq!(process.tick(), HostTick::Healthy);
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(
        process
            .invoke_with_id(RequestId::from("renderer-id"), "hello/ping", None)
            .is_ok()
    );
    process.stop();
    assert_eq!(process.state(), HostState::Stopped);
    assert_eq!(process.tick(), HostTick::Stopped);
}

#[test]
#[ignore = "cross-process gate: execute only on GitHub hosted runners"]
fn returning_from_the_spawn_calling_thread_does_not_kill_the_host() {
    let mut process = std::thread::spawn(|| support::start(support::config()))
        .join()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        assert_eq!(process.tick(), HostTick::Healthy);
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(process.invoke("hello/ping", None).is_ok());
}

#[test]
#[ignore = "cross-process gate: execute only on GitHub hosted runners"]
fn crash_restart_keeps_one_budget_and_never_replays_the_failed_command() {
    let mut process = support::start(support::config());
    for _ in 0..2 {
        assert!(matches!(
            process.invoke("hello/crash", None),
            Err(HostProcessError::Crashed)
        ));
        support::restart(&mut process);
        assert_eq!(process.invoke("hello/ping", None).unwrap()["enabled"], true);
    }
    assert!(process.invoke("hello/crash", None).is_err());
    assert_eq!(process.tick(), HostTick::RestartExhausted);
    assert!(process.restart().is_err());
}

#[test]
#[ignore = "cross-process gate: execute only on GitHub hosted runners"]
fn hung_operation_cancels_while_invoke_owns_the_process_and_can_recover() {
    let mut process = support::start(support::config());
    let handle = process.cancellation_handle();
    let id = RequestId::from("user-cancel");
    assert!(handle.register(&id));
    let cancel_id = id.clone();
    let canceller = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(100));
        assert!(handle.cancel(&cancel_id));
    });
    let started = Instant::now();
    let error = process
        .invoke_with_id(id.clone(), "hello/hang", None)
        .unwrap_err();
    assert_eq!(error.rpc_code(), ErrorCode::RequestCancelled.as_i32());
    assert!(started.elapsed() < Duration::from_secs(2));
    canceller.join().unwrap();
    assert!(!process.cancellation_handle().cancel(&id));
    support::restart(&mut process);
    assert!(process.invoke("hello/ping", None).is_ok());
}

#[test]
#[ignore = "cross-process gate: execute only on GitHub hosted runners"]
fn request_deadline_terminates_a_hung_host_before_heartbeat_deadline() {
    let mut config = support::config();
    config.request_timeout = Duration::from_millis(150);
    config.heartbeat_timeout = Duration::from_secs(5);
    let mut process = support::start(config);
    let started = Instant::now();
    assert!(matches!(
        process.invoke("hello/hang", None),
        Err(HostProcessError::Timeout)
    ));
    assert!(started.elapsed() < Duration::from_secs(2));
    support::restart(&mut process);
    assert!(process.invoke("hello/ping", None).is_ok());
}

#[test]
#[ignore = "cross-process gate: execute only on GitHub hosted runners"]
fn a_hung_host_is_detected_by_the_heartbeat_before_a_long_request_deadline() {
    let mut process = support::start(support::config());
    let started = Instant::now();
    assert!(matches!(
        process.invoke("hello/hang", None),
        Err(HostProcessError::Crashed)
    ));
    assert!(started.elapsed() < Duration::from_secs(2));
    support::restart(&mut process);
    assert!(process.invoke("hello/ping", None).is_ok());
}
