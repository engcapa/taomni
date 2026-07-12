//! Local-shell integration: make a freshly launched local shell report its
//! working directory on every prompt via an OSC 7 escape
//! (`ESC ] 7 ; file://host/path ESC \`).
//!
//! The frontend already listens for OSC 7 and tracks each terminal's cwd, so
//! once the prompt emits it continuously, duplicating a tab can read the
//! last-known cwd instead of injecting a probe command into the interactive
//! shell (which leaks its echo and corrupts any half-typed input line).
//!
//! Strategy per shell:
//!   - bash / git-bash / other POSIX: set `PROMPT_COMMAND` in the environment.
//!     bash runs it before each prompt; zsh/dash/cmd/PowerShell ignore the var
//!     harmlessly (those fall back to the on-demand probe).
//!   - PowerShell: dot-source a generated script after the profile loads, via
//!     `-NoExit -Command ". '<script>'"`. The script wraps the (post-profile)
//!     `prompt` function so it still works with custom prompts (conda,
//!     oh-my-posh) defined in the profile.
//!   - cmd.exe: unsupported (can't emit OSC 7 cleanly) — left untouched.

use std::io::Write;
use std::path::PathBuf;

/// `PROMPT_COMMAND` body for POSIX shells. Emits OSC 7 with the host and `$PWD`
/// before each prompt. Mirrors the one-shot probe's `printf` form so the path
/// flows through the same frontend parser/normalizer.
const BASH_PROMPT_COMMAND: &str =
    r#"printf '\033]133;A\033\\\033]7;file://%s%s\033\\' "${HOSTNAME:-localhost}" "$PWD""#;

/// PowerShell integration script. Captures the current `prompt` (which, run
/// after the profile, is the user's customized one) and replaces it with a
/// wrapper that writes OSC 7 and then defers to the captured prompt.
const PS_INTEGRATION_SCRIPT: &str = r#"$global:__taomniOrigPrompt = $function:prompt
function global:prompt {
  try {
    $p = $PWD.ProviderPath
    [Console]::Write([char]27 + ']133;A' + [char]27 + '\')
    if ($p) { [Console]::Write([char]27 + ']7;file://' + $env:COMPUTERNAME + '/' + ($p -replace '\\','/') + [char]27 + '\') }
  } catch {}
  if ($global:__taomniOrigPrompt) { & $global:__taomniOrigPrompt } else { 'PS ' + $PWD.Path + '> ' }
}
"#;

/// What to add to a shell launch so it reports its cwd via OSC 7.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Integration {
    /// Extra CLI args appended after the shell's own args.
    pub extra_args: Vec<String>,
    /// Extra environment variables to set on the child.
    pub env: Vec<(String, String)>,
}

/// Compute the integration for a resolved shell. `shell_id` is the resolved
/// `LocalShellOption.id` (e.g. `powershell`, `git-bash`); `program` is the
/// executable path; `args` are the shell's already-resolved arguments.
pub fn integration_for(program: &str, shell_id: &str, args: &[String]) -> Integration {
    if is_powershell(program, shell_id) {
        // Only inject when the launch uses the default args. If the user
        // customized args (which may carry their own -Command/-File), leave it
        // alone and let duplication fall back to the on-demand probe.
        if uses_default_powershell_args(args) {
            if let Some(path) = ensure_ps_script() {
                return Integration {
                    extra_args: vec![
                        "-NoExit".to_string(),
                        "-Command".to_string(),
                        format!(". '{}'", path.replace('\'', "''")),
                    ],
                    env: Vec::new(),
                };
            }
        }
        return Integration::default();
    }

    if is_posix_shell(program) {
        return Integration {
            extra_args: Vec::new(),
            env: vec![(
                "PROMPT_COMMAND".to_string(),
                BASH_PROMPT_COMMAND.to_string(),
            )],
        };
    }

    Integration::default()
}

fn is_powershell(program: &str, shell_id: &str) -> bool {
    if shell_id == "powershell" || shell_id == "windows-powershell" {
        return true;
    }
    let base = basename_lower(program);
    base.contains("powershell") || base.contains("pwsh")
}

/// True for shells that honor a `PROMPT_COMMAND` we can use (bash) or harmlessly
/// ignore it (zsh/dash/sh). Excludes PowerShell (handled above) and cmd.exe.
fn is_posix_shell(program: &str) -> bool {
    let base = basename_lower(program);
    if base.contains("powershell") || base.contains("pwsh") || base.contains("cmd") {
        return false;
    }
    base.contains("bash")
        || base.contains("zsh")
        || base == "sh"
        || base == "sh.exe"
        || base.contains("dash")
        || base.contains("ksh")
        || base.contains("ash")
}

/// We only auto-wrap PowerShell when it launches with the stock args, so a
/// user-supplied command/profile setup is never clobbered.
fn uses_default_powershell_args(args: &[String]) -> bool {
    args.is_empty()
        || args
            .iter()
            .map(|a| a.to_ascii_lowercase())
            .eq(["-nologo".to_string()])
}

fn basename_lower(program: &str) -> String {
    program
        .rsplit(|c| c == '/' || c == '\\')
        .next()
        .unwrap_or(program)
        .to_ascii_lowercase()
}

/// Write the PowerShell integration script to a stable temp path (idempotent;
/// overwritten each launch) and return its path. Returns `None` on any IO
/// error so the caller silently skips integration rather than failing launch.
fn ensure_ps_script() -> Option<String> {
    let dir = std::env::temp_dir().join("taomni");
    if std::fs::create_dir_all(&dir).is_err() {
        return None;
    }
    let path: PathBuf = dir.join("ps_cwd_integration.ps1");
    let mut file = std::fs::File::create(&path).ok()?;
    file.write_all(PS_INTEGRATION_SCRIPT.as_bytes()).ok()?;
    Some(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn posix_shells_get_prompt_command() {
        let i = integration_for("/usr/bin/bash", "default", &[]);
        assert!(i.extra_args.is_empty());
        assert_eq!(i.env.len(), 1);
        assert_eq!(i.env[0].0, "PROMPT_COMMAND");
        assert!(i.env[0].1.contains(r"\033]7;file://"));
    }

    #[test]
    fn git_bash_path_is_posix() {
        let i = integration_for(
            r"C:\Program Files\Git\bin\bash.exe",
            "git-bash",
            &["--login".to_string(), "-i".to_string()],
        );
        assert_eq!(i.env.first().map(|e| e.0.as_str()), Some("PROMPT_COMMAND"));
        assert!(i.extra_args.is_empty());
    }

    #[test]
    fn cmd_and_powershell_are_not_posix() {
        assert!(!is_posix_shell(r"C:\Windows\System32\cmd.exe"));
        assert!(!is_posix_shell(
            r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
        ));
        assert!(is_powershell("pwsh.exe", "custom"));
        assert!(is_powershell("anything", "windows-powershell"));
    }

    #[test]
    fn powershell_custom_args_skip_injection() {
        // Default args → injected (script path is environment-dependent, so we
        // only assert it does not bail purely on the args check).
        assert!(uses_default_powershell_args(&[]));
        assert!(uses_default_powershell_args(&["-NoLogo".to_string()]));
        assert!(!uses_default_powershell_args(&[
            "-NoLogo".to_string(),
            "-Command".to_string()
        ]));
        assert!(!uses_default_powershell_args(&["-NoProfile".to_string()]));
    }

    #[test]
    fn unknown_shell_gets_nothing() {
        assert_eq!(
            integration_for("/usr/bin/fish", "default", &[]),
            Integration::default()
        );
    }
}
