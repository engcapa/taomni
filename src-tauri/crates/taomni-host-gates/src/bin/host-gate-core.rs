//! Disposable core process used to prove cleanup after an abrupt core death.

use std::path::PathBuf;
use std::time::Duration;

use taomni_host_gates::host::{HostProcess, HostSupervisorConfig, HostTick};

fn main() {
    let mut arguments = std::env::args_os().skip(1);
    let host = PathBuf::from(arguments.next().expect("host path"));
    let ready = PathBuf::from(arguments.next().expect("readiness path"));
    let mut process = HostProcess::start(
        "taomni-plugin-hello-plugin",
        "0.1.0",
        &host,
        host.parent().expect("host parent"),
        &["hello/ping".into()],
        &[],
        HostSupervisorConfig::default(),
    )
    .expect("start real hello plugin");
    let value = process
        .invoke("hello/ping", None)
        .expect("ping real hello plugin");
    std::fs::write(ready, serde_json::to_vec(&value).expect("ping receipt")).expect("readiness");
    loop {
        match process.tick() {
            HostTick::RestartReady { .. } => {
                process.restart().expect("restart host");
            }
            HostTick::RestartExhausted | HostTick::Stopped => panic!("unexpected host termination"),
            _ => {}
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}
