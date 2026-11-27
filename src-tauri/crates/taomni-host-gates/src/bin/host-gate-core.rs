//! Disposable core process used to prove cleanup after an abrupt core death.

use std::io::Read;
use std::path::PathBuf;
use std::time::Duration;

use taomni_host_gates::host::{
    HostProcess, HostSupervisorConfig, HostTick, PLUGIN_WATCHDOG_ARG,
    enable_plugin_watchdog_exec, run_plugin_watchdog,
};

fn main() {
    let mut arguments = std::env::args_os().skip(1);
    let first = arguments.next();
    if first.as_deref().and_then(std::ffi::OsStr::to_str) == Some(PLUGIN_WATCHDOG_ARG) {
        std::process::exit(run_plugin_watchdog(arguments));
    }
    let host = PathBuf::from(first.expect("host path"));
    let ready = PathBuf::from(arguments.next().expect("readiness path"));
    let confirmed_stop = arguments
        .next()
        .is_some_and(|arg| arg == "--confirmed-stop");
    enable_plugin_watchdog_exec();
    let (stop_sender, stop_receiver) = std::sync::mpsc::channel();
    if confirmed_stop {
        std::thread::spawn(move || {
            let mut byte = [0u8];
            if std::io::stdin().read_exact(&mut byte).is_ok() {
                let _ = stop_sender.send(());
            }
        });
    }
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
    std::fs::write(&ready, serde_json::to_vec(&value).expect("ping receipt")).expect("readiness");
    loop {
        if confirmed_stop && stop_receiver.try_recv().is_ok() {
            process
                .stop_confirmed(std::time::Instant::now() + Duration::from_secs(5))
                .expect("confirmed tree termination");
            std::fs::write(ready.with_extension("stopped"), b"confirmed")
                .expect("termination receipt");
            return;
        }
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
