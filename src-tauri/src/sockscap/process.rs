//! Process enumeration for the App-mode picker.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub pid: u32,
    pub name: String,
    pub path: String,
}

/// Best-effort process list. Platform detail improves in Phase 2+.
pub fn list_processes() -> Result<Vec<ProcessInfo>, String> {
    #[cfg(windows)]
    {
        list_processes_windows()
    }
    #[cfg(not(windows))]
    {
        // Portable fallback: empty list with a note is worse UX than /proc skim on Linux.
        #[cfg(target_os = "linux")]
        {
            return list_processes_linux();
        }
        #[cfg(not(target_os = "linux"))]
        {
            Ok(Vec::new())
        }
    }
}

#[cfg(windows)]
fn list_processes_windows() -> Result<Vec<ProcessInfo>, String> {
    // Avoid heavy winapi surface for now — return empty; UI can still add paths manually.
    // Full Toolhelp32 snapshot lands with WinDivert capture work.
    Ok(Vec::new())
}

#[cfg(target_os = "linux")]
fn list_processes_linux() -> Result<Vec<ProcessInfo>, String> {
    use std::fs;
    let mut out = Vec::new();
    let entries = fs::read_dir("/proc").map_err(|e| e.to_string())?;
    for ent in entries.flatten() {
        let name = ent.file_name();
        let name = name.to_string_lossy();
        if !name.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let pid: u32 = match name.parse() {
            Ok(p) => p,
            Err(_) => continue,
        };
        let cmdline = fs::read_to_string(ent.path().join("comm")).unwrap_or_default();
        let exe = fs::read_link(ent.path().join("exe"))
            .map(|p| p.display().to_string())
            .unwrap_or_default();
        out.push(ProcessInfo {
            pid,
            name: cmdline.trim().to_string(),
            path: exe,
        });
        if out.len() >= 500 {
            break;
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}
