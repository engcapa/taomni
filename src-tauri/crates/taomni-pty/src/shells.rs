#[cfg(windows)]
use super::windows_shells::find_command_prompt;
#[cfg(windows)]
use super::windows_shells::find_git_bash;
#[cfg(windows)]
use super::windows_shells::find_powershell_7;
#[cfg(windows)]
use super::windows_shells::find_windows_powershell;
use super::windows_shells::first_existing;
use super::windows_shells::path_to_string;
use serde::Serialize;
use std::path::PathBuf;

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

pub(super) fn fallback_shell_launch() -> ShellLaunch {
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
pub(super) fn platform_local_shells() -> Vec<LocalShellOption> {
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
pub(super) fn platform_local_shells() -> Vec<LocalShellOption> {
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
pub(super) fn shell_option(
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
