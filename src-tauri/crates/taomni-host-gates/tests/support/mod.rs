use std::path::PathBuf;
use std::time::{Duration, Instant};

use taomni_host_gates::host::{HostProcess, HostSupervisorConfig, HostTick};

pub fn hello() -> PathBuf {
    let path = PathBuf::from(
        std::env::var_os("TAOMNI_HELLO_PLUGIN_BIN")
            .expect("hosted gates require TAOMNI_HELLO_PLUGIN_BIN"),
    );
    assert!(path.is_absolute(), "hello fixture path must be absolute");
    assert!(
        path.is_file(),
        "hello fixture binary is missing: {}",
        path.display()
    );
    path
}

pub fn config() -> HostSupervisorConfig {
    HostSupervisorConfig {
        request_timeout: Duration::from_secs(3),
        heartbeat_timeout: Duration::from_millis(600),
        max_restarts: 2,
        restart_window: Duration::from_secs(60),
        restart_backoff: Duration::from_millis(30),
    }
}

pub fn start(config: HostSupervisorConfig) -> HostProcess {
    let host = hello();
    HostProcess::start(
        "taomni-plugin-hello-plugin",
        "0.1.0",
        &host,
        host.parent().unwrap(),
        &[
            "hello/ping".into(),
            "hello/crash".into(),
            "hello/hang".into(),
            "plugin/enable".into(),
            "plugin/disable".into(),
        ],
        &[],
        config,
    )
    .expect("start real hello plugin")
}

pub fn wait_for(mut predicate: impl FnMut() -> bool, description: &str) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !predicate() {
        assert!(Instant::now() < deadline, "timed out: {description}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

pub fn restart(process: &mut HostProcess) {
    wait_for(
        || matches!(process.tick(), HostTick::RestartReady { .. }),
        "restart ready",
    );
    process.restart().expect("restart hello host");
}

#[cfg(unix)]
pub fn process_alive(pid: u32) -> bool {
    #[cfg(target_os = "linux")]
    {
        if let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) {
            // Container init processes do not always reap orphan zombies
            // promptly. A zombie cannot run or retain the plugin's resources.
            if stat
                .rsplit_once(')')
                .is_some_and(|(_, tail)| tail.trim_start().starts_with('Z'))
            {
                return false;
            }
        }
    }
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

#[cfg(windows)]
pub fn process_alive(pid: u32) -> bool {
    use windows::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    let Ok(handle) = (unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }) else {
        return false;
    };
    let mut code = 0;
    let running =
        unsafe { GetExitCodeProcess(handle, &mut code) }.is_ok() && code == STILL_ACTIVE.0 as u32;
    unsafe {
        let _ = CloseHandle(handle);
    }
    running
}

pub fn receipt(path: &std::path::Path) -> Vec<(String, u32)> {
    taomni_host_gates::process_receipts::read(path).expect("read complete process receipts")
}
