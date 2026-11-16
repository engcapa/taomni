mod support;

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::io::Write;

struct DisposableCore(Child);

impl Drop for DisposableCore {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
#[ignore = "cross-process gate: execute only on GitHub hosted runners"]
fn killing_the_core_cleans_the_real_host_child_and_grandchild() {
    let directory = tempfile::tempdir().unwrap();
    let ready = directory.path().join("ready.json");
    let pids = directory.path().join("processes.txt");
    let tree = PathBuf::from(env!("CARGO_BIN_EXE_host-gate-tree"));
    let mut core = DisposableCore(
        Command::new(env!("CARGO_BIN_EXE_host-gate-core"))
            .arg(&tree)
            .arg(&ready)
            .env("TAOMNI_HELLO_PLUGIN_BIN", support::hello())
            .env("TAOMNI_GATE_TREE_PID_FILE", &pids)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("spawn disposable core"),
    );
    support::wait_for(
        || {
            assert!(
                core.0.try_wait().unwrap().is_none(),
                "disposable core exited before readiness"
            );
            let receipt = support::receipt(&pids);
            ready.exists()
                && ["host", "hello", "child", "grandchild"]
                    .iter()
                    .all(|role| receipt.iter().any(|(record, _)| record == role))
        },
        "core and descendant readiness",
    );
    let descendants = support::receipt(&pids);
    for (role, pid) in &descendants {
        assert!(
            support::process_alive(*pid),
            "{role} must be alive before killing core"
        );
    }
    core.0.kill().expect("abruptly kill core without Drop");
    core.0.wait().unwrap();
    support::wait_for(
        || {
            descendants
                .iter()
                .all(|(_, pid)| !support::process_alive(*pid))
        },
        "all descendants cleaned after core death",
    );
    for (role, pid) in descendants {
        assert!(!support::process_alive(pid), "orphan {role} PID {pid}");
    }
}

#[test]
#[ignore = "cross-process confirmed termination gate: GitHub hosted runners only"]
fn confirmed_stop_observes_real_host_child_and_grandchild_exit_before_returning() {
    let directory = tempfile::tempdir().unwrap();
    let ready = directory.path().join("ready.json");
    let pids = directory.path().join("processes.txt");
    let mut core = DisposableCore(Command::new(env!("CARGO_BIN_EXE_host-gate-core"))
        .arg(env!("CARGO_BIN_EXE_host-gate-tree")).arg(&ready).arg("--confirmed-stop")
        .env("TAOMNI_HELLO_PLUGIN_BIN", support::hello())
        .env("TAOMNI_GATE_TREE_PID_FILE", &pids)
        .stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::inherit())
        .spawn().unwrap());
    support::wait_for(|| {
        assert!(core.0.try_wait().unwrap().is_none(), "core exited before tree readiness");
        let receipt = support::receipt(&pids);
        ready.exists() && ["host", "hello", "child", "grandchild"].iter()
            .all(|role| receipt.iter().any(|(record, _)| record == role))
    }, "full tree before confirmed stop");
    let descendants = support::receipt(&pids);
    assert!(descendants.iter().all(|(_, pid)| support::process_alive(*pid)));
    core.0.stdin.take().unwrap().write_all(b"x").unwrap();
    let mut exit = None;
    support::wait_for(|| { exit = core.0.try_wait().unwrap(); exit.is_some() }, "confirmed stop core completion");
    assert!(exit.unwrap().success());
    assert_eq!(std::fs::read(ready.with_extension("stopped")).unwrap(), b"confirmed");
    for (role, pid) in descendants {
        assert!(!support::process_alive(pid), "{role} still alive after stop confirmed: {pid}");
    }
}
