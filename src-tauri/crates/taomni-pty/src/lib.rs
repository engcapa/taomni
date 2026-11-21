//! Local terminal primitives shared by the core and independent module hosts.

mod environment;
mod lifetime;
pub mod shell_integration;
mod shells;
mod windows_shells;

#[cfg(all(test, target_os = "macos"))]
mod macos_tests;

pub use lifetime::{
    PtyHandle, create_command_pty, create_pty, create_pty_with_environment, resize_pty,
};
#[cfg(target_os = "linux")]
pub use lifetime::{create_command_pty_with_environment, create_command_pty_with_launch_options};
pub use shells::{
    LocalShellOption, ShellLaunch, list_local_shells, resolve_shell, resolve_shell_with_id,
};
pub use windows_shells::open_shell_as_administrator;
