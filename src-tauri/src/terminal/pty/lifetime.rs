//! Apply workspace SDK settings before starting a shared local PTY.

use std::{ffi::OsString, io::Read};

pub use taomni_pty::{PtyHandle, create_command_pty, create_pty, resize_pty};

#[cfg(target_os = "linux")]
pub use taomni_pty::{create_command_pty_with_environment, create_command_pty_with_launch_options};

pub fn create_pty_with_environment(
    cols: u16,
    rows: u16,
    shell: Option<String>,
    shell_args: Option<Vec<String>>,
    cwd: Option<String>,
    sdk_environment: Option<&crate::sdk::WorkspaceSdkEnvironment>,
) -> Result<(PtyHandle, Box<dyn Read + Send>, String), String> {
    let environment = sdk_environment.map_or_else(Vec::new, |sdk| {
        let mut environment: Vec<(OsString, OsString)> = sdk
            .environment
            .iter()
            .map(|(key, value)| (key.into(), value.into()))
            .collect();
        if let Some(path) = sdk.prepend_path(std::env::var_os("PATH").as_deref()) {
            environment.push(("PATH".into(), path));
        }
        environment
    });
    taomni_pty::create_pty_with_environment(cols, rows, shell, shell_args, cwd, &environment)
}
