//! Confirm kernel process ownership after SIGKILL; zombies hold no address space.
use std::{
    io,
    process::Child,
    time::{Duration, Instant},
};

#[cfg(target_os = "macos")]
#[path = "termination_macos.rs"]
mod macos;
#[cfg(target_os = "macos")]
use macos::group_has_live_processes;

pub(super) fn wait(
    child: &mut Child,
    group: Option<libc::pid_t>,
    deadline: Instant,
) -> io::Result<()> {
    loop {
        let leader_exited = child.try_wait()?.is_some();
        if leader_exited
            && group
                .map(group_has_live_processes)
                .transpose()?
                .is_none_or(|live| !live)
        {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "plugin process tree termination not confirmed",
            ));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(target_os = "linux")]
fn group_has_live_processes(group: libc::pid_t) -> io::Result<bool> {
    for entry in std::fs::read_dir("/proc")? {
        let entry = entry?;
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<libc::pid_t>().ok())
        else {
            continue;
        };
        if unsafe { libc::getpgid(pid) } != group {
            continue;
        }
        let stat = match std::fs::read_to_string(entry.path().join("stat")) {
            Ok(stat) => stat,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        let state = stat
            .rsplit_once(')')
            .and_then(|(_, fields)| fields.split_whitespace().next());
        if !matches!(state, Some("Z" | "X")) {
            return Ok(true);
        }
    }
    Ok(false)
}
