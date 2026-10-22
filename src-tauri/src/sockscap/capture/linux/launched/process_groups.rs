use super::model::LaunchedAppPhase;
use super::model::LaunchedProcess;
use std::sync::atomic::Ordering;
use std::time::Duration;

pub(super) fn process_group_is_alive(process_group: libc::pid_t) -> bool {
    let result = unsafe { libc::kill(-process_group, 0) };
    result == 0 || std::io::Error::last_os_error().kind() == std::io::ErrorKind::PermissionDenied
}

pub(super) fn kill_process_group(process_group: libc::pid_t) {
    unsafe { libc::kill(-process_group, libc::SIGKILL) };
}

pub(super) async fn stop_process_group(process: &mut LaunchedProcess) -> Result<(), String> {
    if process_group_is_alive(process.process_group) {
        let result = unsafe { libc::kill(-process.process_group, libc::SIGTERM) };
        if result < 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                return Err(format!(
                    "stop launched application PID {}: {error}",
                    process.info.pid
                ));
            }
        }
        for _ in 0..20 {
            if !process_group_is_alive(process.process_group) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        if process_group_is_alive(process.process_group) {
            let result = unsafe { libc::kill(-process.process_group, libc::SIGKILL) };
            if result < 0 {
                let error = std::io::Error::last_os_error();
                if error.raw_os_error() != Some(libc::ESRCH) {
                    return Err(format!(
                        "force-stop launched application PID {}: {error}",
                        process.info.pid
                    ));
                }
            }
        }
    }
    process.info.running = false;
    process.info.phase = LaunchedAppPhase::Exited;
    process.info.launch_error = None;
    if let Some(running) = &process.terminal_running {
        running.store(false, Ordering::Release);
    }
    Ok(())
}
