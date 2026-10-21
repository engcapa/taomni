use super::event_loop::initialize_tracee;
use super::limits::PREFLIGHT_POLL_INTERVAL;
use super::limits::TRACE_START_TIMEOUT;
use super::process::ptrace_resume;
use std::path::Path;
use std::process::Command;
use std::time::Instant;

/// Verify both ptrace supervision and a seccomp TRACE event with the exact
/// launcher that will be used for applications.
pub fn preflight(launcher: &Path) -> Result<(), String> {
    if !cfg!(any(target_arch = "x86_64", target_arch = "aarch64")) {
        return Err(format!(
            "Linux rootless application capture is unsupported on {}",
            std::env::consts::ARCH
        ));
    }
    let child = Command::new(launcher)
        .arg("--preflight")
        .spawn()
        .map_err(|error| format!("start ptrace/seccomp preflight: {error}"))?;
    let pid = child.id() as libc::pid_t;
    drop(child);
    let deadline = Instant::now() + TRACE_START_TIMEOUT;
    let mut saw_seccomp = false;
    loop {
        let mut status = 0;
        let waited = unsafe {
            libc::waitpid(
                pid,
                &mut status,
                libc::WNOHANG | libc::WUNTRACED | libc::__WALL,
            )
        };
        if waited < 0 {
            return Err(format!(
                "wait for ptrace/seccomp preflight: {}",
                std::io::Error::last_os_error()
            ));
        }
        if waited == 0 {
            if Instant::now() >= deadline {
                unsafe { libc::kill(pid, libc::SIGKILL) };
                let _ = unsafe { libc::waitpid(pid, &mut status, 0) };
                return Err("ptrace/seccomp preflight timed out".into());
            }
            std::thread::sleep(PREFLIGHT_POLL_INTERVAL);
            continue;
        }
        if libc::WIFEXITED(status) {
            return if libc::WEXITSTATUS(status) == 0 && saw_seccomp {
                Ok(())
            } else {
                Err(
                    "current Linux container or kernel forbids unprivileged ptrace/seccomp capture"
                        .into(),
                )
            };
        }
        if libc::WIFSIGNALED(status) {
            return Err(format!(
                "ptrace/seccomp preflight was terminated by signal {}",
                libc::WTERMSIG(status)
            ));
        }
        if !libc::WIFSTOPPED(status) {
            continue;
        }
        let event = status >> 16;
        if !saw_seccomp && event == 0 && libc::WSTOPSIG(status) == libc::SIGSTOP {
            initialize_tracee(pid)?;
        } else if event == libc::PTRACE_EVENT_SECCOMP {
            saw_seccomp = true;
        }
        ptrace_resume(pid, libc::PTRACE_CONT, 0)?;
    }
}
