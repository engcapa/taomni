//! Windows Subsystem for Linux (WSL) integration.
//!
//! Discovery only — launching a WSL distro reuses the existing local
//! terminal pipeline (`create_local_terminal` with `shell="wsl.exe"` and
//! `shell_args=["-d", <distro>, ...]`).

use serde::Serialize;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WslDistro {
    pub name: String,
    pub is_default: bool,
    pub state: String,
    pub version: Option<u8>,
}

#[tauri::command]
pub fn list_wsl_distros() -> Result<Vec<WslDistro>, String> {
    list_distros()
}

#[cfg(windows)]
pub fn list_distros() -> Result<Vec<WslDistro>, String> {
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let output = std::process::Command::new("wsl.exe")
        .args(["-l", "-v"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("Failed to run wsl.exe: {}", e))?;

    if !output.status.success() {
        let stderr = crate::session::import::decode_command_output(&output.stderr);
        let trimmed = stderr.trim();
        return Err(if trimmed.is_empty() {
            format!(
                "wsl.exe exited with status {:?}",
                output.status.code(),
            )
        } else {
            trimmed.to_string()
        });
    }

    let text = crate::session::import::decode_command_output(&output.stdout);
    Ok(parse_wsl_verbose(&text))
}

#[cfg(not(windows))]
pub fn list_distros() -> Result<Vec<WslDistro>, String> {
    Ok(Vec::new())
}

/// Parse the output of `wsl.exe -l -v` (after BOM/null decoding).
///
/// Format (English):
/// ```text
///   NAME            STATE           VERSION
/// * Ubuntu          Running         2
///   Debian          Stopped         2
/// ```
///
/// Locale-tolerant: the first non-empty line (header) is skipped
/// unconditionally, so a CJK header `名称  状态  版本` works the same way.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn parse_wsl_verbose(text: &str) -> Vec<WslDistro> {
    let mut out: Vec<WslDistro> = Vec::new();
    let mut header_skipped = false;
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    for raw in text.lines() {
        let line = raw.trim_matches(|c: char| c == '\u{0}' || c.is_whitespace());
        if line.is_empty() {
            continue;
        }
        if !header_skipped {
            header_skipped = true;
            continue;
        }

        let (is_default, rest) = if let Some(stripped) = line.strip_prefix('*') {
            (true, stripped.trim_start())
        } else {
            (false, line)
        };

        let mut tokens = rest.split_whitespace();
        let Some(name) = tokens.next() else { continue };
        let state = tokens.next().unwrap_or("Unknown").to_string();
        let version = tokens.next().and_then(|t| t.parse::<u8>().ok());

        let key = name.to_ascii_lowercase();
        if !seen.insert(key) {
            continue;
        }

        out.push(WslDistro {
            name: name.to_string(),
            is_default,
            state,
            version,
        });
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_default_marker_and_state() {
        let text = "  NAME      STATE       VERSION\n* Ubuntu    Running     2\n";
        let distros = parse_wsl_verbose(text);
        assert_eq!(distros.len(), 1);
        assert_eq!(distros[0].name, "Ubuntu");
        assert!(distros[0].is_default);
        assert_eq!(distros[0].state, "Running");
        assert_eq!(distros[0].version, Some(2));
    }

    #[test]
    fn handles_multiple_distros() {
        let text = "  NAME      STATE       VERSION\n\
                    * Ubuntu    Running     2\n\
                      Debian    Stopped     2\n\
                      Legacy    Running     1\n";
        let distros = parse_wsl_verbose(text);
        assert_eq!(distros.len(), 3);
        assert!(distros[0].is_default && distros[0].name == "Ubuntu");
        assert_eq!(distros[1].state, "Stopped");
        assert_eq!(distros[2].version, Some(1));
    }

    #[test]
    fn handles_empty_or_header_only() {
        assert!(parse_wsl_verbose("").is_empty());
        assert!(parse_wsl_verbose("  NAME    STATE    VERSION\n").is_empty());
    }

    #[test]
    fn dedupes_case_insensitive() {
        let text = "NAME STATE VERSION\nUbuntu Running 2\nubuntu Stopped 2\n";
        let distros = parse_wsl_verbose(text);
        assert_eq!(distros.len(), 1);
    }

    #[test]
    fn tolerates_localized_header() {
        let text = "名称    状态    版本\n* Ubuntu Running 2\n  Debian Stopped 2\n";
        let distros = parse_wsl_verbose(text);
        assert_eq!(distros.len(), 2);
        assert_eq!(distros[0].name, "Ubuntu");
        assert!(distros[0].is_default);
    }

    #[test]
    fn handles_null_padding_between_chars() {
        // Simulates what UTF-16LE decoded output looks like before nulls
        // are stripped — `decode_command_output` already strips them, but
        // tolerate stray nulls anyway.
        let text = "NAME\u{0} STATE VERSION\n* Ubuntu Running 2\n";
        let distros = parse_wsl_verbose(text);
        assert_eq!(distros.len(), 1);
        assert_eq!(distros[0].name, "Ubuntu");
    }
}
