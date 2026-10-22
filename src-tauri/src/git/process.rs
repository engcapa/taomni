use super::*;

pub(super) fn run_git_in<'a, I>(cwd: Option<&Path>, args: I) -> Result<String, String>
where
    I: IntoIterator<Item = &'a str>,
{
    let args = args.into_iter().map(|s| s.to_string()).collect();
    run_git_strings(cwd, args)
}

pub(super) fn run_git_strings(cwd: Option<&Path>, args: Vec<String>) -> Result<String, String> {
    let mut command = new_git_command();
    if let Some(cwd) = cwd {
        // Validate before current_dir: on Windows an invalid cwd yields
        // ERROR_DIRECTORY (os error 267) with a vague spawn failure. Prefer a
        // stable message so the frontend can drop the dead root (issue #324).
        match fs::metadata(cwd) {
            Ok(meta) if meta.is_dir() => {}
            Ok(_) => {
                return Err(format!(
                    "Repository path is not a directory: {}",
                    cwd.display()
                ));
            }
            Err(_) => {
                return Err(format!(
                    "Repository path no longer exists: {}",
                    cwd.display()
                ));
            }
        }
        command.current_dir(cwd);
    }
    apply_stable_locale(&mut command);
    for arg in args {
        command.arg(arg);
    }
    let output = command
        .output()
        .map_err(|e| format!("failed to start git: {e}"))?;
    command_output(output)
}

/// Force git to emit machine-stable English output. Porcelain strings such as
/// "No commits yet on", "[ahead N]" and rename markers are localized otherwise,
/// which breaks status/branch parsing for users on non-English git locales.
pub(super) fn apply_stable_locale(command: &mut Command) {
    command.env("LC_ALL", "C");
    command.env("LANG", "C");
}

pub(super) fn run_git_authed(
    root: &Path,
    args: Vec<String>,
    vault: Arc<Vault>,
    remote: Option<&str>,
) -> Result<String, String> {
    let remote = remote
        .and_then(non_empty_string)
        .or_else(|| default_remote_for_head(root))
        .or_else(|| {
            list_remote_names(root)
                .ok()
                .and_then(|items| items.into_iter().next())
        });
    let auth = remote
        .as_deref()
        .and_then(|remote| load_remote_auth(root, remote, &vault).transpose())
        .transpose()?;
    let Some((username, token)) = auth else {
        return run_git_strings(Some(root), args);
    };
    let askpass = write_askpass_script()?;
    let mut command = new_git_command();
    command.current_dir(root);
    apply_stable_locale(&mut command);
    for arg in args {
        command.arg(arg);
    }
    command.env("GIT_TERMINAL_PROMPT", "0");
    command.env("GIT_ASKPASS", askpass.as_os_str());
    command.env("TAOMNI_GIT_USERNAME", username);
    command.env("TAOMNI_GIT_PASSWORD", token.as_str());
    let output = command
        .output()
        .map_err(|e| format!("failed to start git: {e}"));
    let _ = fs::remove_file(&askpass);
    command_output(output?)
}

pub(super) fn default_remote_for_head(root: &Path) -> Option<String> {
    current_branch_name(root)
        .as_deref()
        .and_then(|branch| get_config(root, &format!("branch.{branch}.remote")))
        .or_else(|| {
            run_git_in(
                Some(root),
                ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
            )
            .ok()
            .and_then(|upstream| upstream.split('/').next().and_then(non_empty_string))
        })
}

pub(super) fn build_pull_args(
    root: &Path,
    remote: Option<&str>,
    branch: Option<&str>,
    rebase: bool,
) -> Result<Vec<String>, String> {
    let mut args = vec!["pull".to_string()];
    if rebase {
        args.push("--rebase".into());
    }
    let Some(remote) = remote.and_then(non_empty_string) else {
        return Ok(args);
    };
    args.push(remote.clone());
    let branch = branch
        .and_then(non_empty_string)
        .or_else(|| upstream_branch_for_remote(root, &remote))
        .or_else(|| current_branch_name(root));
    let Some(branch) = branch else {
        return Err(
            "Pull from a selected remote requires a branch, but the current HEAD is detached."
                .into(),
        );
    };
    args.push(branch);
    Ok(args)
}

pub(super) fn current_branch_name(root: &Path) -> Option<String> {
    run_git_in(Some(root), ["symbolic-ref", "--quiet", "--short", "HEAD"])
        .ok()
        .and_then(|s| non_empty_string(&s))
}

pub(super) fn upstream_branch_for_remote(root: &Path, remote: &str) -> Option<String> {
    let branch = current_branch_name(root)?;
    let configured_remote = get_config(root, &format!("branch.{branch}.remote"))?;
    if configured_remote.trim() != remote {
        return None;
    }
    let merge = get_config(root, &format!("branch.{branch}.merge"))?;
    let remote_branch = merge
        .trim()
        .strip_prefix("refs/heads/")
        .unwrap_or(merge.trim());
    non_empty_string(remote_branch)
}

pub(super) fn load_remote_auth(
    root: &Path,
    remote: &str,
    vault: &Vault,
) -> Result<Option<(String, zeroize::Zeroizing<String>)>, String> {
    let Some(token_ref) = get_config(root, &remote_auth_key(remote, "tokenRef")) else {
        return Ok(None);
    };
    let token = vault
        .resolve(&token_ref)?
        .ok_or_else(|| "git token setting is not a vault reference".to_string())?;
    let username = get_config(root, &remote_auth_key(remote, "username"))
        .unwrap_or_else(|| "x-access-token".to_string());
    Ok(Some((username, token)))
}

pub(super) fn command_output(output: std::process::Output) -> Result<String, String> {
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout)
            .trim_end()
            .to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if !stderr.is_empty() { stderr } else { stdout };
        Err(if detail.is_empty() {
            format!("git exited with {}", output.status)
        } else {
            detail
        })
    }
}

pub(super) fn write_askpass_script() -> Result<PathBuf, String> {
    let suffix = if cfg!(windows) { "cmd" } else { "sh" };
    let path = std::env::temp_dir().join(format!(
        "taomni-git-askpass-{}.{}",
        uuid::Uuid::new_v4(),
        suffix
    ));
    let content = if cfg!(windows) {
        "@echo off\r\necho %1 | findstr /I \"Username\" >nul\r\nif errorlevel 1 (echo %TAOMNI_GIT_PASSWORD%) else (echo %TAOMNI_GIT_USERNAME%)\r\n"
    } else {
        "#!/bin/sh\ncase \"$1\" in\n  *Username*) printf '%s\\n' \"$TAOMNI_GIT_USERNAME\" ;;\n  *) printf '%s\\n' \"$TAOMNI_GIT_PASSWORD\" ;;\nesac\n"
    };
    fs::write(&path, content).map_err(|e| format!("failed to write askpass script: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&path)
            .map_err(|e| e.to_string())?
            .permissions();
        perms.set_mode(0o700);
        fs::set_permissions(&path, perms).map_err(|e| e.to_string())?;
    }
    Ok(path)
}

pub(super) fn operation_command(kind: &str) -> Result<&'static str, String> {
    match kind {
        "merge" => Ok("merge"),
        "cherryPick" | "cherry-pick" => Ok("cherry-pick"),
        "revert" => Ok("revert"),
        "rebase" => Ok("rebase"),
        other => Err(format!("unknown git operation: {other}")),
    }
}

pub(super) fn run_git_no_editor(root: &Path, args: Vec<String>) -> Result<String, String> {
    let mut command = new_git_command();
    command.current_dir(root);
    apply_stable_locale(&mut command);
    command.env("GIT_EDITOR", "true");
    command.env("GIT_TERMINAL_PROMPT", "0");
    for arg in args {
        command.arg(arg);
    }
    let output = command
        .output()
        .map_err(|e| format!("failed to start git: {e}"))?;
    command_output(output)
}

pub(super) fn new_git_command() -> Command {
    let mut command = Command::new("git");
    no_console_window(&mut command);
    // Reads such as `status` must not opportunistically refresh and rewrite
    // `.git/index`: viewing Changes is not a Git write (ED-PARITY-008-A3).
    // Commands that must modify the index still take their required lock.
    // Porcelain `git diff` ignores this setting, so read probes that run on
    // every refresh use plumbing instead (see `conflicted_paths`).
    command.env("GIT_OPTIONAL_LOCKS", "0");
    command
}

/// Release builds are Windows GUI-subsystem processes. Without this flag,
/// short-lived `git.exe` probes can flash console windows behind the app.
pub(super) fn no_console_window(command: &mut Command) {
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = command;
    }
}

pub(super) fn require_non_empty(label: &str, value: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        Err(format!("{label} is required"))
    } else {
        Ok(())
    }
}
