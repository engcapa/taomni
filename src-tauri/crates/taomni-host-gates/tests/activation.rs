//! Error paths use real pipes and kernel ownership; local runs only compile.
mod support;
use std::time::{Duration, Instant};
use taomni_host_gates::host::{HostProcess, HostProcessError, HostSupervisorConfig};
use taomni_plugin_api::ErrorCode;

fn start(root: &std::path::Path, hook: bool) -> Result<HostProcess, HostProcessError> {
    let mut commands = vec!["fixture/probe".into()];
    if hook {
        commands.push("plugin/enable".into());
    }
    HostProcess::start(
        "taomni-plugin-activation-fixture",
        "0.1.0",
        std::path::Path::new(env!("CARGO_BIN_EXE_host-gate-activation")),
        root,
        &commands,
        &[],
        HostSupervisorConfig {
            request_timeout: Duration::from_secs(2),
            heartbeat_timeout: Duration::from_secs(5),
            ..support::config()
        },
    )
}

fn assert_failed_host_exited(root: &std::path::Path) {
    let pid = std::fs::read_to_string(root.join("activation.pid"))
        .unwrap()
        .parse()
        .unwrap();
    support::wait_for(|| !support::process_alive(pid), "failed activation exits");
    assert_eq!(
        std::fs::read_to_string(root.join("activation.events")).unwrap(),
        "plugin/handshake\nplugin/enable\n"
    );
}

#[test]
#[ignore = "cross-process gate: execute only on GitHub hosted runners"]
fn a_rejected_enable_hook_fails_startup_and_releases_the_real_process() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("activation.mode"), "reject").unwrap();
    assert_eq!(
        start(root.path(), true).unwrap_err().rpc_code(),
        ErrorCode::InvalidState.as_i32()
    );
    assert_failed_host_exited(root.path());
}

#[test]
#[ignore = "cross-process gate: execute only on GitHub hosted runners"]
fn a_hung_enable_hook_respects_the_startup_deadline_and_releases_the_process() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("activation.mode"), "hang").unwrap();
    let started = Instant::now();
    assert_eq!(
        start(root.path(), true).unwrap_err().rpc_code(),
        ErrorCode::RequestTimeout.as_i32()
    );
    assert!(started.elapsed() < Duration::from_secs(5));
    assert_failed_host_exited(root.path());
}

#[test]
#[ignore = "cross-process gate: execute only on GitHub hosted runners"]
fn protocol_v1_hosts_without_a_declared_hook_receive_no_activation_request() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("activation.mode"), "reject").unwrap();
    let mut process = start(root.path(), false).unwrap();
    assert_eq!(
        process.invoke("fixture/probe", None).unwrap()["enabled"],
        false
    );
    assert_eq!(
        std::fs::read_to_string(root.path().join("activation.events")).unwrap(),
        "plugin/handshake\nfixture/probe\n"
    );
    process
        .stop_confirmed(Instant::now() + Duration::from_secs(5))
        .unwrap();
}
