mod support;

use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

struct DisposableCore(Child);

impl Drop for DisposableCore {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

struct TreeDirectory(Option<tempfile::TempDir>);

impl TreeDirectory {
    fn new(prefix: &str) -> Self {
        let mut builder = tempfile::Builder::new();
        builder.prefix(prefix);
        let directory = match std::env::var_os("TAOMNI_GATE_EVIDENCE_DIR") {
            Some(root) => builder.tempdir_in(root),
            None => builder.tempdir(),
        };
        Self(Some(
            directory.expect("owned process-tree evidence directory"),
        ))
    }

    fn path(&self) -> &std::path::Path {
        self.0.as_ref().unwrap().path()
    }
}

impl Drop for TreeDirectory {
    fn drop(&mut self) {
        if std::thread::panicking() {
            let path = self.0.take().unwrap().keep();
            eprintln!("Preserved failed process-tree evidence: {}", path.display());
        }
    }
}

fn wait_for_tree(core: &mut DisposableCore, ready: &std::path::Path, pids: &std::path::Path) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        assert!(
            core.0.try_wait().unwrap().is_none(),
            "core exited before tree readiness"
        );
        let receipt = support::receipt(pids);
        if ready.exists()
            && ["host", "hello", "child", "grandchild"]
                .iter()
                .all(|role| receipt.iter().any(|(record, _)| record == role))
        {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "timed out before full tree readiness: core={}, ready={}, receipts={receipt:?}",
            core.0.id(),
            ready.exists()
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
#[ignore = "cross-process gate: execute only on GitHub hosted runners"]
fn killing_the_core_cleans_the_real_host_child_and_grandchild() {
    let directory = TreeDirectory::new("cleanup-core-kill-");
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
    wait_for_tree(&mut core, &ready, &pids);
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
    let directory = TreeDirectory::new("cleanup-confirmed-stop-");
    let ready = directory.path().join("ready.json");
    let pids = directory.path().join("processes.txt");
    let mut core = DisposableCore(
        Command::new(env!("CARGO_BIN_EXE_host-gate-core"))
            .arg(env!("CARGO_BIN_EXE_host-gate-tree"))
            .arg(&ready)
            .arg("--confirmed-stop")
            .env("TAOMNI_HELLO_PLUGIN_BIN", support::hello())
            .env("TAOMNI_GATE_TREE_PID_FILE", &pids)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap(),
    );
    wait_for_tree(&mut core, &ready, &pids);
    let descendants = support::receipt(&pids);
    assert!(
        descendants
            .iter()
            .all(|(_, pid)| support::process_alive(*pid))
    );
    core.0.stdin.take().unwrap().write_all(b"x").unwrap();
    let mut exit = None;
    support::wait_for(
        || {
            exit = core.0.try_wait().unwrap();
            exit.is_some()
        },
        "confirmed stop core completion",
    );
    assert!(exit.unwrap().success());
    assert_eq!(
        std::fs::read(ready.with_extension("stopped")).unwrap(),
        b"confirmed"
    );
    for (role, pid) in descendants {
        assert!(
            !support::process_alive(pid),
            "{role} still alive after stop confirmed: {pid}"
        );
    }
}
