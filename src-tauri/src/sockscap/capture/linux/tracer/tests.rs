use super::event_loop::wait_for_trace_wake;
use super::event_loop::wake_trace_loop;
use super::flows::FlowQueue;
use super::flows::ProcessIdentity;
use super::flows::TracedFlow;
use super::network::connect_started;
use super::preflight::preflight;
use super::sockets::decode_socket_address;
use super::sockets::encode_loopback;
use super::supervisor::LaunchCommand;
use super::supervisor::LaunchLifecycle;
use super::supervisor::LaunchStatus;
use super::supervisor::TracerSupervisor;
use std::net::SocketAddr;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;

#[test]
fn trace_wake_socket_buffers_commands_and_sigchld() {
    let (mut reader, writer) = UnixStream::pair().unwrap();
    reader
        .set_read_timeout(Some(Duration::from_secs(1)))
        .unwrap();
    let signal_registration = signal_hook::low_level::pipe::register(
        signal_hook::consts::signal::SIGCHLD,
        writer.try_clone().unwrap(),
    )
    .unwrap();

    wake_trace_loop(&writer);
    wait_for_trace_wake(&mut reader).unwrap();

    let mut child = Command::new("/bin/true").spawn().unwrap();
    assert!(child.wait().unwrap().success());
    wait_for_trace_wake(&mut reader).unwrap();

    assert!(signal_hook::low_level::unregister(signal_registration));
}

#[test]
fn traced_signal_burst_is_resumed_without_polling_delay() {
    let launcher = PathBuf::from(concat!(env!("OUT_DIR"), "/taomni-sockscap-trace-launcher"));
    if let Err(error) = preflight(&launcher) {
        eprintln!("skipping rootless ptrace latency test: {error}");
        return;
    }

    let mut tracer = TracerSupervisor::start(9, false, Arc::new(FlowQueue::default())).unwrap();
    let launch = LaunchCommand {
        executable: PathBuf::from("/bin/sh"),
        args: vec![
            "-c".into(),
            "i=0; while [ \"$i\" -lt 500 ]; do kill -URG $$; i=$((i + 1)); done".into(),
        ],
        working_directory: None,
        environment: Vec::new(),
    };
    let pid = tracer.spawn_desktop(&launcher, &launch).unwrap();
    let started = Instant::now();
    tracer
        .register_root(
            pid,
            ProcessIdentity {
                profile_id: "signal-latency-test".into(),
                configured_path: "/bin/sh".into(),
            },
            1,
        )
        .unwrap();

    let deadline = started + Duration::from_secs(3);
    loop {
        match tracer.launch_status(pid) {
            Some(LaunchStatus::Exited) => break,
            Some(LaunchStatus::Failed(error)) => {
                panic!("traced signal process failed: {error}")
            }
            _ if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(1)),
            status => panic!("traced signal process did not exit: {status:?}"),
        }
    }
    let elapsed = started.elapsed();
    tracer.shutdown();

    assert!(
        elapsed < Duration::from_millis(750),
        "500 traced SIGURG deliveries took {elapsed:?}; ptrace stops appear to be polled"
    );
}

#[test]
fn launch_lifecycle_requires_the_target_exec_and_preserves_preparation_failure() {
    let mut prepared = LaunchLifecycle::new(2);
    prepared.observe_exec();
    assert_eq!(prepared.status, LaunchStatus::Preparing);
    prepared.observe_exec();
    assert_eq!(prepared.status, LaunchStatus::Running);
    prepared.finish("normal exit".into());
    assert_eq!(prepared.status, LaunchStatus::Exited);

    let mut failed = LaunchLifecycle::new(2);
    failed.observe_exec();
    failed.finish("pre-command exited with status 7".into());
    assert_eq!(
        failed.status,
        LaunchStatus::Failed("pre-command exited with status 7".into())
    );
}

#[test]
fn rewrites_ipv4_sockaddr_to_loopback_without_changing_destination_port() {
    let destination: SocketAddr = "93.184.216.34:443".parse().unwrap();
    let bytes =
        encode_loopback(destination, 43123, std::mem::size_of::<libc::sockaddr_in>()).unwrap();
    assert_eq!(
        decode_socket_address(&bytes).unwrap(),
        "127.0.0.1:43123".parse().unwrap()
    );
}

#[test]
fn rewrites_ipv6_sockaddr_to_loopback_without_changing_destination_port() {
    let destination: SocketAddr = "[2001:db8::1]:8443".parse().unwrap();
    let bytes = encode_loopback(
        destination,
        43123,
        std::mem::size_of::<libc::sockaddr_in6>(),
    )
    .unwrap();
    assert_eq!(
        decode_socket_address(&bytes).unwrap(),
        "[::1]:43123".parse().unwrap()
    );
}

#[test]
fn only_new_or_in_progress_connects_expect_an_ingress_accept() {
    assert!(connect_started(0));
    assert!(connect_started(-(libc::EINPROGRESS as i64)));
    assert!(!connect_started(-(libc::EALREADY as i64)));
    assert!(!connect_started(-(libc::EISCONN as i64)));
    assert!(!connect_started(-(libc::ECONNREFUSED as i64)));
}

#[tokio::test]
async fn flow_queue_preserves_serialized_connect_order() {
    let queue = Arc::new(FlowQueue::default());
    let first = queue
        .push(TracedFlow {
            destination: "192.0.2.1:80".parse().unwrap(),
            pid: 1,
            process_path: "/first".into(),
            profile_id: "a".into(),
        })
        .unwrap();
    let second = queue
        .push(TracedFlow {
            destination: "192.0.2.2:443".parse().unwrap(),
            pid: 2,
            process_path: "/second".into(),
            profile_id: "b".into(),
        })
        .unwrap();

    assert_eq!(
        queue
            .wait_take(Duration::from_millis(10))
            .await
            .unwrap()
            .pid,
        1
    );
    assert!(queue.wait_claimed(first, Duration::from_millis(10)));
    assert!(!queue.wait_claimed(second, Duration::from_millis(1)));
    assert_eq!(
        queue
            .wait_take(Duration::from_millis(10))
            .await
            .unwrap()
            .pid,
        2
    );
}
