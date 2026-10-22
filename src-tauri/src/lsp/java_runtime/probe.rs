use super::selection::get_configured_java_home;
use super::selection::resolve_java_for_jdtls;
use crate::lsp::limits::JDTLS_MIN_JAVA_MAJOR;
use crate::lsp::presets::cmd;
use crate::lsp::status_model::LspServerCommandPreset;
use crate::lsp::status_model::LspServerPreset;
use std::path::Path;
use std::process::Stdio;
use tokio::io::AsyncBufReadExt;
use tokio::process::Command;

/// Probe the JVM used by jdtls for Settings / pre-start checks.
/// Returns `(runtime_status label, error if unusable)`.
pub(in crate::lsp) fn jdtls_runtime_probe() -> (Option<String>, Option<String>) {
    match resolve_java_for_jdtls() {
        Ok((path, major)) => {
            let short = path.display().to_string();
            let configured = get_configured_java_home().is_some();
            (
                Some(format!(
                    "Java {major} · {short}{} (JDK {JDTLS_MIN_JAVA_MAJOR}+ required)",
                    if configured { " · configured" } else { "" }
                )),
                None,
            )
        }
        Err(error) => {
            // Prefer a compact status line for the Settings row.
            let status = if let Some(major) = error
                .split("found Java ")
                .nth(1)
                .and_then(|rest| rest.split_whitespace().next())
                .and_then(|s| s.parse::<u32>().ok())
            {
                Some(format!(
                    "Java {major} — need JDK {JDTLS_MIN_JAVA_MAJOR}+ for current JDT LS"
                ))
            } else if error.contains("java not found") || error.contains("invalid") {
                Some(format!(
                    "Java not found — need JDK {JDTLS_MIN_JAVA_MAJOR}+ for jdtls"
                ))
            } else {
                Some(format!(
                    "Java runtime issue (need JDK {JDTLS_MIN_JAVA_MAJOR}+)"
                ))
            };
            (status, Some(error))
        }
    }
}

pub(in crate::lsp) fn command_is_jdtls(command: &LspServerCommandPreset) -> bool {
    command.id.eq_ignore_ascii_case("jdtls")
        || command.command.to_ascii_lowercase().contains("jdtls")
}

pub(in crate::lsp) fn preset_uses_jdtls(
    preset: &LspServerPreset,
    command: Option<&LspServerCommandPreset>,
) -> bool {
    if preset.id == "java" {
        return true;
    }
    command.is_some_and(command_is_jdtls) || preset.commands.iter().any(command_is_jdtls)
}

/// Parse `java -version` output (`openjdk version "17.0.4"` / `"21.0.2"` / `"1.8.0_xxx"`).
pub(in crate::lsp) fn java_major_version(java: &Path) -> Result<u32, String> {
    let mut cmd = std::process::Command::new(java);
    cmd.arg("-version");
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = cmd
        .output()
        .map_err(|e| format!("failed to run {} -version: {e}", java.display()))?;
    let text = {
        let err = String::from_utf8_lossy(&output.stderr);
        let out = String::from_utf8_lossy(&output.stdout);
        if !err.trim().is_empty() {
            err.into_owned()
        } else {
            out.into_owned()
        }
    };
    parse_java_major_from_version_output(&text).ok_or_else(|| {
        format!(
            "could not parse Java version from {} -version output: {}",
            java.display(),
            text.lines().next().unwrap_or("(empty)").trim()
        )
    })
}

pub(in crate::lsp) fn parse_java_major_from_version_output(text: &str) -> Option<u32> {
    // version "21.0.2" | version "17.0.4" | version "1.8.0_392"
    for line in text.lines() {
        let Some(after) = line.split("version").nth(1) else {
            continue;
        };
        let Some(start) = after.find('"') else {
            continue;
        };
        let rest = &after[start + 1..];
        let end = rest.find('"').unwrap_or(rest.len());
        let ver = rest[..end].trim();
        let mut parts = ver.split(['.', '_', '-']);
        let first: u32 = parts.next()?.parse().ok()?;
        if first == 1 {
            return parts.next()?.parse().ok();
        }
        return Some(first);
    }
    None
}
