use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
#[cfg(target_os = "macos")]
use std::ffi::OsStr;
use std::io::Read;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use std::path::Path;
use std::path::PathBuf;

pub struct PtyHandle {
    pub writer: Box<dyn std::io::Write + Send>,
    pub reader_thread: Option<std::thread::JoinHandle<()>>,
    pub child: Box<dyn portable_pty::Child + Send + Sync>,
    pub master: Box<dyn portable_pty::MasterPty + Send>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalShellOption {
    pub id: String,
    pub name: String,
    pub path: String,
    pub args: Vec<String>,
    pub is_default: bool,
    pub can_elevate: bool,
}

#[derive(Clone, Debug)]
pub struct ShellLaunch {
    pub program: String,
    pub args: Vec<String>,
}

pub fn list_local_shells() -> Vec<LocalShellOption> {
    let mut shells = platform_local_shells();

    if shells.is_empty() {
        let fallback = fallback_shell_launch();
        shells.push(LocalShellOption {
            id: "default".to_string(),
            name: "Default shell".to_string(),
            path: fallback.program,
            args: fallback.args,
            is_default: true,
            can_elevate: cfg!(windows),
        });
    }

    if !shells.iter().any(|shell| shell.is_default) {
        if let Some(first) = shells.first_mut() {
            first.is_default = true;
        }
    }

    shells
}

pub fn resolve_shell(shell: Option<String>) -> ShellLaunch {
    resolve_shell_with_id(shell, None).0
}

/// Same as `resolve_shell`, but also reports the `LocalShellOption.id` that was
/// matched. Returns `"custom"` when the caller passed an explicit shell path
/// that didn't correspond to any enumerated option, and `"default"` when we
/// fell back to the platform fallback because no shells were detected.
pub fn resolve_shell_with_id(
    shell: Option<String>,
    shell_args: Option<Vec<String>>,
) -> (ShellLaunch, String) {
    if let Some(raw) = shell {
        let requested = raw.trim();
        if !requested.is_empty() {
            // First, check if the requested string is one of our known shell IDs
            if let Some(option) = list_local_shells()
                .into_iter()
                .find(|option| option.id == requested)
            {
                let id = option.id;
                // If the user didn't override args, use option's default args, otherwise use user's args
                let args = shell_args.unwrap_or(option.args);
                return (
                    ShellLaunch {
                        program: option.path,
                        args,
                    },
                    id,
                );
            }

            // Otherwise, it's a custom command. Let's inspect the program string to see if it looks like powershell.
            let lower = requested.to_lowercase();
            let is_ps = lower.contains("pwsh") || lower.contains("powershell");
            let id = if is_ps {
                if lower.contains("pwsh") || lower.contains("7") {
                    "powershell".to_string()
                } else {
                    "windows-powershell".to_string()
                }
            } else {
                "custom".to_string()
            };

            return (
                ShellLaunch {
                    program: requested.to_string(),
                    args: shell_args.unwrap_or_default(),
                },
                id,
            );
        }
    }

    if let Some(option) = list_local_shells().into_iter().find(|opt| opt.is_default) {
        let id = option.id;
        return (
            ShellLaunch {
                program: option.path,
                args: option.args,
            },
            id,
        );
    }

    (fallback_shell_launch(), "default".to_string())
}

pub fn open_shell_as_administrator(shell: Option<String>) -> Result<(), String> {
    #[cfg(windows)]
    {
        let shell_launch = resolve_shell(shell);
        return open_elevated_with_powershell(&shell_launch);
    }

    #[cfg(not(windows))]
    {
        let _ = shell;
        Err("Administrator local terminals are only supported on Windows".to_string())
    }
}

fn fallback_shell_launch() -> ShellLaunch {
    #[cfg(unix)]
    {
        ShellLaunch {
            program: std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string()),
            args: Vec::new(),
        }
    }
    #[cfg(windows)]
    {
        ShellLaunch {
            program: std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".to_string()),
            args: Vec::new(),
        }
    }
}

#[cfg(windows)]
fn platform_local_shells() -> Vec<LocalShellOption> {
    let windows_powershell = find_windows_powershell();
    let command_prompt = find_command_prompt();
    let powershell = find_powershell_7();
    let git_bash = find_git_bash();

    let default_id = if powershell.is_some() {
        "powershell"
    } else if windows_powershell.is_some() {
        "windows-powershell"
    } else if command_prompt.is_some() {
        "command-prompt"
    } else {
        "git-bash"
    };

    let mut shells = Vec::new();
    if let Some(path) = windows_powershell {
        shells.push(shell_option(
            "windows-powershell",
            "Windows PowerShell",
            path,
            vec!["-NoLogo".to_string()],
            default_id,
        ));
    }
    if let Some(path) = command_prompt {
        shells.push(shell_option(
            "command-prompt",
            "Command Prompt",
            path,
            Vec::new(),
            default_id,
        ));
    }
    if let Some(path) = powershell {
        shells.push(shell_option(
            "powershell",
            "PowerShell",
            path,
            vec!["-NoLogo".to_string()],
            default_id,
        ));
    }
    if let Some(path) = git_bash {
        shells.push(shell_option(
            "git-bash",
            "Git Bash",
            path,
            vec!["--login".to_string(), "-i".to_string()],
            default_id,
        ));
    }

    shells
}

#[cfg(unix)]
fn platform_local_shells() -> Vec<LocalShellOption> {
    let shell = std::env::var("SHELL")
        .ok()
        .map(PathBuf::from)
        .filter(|path| path.exists())
        .or_else(|| first_existing(["/bin/zsh", "/bin/bash", "/bin/sh"].map(PathBuf::from)));

    shell
        .map(|path| {
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("Default shell")
                .to_string();
            LocalShellOption {
                id: "default".to_string(),
                name,
                path: path_to_string(path),
                args: Vec::new(),
                is_default: true,
                can_elevate: false,
            }
        })
        .into_iter()
        .collect()
}

#[cfg(windows)]
fn shell_option(
    id: &str,
    name: &str,
    path: PathBuf,
    args: Vec<String>,
    default_id: &str,
) -> LocalShellOption {
    LocalShellOption {
        id: id.to_string(),
        name: name.to_string(),
        path: path_to_string(path),
        args,
        is_default: id == default_id,
        can_elevate: true,
    }
}

#[cfg(windows)]
fn open_elevated_with_powershell(shell: &ShellLaunch) -> Result<(), String> {
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let launcher = find_windows_powershell().unwrap_or_else(|| PathBuf::from("powershell.exe"));
    let script = if shell.args.is_empty() {
        format!(
            "Start-Process -FilePath {} -Verb RunAs",
            quote_powershell_string(&shell.program)
        )
    } else {
        let args = shell
            .args
            .iter()
            .map(|arg| quote_powershell_string(arg))
            .collect::<Vec<_>>()
            .join(",");
        format!(
            "Start-Process -FilePath {} -ArgumentList @({}) -Verb RunAs",
            quote_powershell_string(&shell.program),
            args,
        )
    };

    let output = std::process::Command::new(launcher)
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command"])
        .arg(script)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("Failed to request administrator shell: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if stderr.is_empty() {
            Err(format!(
                "Administrator shell request failed with exit code {:?}",
                output.status.code()
            ))
        } else {
            Err(stderr)
        }
    }
}

#[cfg(windows)]
fn quote_powershell_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(windows)]
fn find_powershell_7() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = find_in_path("pwsh.exe") {
        candidates.push(path);
    }
    candidates.extend(
        [
            env_join("ProgramFiles", "PowerShell\\7\\pwsh.exe"),
            env_join("ProgramW6432", "PowerShell\\7\\pwsh.exe"),
            env_join("ProgramFiles(x86)", "PowerShell\\7\\pwsh.exe"),
            env_join("LOCALAPPDATA", "Microsoft\\powershell\\7\\pwsh.exe"),
            env_join("LOCALAPPDATA", "Programs\\PowerShell\\7\\pwsh.exe"),
        ]
        .into_iter()
        .flatten(),
    );

    first_existing(candidates)
}

#[cfg(windows)]
fn find_windows_powershell() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = find_in_path("powershell.exe") {
        candidates.push(path);
    }
    candidates.extend(
        [
            env_join(
                "SystemRoot",
                "System32\\WindowsPowerShell\\v1.0\\powershell.exe",
            ),
            env_join(
                "WINDIR",
                "System32\\WindowsPowerShell\\v1.0\\powershell.exe",
            ),
        ]
        .into_iter()
        .flatten(),
    );

    first_existing(candidates)
}

#[cfg(windows)]
fn find_command_prompt() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(comspec) = std::env::var_os("COMSPEC").map(PathBuf::from) {
        candidates.push(comspec);
    }
    if let Some(path) = find_in_path("cmd.exe") {
        candidates.push(path);
    }
    candidates.extend(
        [
            env_join("SystemRoot", "System32\\cmd.exe"),
            env_join("WINDIR", "System32\\cmd.exe"),
        ]
        .into_iter()
        .flatten(),
    );

    first_existing(candidates)
}

#[cfg(windows)]
fn find_git_bash() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = find_in_path("bash.exe").filter(|path| is_git_bash_path(path)) {
        candidates.push(path);
    }
    if let Some(git) = find_in_path("git.exe") {
        if let Some(parent) = git.parent() {
            let dir_name = parent
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase();

            if dir_name == "cmd" {
                if let Some(root) = parent.parent() {
                    candidates.push(root.join("bin\\bash.exe"));
                }
            } else if dir_name == "bin" {
                candidates.push(parent.join("bash.exe"));
            }
        }
    }
    candidates.extend(
        [
            env_join("ProgramFiles", "Git\\bin\\bash.exe"),
            env_join("ProgramW6432", "Git\\bin\\bash.exe"),
            env_join("ProgramFiles(x86)", "Git\\bin\\bash.exe"),
            env_join("LOCALAPPDATA", "Programs\\Git\\bin\\bash.exe"),
        ]
        .into_iter()
        .flatten(),
    );

    first_existing(candidates)
}

#[cfg(windows)]
fn is_git_bash_path(path: &Path) -> bool {
    path.to_string_lossy()
        .replace('/', "\\")
        .to_ascii_lowercase()
        .contains("\\git\\")
}

#[cfg(windows)]
fn env_join(var: &str, child: &str) -> Option<PathBuf> {
    std::env::var_os(var)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .map(|base| base.join(child))
}

#[cfg(windows)]
fn find_in_path(program: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|dir| dir.join(program))
            .find(|candidate| candidate.is_file())
    })
}

fn first_existing<I>(paths: I) -> Option<PathBuf>
where
    I: IntoIterator<Item = PathBuf>,
{
    paths.into_iter().find(|path| path.is_file())
}

fn path_to_string(path: PathBuf) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(unix)]
fn apply_terminal_environment(cmd: &mut CommandBuilder) {
    cmd.env("TERM", "xterm-256color");

    #[cfg(target_os = "macos")]
    apply_macos_utf8_locale(cmd);
}

#[cfg(target_os = "macos")]
fn apply_macos_utf8_locale(cmd: &mut CommandBuilder) {
    let locale = preferred_utf8_locale(cmd).unwrap_or_else(|| "en_US.UTF-8".to_string());

    set_if_not_full_utf8_locale(cmd, "LANG", &locale);
    set_lc_ctype_if_not_utf8(cmd, &locale);
    set_lc_all_if_present_and_not_full_utf8_locale(cmd, &locale);
}

#[cfg(target_os = "macos")]
fn preferred_utf8_locale(cmd: &CommandBuilder) -> Option<String> {
    ["LANG", "LC_CTYPE", "LC_ALL"]
        .into_iter()
        .filter_map(|key| cmd.get_env(key))
        .filter_map(OsStr::to_str)
        .map(str::trim)
        .find(|value| locale_is_full_utf8(value))
        .map(str::to_string)
}

#[cfg(target_os = "macos")]
fn set_if_not_full_utf8_locale(cmd: &mut CommandBuilder, key: &str, value: &str) {
    if !cmd
        .get_env(key)
        .and_then(OsStr::to_str)
        .map(str::trim)
        .is_some_and(locale_is_full_utf8)
    {
        cmd.env(key, value);
    }
}

#[cfg(target_os = "macos")]
fn set_lc_ctype_if_not_utf8(cmd: &mut CommandBuilder, value: &str) {
    if !cmd
        .get_env("LC_CTYPE")
        .and_then(OsStr::to_str)
        .map(str::trim)
        .is_some_and(locale_is_valid_macos_lc_ctype)
    {
        cmd.env("LC_CTYPE", value);
    }
}

#[cfg(target_os = "macos")]
fn set_lc_all_if_present_and_not_full_utf8_locale(cmd: &mut CommandBuilder, value: &str) {
    if cmd
        .get_env("LC_ALL")
        .and_then(OsStr::to_str)
        .map(str::trim)
        .is_some_and(|current| !current.is_empty() && !locale_is_full_utf8(current))
    {
        cmd.env("LC_ALL", value);
    }
}

#[cfg(target_os = "macos")]
fn locale_is_valid_macos_lc_ctype(value: &str) -> bool {
    normalized_locale(value) == "UTF8" || locale_is_full_utf8(value)
}

#[cfg(target_os = "macos")]
fn locale_is_full_utf8(value: &str) -> bool {
    let normalized = normalized_locale(value);
    normalized.contains('.') && normalized.contains("UTF8") && !normalized.starts_with("C.")
}

#[cfg(target_os = "macos")]
fn normalized_locale(value: &str) -> String {
    value.to_ascii_uppercase().replace('-', "")
}

pub fn create_pty(
    cols: u16,
    rows: u16,
    shell: Option<String>,
    shell_args: Option<Vec<String>>,
    cwd: Option<String>,
) -> Result<(PtyHandle, Box<dyn Read + Send>, String), String> {
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

    let (shell_launch, shell_id) = resolve_shell_with_id(shell, shell_args);
    let mut cmd = CommandBuilder::new(&shell_launch.program);
    for arg in &shell_launch.args {
        cmd.arg(arg);
    }

    #[cfg(unix)]
    apply_terminal_environment(&mut cmd);

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

    Ok((handle, reader, shell_id))
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

#[cfg(test)]
#[cfg(target_os = "macos")]
mod tests {
    use super::*;

    fn env<'a>(cmd: &'a CommandBuilder, key: &str) -> Option<&'a str> {
        cmd.get_env(key).and_then(OsStr::to_str)
    }

    #[test]
    fn terminal_environment_repairs_empty_and_c_locale_on_macos() {
        let mut cmd = CommandBuilder::new("/bin/zsh");
        cmd.env("LANG", "");
        cmd.env("LC_CTYPE", "C");
        cmd.env("LC_ALL", "C");

        apply_terminal_environment(&mut cmd);

        assert_eq!(env(&cmd, "TERM"), Some("xterm-256color"));
        assert_eq!(env(&cmd, "LANG"), Some("en_US.UTF-8"));
        assert_eq!(env(&cmd, "LC_CTYPE"), Some("en_US.UTF-8"));
        assert_eq!(env(&cmd, "LC_ALL"), Some("en_US.UTF-8"));
    }

    #[test]
    fn terminal_environment_uses_existing_utf8_locale_as_fallback_on_macos() {
        let mut cmd = CommandBuilder::new("/bin/zsh");
        cmd.env("LANG", "zh_CN.UTF-8");
        cmd.env("LC_CTYPE", "C");
        cmd.env("LC_ALL", "");

        apply_terminal_environment(&mut cmd);

        assert_eq!(env(&cmd, "LANG"), Some("zh_CN.UTF-8"));
        assert_eq!(env(&cmd, "LC_CTYPE"), Some("zh_CN.UTF-8"));
        assert_eq!(env(&cmd, "LC_ALL"), Some(""));
    }

    #[test]
    fn terminal_environment_replaces_c_utf8_on_macos() {
        let mut cmd = CommandBuilder::new("/bin/zsh");
        cmd.env("LANG", "zh_CN.UTF-8");
        cmd.env("LC_CTYPE", "C.UTF-8");
        cmd.env("LC_ALL", "C.UTF-8");

        apply_terminal_environment(&mut cmd);

        assert_eq!(env(&cmd, "LANG"), Some("zh_CN.UTF-8"));
        assert_eq!(env(&cmd, "LC_CTYPE"), Some("zh_CN.UTF-8"));
        assert_eq!(env(&cmd, "LC_ALL"), Some("zh_CN.UTF-8"));
    }

    #[test]
    fn terminal_environment_preserves_explicit_utf8_locale_on_macos() {
        let mut cmd = CommandBuilder::new("/bin/zsh");
        cmd.env("LANG", "ja_JP.UTF-8");
        cmd.env("LC_CTYPE", "zh_CN.UTF-8");
        cmd.env("LC_ALL", "en_US.UTF-8");

        apply_terminal_environment(&mut cmd);

        assert_eq!(env(&cmd, "LANG"), Some("ja_JP.UTF-8"));
        assert_eq!(env(&cmd, "LC_CTYPE"), Some("zh_CN.UTF-8"));
        assert_eq!(env(&cmd, "LC_ALL"), Some("en_US.UTF-8"));
    }

    #[test]
    fn create_pty_lists_utf8_filename_on_macos() {
        let temp = tempfile::tempdir().expect("create temp dir");
        let filename = "\u{5bfc}\u{56fe}1.emmx";
        std::fs::write(temp.path().join(filename), b"").expect("write utf8 filename");

        let (mut handle, mut reader, _) = create_pty(
            80,
            24,
            Some("/bin/ls".to_string()),
            Some(vec![
                "-1".to_string(),
                temp.path().to_string_lossy().into_owned(),
            ]),
            None,
        )
        .expect("spawn ls in pty");

        let mut output = String::new();
        reader.read_to_string(&mut output).expect("read ls output");
        let status = handle.child.wait().expect("wait for ls");

        assert!(status.success(), "ls exited with {status}");
        assert!(
            output.contains(filename),
            "ls output should include utf8 filename, got {output:?}"
        );
    }
}
