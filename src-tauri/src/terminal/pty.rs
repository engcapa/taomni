mod lifetime;

mod shells;

mod directories;

mod windows_shells;

mod environment;

#[cfg(test)]
mod directory_shortcut_tests;

#[cfg(all(test, target_os = "linux"))]
mod command_pty_environment_tests;

#[cfg(test)]
#[cfg(target_os = "macos")]
mod tests;

pub use lifetime::{
    PtyHandle, create_command_pty, create_pty, create_pty_with_environment, resize_pty,
};

#[cfg(target_os = "linux")]
pub use lifetime::create_command_pty_with_environment;

#[cfg(target_os = "linux")]
pub use lifetime::create_command_pty_with_launch_options;

pub use shells::{
    LocalShellOption, ShellLaunch, list_local_shells, resolve_shell, resolve_shell_with_id,
};

pub(crate) use directories::directory_from_history_command;

pub use windows_shells::open_shell_as_administrator;

/// Serializes tests that launch a real PTY. `portable-pty` forks, and two
/// concurrent forks in one multithreaded test process can deadlock the child
/// before it execs, which shows up as missing output rather than an error.
#[cfg(test)]
pub fn test_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    LOCK.lock().unwrap_or_else(|error| error.into_inner())
}
