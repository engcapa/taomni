use super::shells::ShellLaunch;
use super::shells::resolve_shell;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::path::PathBuf;

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

#[cfg(windows)]
pub(super) fn open_elevated_with_powershell(shell: &ShellLaunch) -> Result<(), String> {
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
pub(super) fn quote_powershell_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(windows)]
pub(super) fn find_powershell_7() -> Option<PathBuf> {
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
pub(super) fn find_windows_powershell() -> Option<PathBuf> {
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
pub(super) fn find_command_prompt() -> Option<PathBuf> {
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
pub(super) fn find_git_bash() -> Option<PathBuf> {
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
pub(super) fn is_git_bash_path(path: &Path) -> bool {
    path.to_string_lossy()
        .replace('/', "\\")
        .to_ascii_lowercase()
        .contains("\\git\\")
}

#[cfg(windows)]
pub(super) fn env_join(var: &str, child: &str) -> Option<PathBuf> {
    std::env::var_os(var)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .map(|base| base.join(child))
}

#[cfg(windows)]
pub(super) fn find_in_path(program: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|dir| dir.join(program))
            .find(|candidate| candidate.is_file())
    })
}

pub(super) fn first_existing<I>(paths: I) -> Option<PathBuf>
where
    I: IntoIterator<Item = PathBuf>,
{
    paths.into_iter().find(|path| path.is_file())
}

pub(super) fn path_to_string(path: PathBuf) -> String {
    path.to_string_lossy().into_owned()
}
