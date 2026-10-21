#[cfg(unix)]
use super::environment::apply_terminal_environment;
use super::shells::resolve_shell_with_id;
use portable_pty::CommandBuilder;
use portable_pty::PtySize;
use portable_pty::native_pty_system;
use std::ffi::OsString;
use std::io::Read;

pub struct PtyHandle {
    pub writer: Box<dyn std::io::Write + Send>,
    pub reader_thread: Option<std::thread::JoinHandle<()>>,
    pub child: Box<dyn portable_pty::Child + Send + Sync>,
    pub master: Box<dyn portable_pty::MasterPty + Send>,
}

pub fn create_pty(
    cols: u16,
    rows: u16,
    shell: Option<String>,
    shell_args: Option<Vec<String>>,
    cwd: Option<String>,
) -> Result<(PtyHandle, Box<dyn Read + Send>, String), String> {
    create_pty_with_environment(cols, rows, shell, shell_args, cwd, None)
}

pub fn create_pty_with_environment(
    cols: u16,
    rows: u16,
    shell: Option<String>,
    shell_args: Option<Vec<String>>,
    cwd: Option<String>,
    sdk_environment: Option<&crate::sdk::WorkspaceSdkEnvironment>,
) -> Result<(PtyHandle, Box<dyn Read + Send>, String), String> {
    let (shell_launch, shell_id) = resolve_shell_with_id(shell, shell_args);
    let integration = super::super::shell_integration::integration_for(
        &shell_launch.program,
        &shell_id,
        &shell_launch.args,
    );
    let (handle, reader) = create_pty_for_launch(
        cols,
        rows,
        &shell_launch.program,
        &shell_launch.args,
        Some(integration),
        cwd,
        sdk_environment,
        None,
    )?;

    Ok((handle, reader, shell_id))
}

pub fn create_command_pty(
    cols: u16,
    rows: u16,
    program: &str,
    args: &[String],
) -> Result<(PtyHandle, Box<dyn Read + Send>), String> {
    create_pty_for_launch(cols, rows, program, args, None, None, None, None)
}

/// Launch a command in a real controlling PTY with a small, explicit set of
/// environment overrides. Used by SocksCap launch-only mode for interactive
/// TUI applications; it deliberately does not invoke a shell.
#[cfg(target_os = "linux")]
pub fn create_command_pty_with_environment(
    cols: u16,
    rows: u16,
    program: &str,
    args: &[String],
    environment: &[(OsString, OsString)],
) -> Result<(PtyHandle, Box<dyn Read + Send>), String> {
    create_command_pty_with_launch_options(cols, rows, program, args, None, environment)
}

/// Launch a Linux command in a controlling PTY with explicit cwd and
/// environment overrides. SocksCap uses this so preparation state is shared by
/// its trace launcher, shell wrapper, and final TUI process.
#[cfg(target_os = "linux")]
pub fn create_command_pty_with_launch_options(
    cols: u16,
    rows: u16,
    program: &str,
    args: &[String],
    cwd: Option<String>,
    environment: &[(OsString, OsString)],
) -> Result<(PtyHandle, Box<dyn Read + Send>), String> {
    create_pty_for_launch(
        cols,
        rows,
        program,
        args,
        None,
        cwd,
        None,
        Some(environment),
    )
}

pub(super) fn create_pty_for_launch(
    cols: u16,
    rows: u16,
    program: &str,
    args: &[String],
    integration: Option<super::super::shell_integration::Integration>,
    cwd: Option<String>,
    sdk_environment: Option<&crate::sdk::WorkspaceSdkEnvironment>,
    environment: Option<&[(OsString, OsString)]>,
) -> Result<(PtyHandle, Box<dyn Read + Send>), String> {
    let pty_system = native_pty_system();

    let size = PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    };

    let pair = pty_system
        .openpty(size)
        .map_err(|e| format!("Failed to open PTY: {}", e))?;

    let mut cmd = CommandBuilder::new(program);
    for arg in args {
        cmd.arg(arg);
    }
    // Shell-integration args (e.g. PowerShell's `-NoExit -Command ". '<script>'"`)
    // go after the shell's own args so OSC 7 cwd reporting is installed once the
    // shell is interactive.
    let integration = integration.unwrap_or_default();
    {
        for arg in &integration.extra_args {
            cmd.arg(arg);
        }
    }

    #[cfg(unix)]
    apply_terminal_environment(&mut cmd);

    if let Some(sdk_environment) = sdk_environment {
        for (key, value) in &sdk_environment.environment {
            cmd.env(key, value);
        }
        if let Some(path) = sdk_environment.prepend_path(std::env::var_os("PATH").as_deref()) {
            cmd.env("PATH", path);
        }
    }

    if let Some(environment) = environment {
        for (key, value) in environment {
            cmd.env(key, value);
        }
    }

    // Shell-integration env (e.g. bash's `PROMPT_COMMAND`). Set after the
    // terminal environment so it can't be clobbered by it.
    for (key, value) in &integration.env {
        cmd.env(key, value);
    }

    if let Some(dir) = cwd {
        cmd.cwd(dir);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn shell: {}", e))?;

    // Must drop slave so master reads work properly
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone PTY reader: {}", e))?;

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to take PTY writer: {}", e))?;

    let handle = PtyHandle {
        writer,
        reader_thread: None,
        child,
        master: pair.master,
    };

    Ok((handle, reader))
}

pub fn resize_pty(
    master: &dyn portable_pty::MasterPty,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to resize PTY: {}", e))
}
