//! Real process-tree fixture. The hello plugin owns protocol behavior; this
//! wrapper adds a child and grandchild without relying on a platform shell.

use std::process::{Command, ExitCode, Stdio};
use std::time::Duration;

fn record(role: &str, pid: u32) {
    let path = std::env::var_os("TAOMNI_GATE_TREE_PID_FILE").expect("PID receipt path");
    taomni_host_gates::process_receipts::record(std::path::Path::new(&path), role, pid)
        .expect("publish complete PID receipt");
}

fn main() -> ExitCode {
    let role = std::env::args().nth(1).unwrap_or_default();
    if role == "--grandchild" {
        record("grandchild", std::process::id());
        loop {
            std::thread::sleep(Duration::from_secs(60));
        }
    }
    if role == "--child" {
        record("child", std::process::id());
        let mut grandchild = Command::new(std::env::current_exe().expect("fixture path"))
            .arg("--grandchild")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn grandchild");
        let _ = grandchild.wait();
        return ExitCode::SUCCESS;
    }
    record("host", std::process::id());
    let mut child = Command::new(std::env::current_exe().expect("fixture path"))
        .arg("--child")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn child");
    let mut hello = Command::new(std::env::var_os("TAOMNI_HELLO_PLUGIN_BIN").expect("hello path"))
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("spawn real hello plugin");
    record("hello", hello.id());
    let result = hello.wait().expect("wait hello plugin");
    let _ = child.kill();
    let _ = child.wait();
    ExitCode::from(result.code().unwrap_or(1) as u8)
}
