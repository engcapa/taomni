//! On-demand OS privilege elevation for Sockscap capture install/uninstall.
//!
//! Product requirement: Taomni itself runs as a normal user. Elevation is
//! requested only when the user starts / stops / recovers Sockscap, via the
//! platform auth UI:
//!
//! - Linux: `pkexec` (polkit GUI) → `sudo` fallback
//! - macOS: `osascript` `with administrator privileges`
//! - Windows: PowerShell `Start-Process -Verb RunAs` (UAC)
//!
//! Privileged work is always a short shell script (no proxy secrets). The
//! elevated process exits after applying/revoking capture rules.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

/// Whether this process already has elevated rights.
pub fn is_currently_elevated() -> bool {
    #[cfg(target_os = "linux")]
    {
        euid() == 0
    }
    #[cfg(target_os = "macos")]
    {
        euid() == 0
    }
    #[cfg(target_os = "windows")]
    {
        windows_is_admin()
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        false
    }
}

/// Whether we can prompt the user for elevation at start time.
pub fn elevation_prompt_available() -> bool {
    if is_currently_elevated() {
        return true;
    }
    #[cfg(target_os = "linux")]
    {
        which::which("pkexec").is_ok() || which::which("sudo").is_ok()
    }
    #[cfg(target_os = "macos")]
    {
        which::which("osascript").is_ok()
    }
    #[cfg(target_os = "windows")]
    {
        which::which("powershell.exe").is_ok() || which::which("powershell").is_ok()
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        false
    }
}

/// Human-readable description for UI / capability probes.
pub fn elevation_status_detail() -> String {
    if is_currently_elevated() {
        return "Already running elevated.".into();
    }
    if !elevation_prompt_available() {
        return "No elevation helper found (install polkit/pkexec, or run once as admin).".into();
    }
    #[cfg(target_os = "linux")]
    {
        if which::which("pkexec").is_ok() {
            return "Will prompt via polkit (pkexec) when you start Sockscap.".into();
        }
        return "Will prompt via sudo when you start Sockscap.".into();
    }
    #[cfg(target_os = "macos")]
    {
        return "Will prompt for administrator password when you start Sockscap.".into();
    }
    #[cfg(target_os = "windows")]
    {
        return "Will show a UAC prompt when you start Sockscap.".into();
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        "Elevation not supported on this platform.".into()
    }
}

/// Run a shell script with a one-shot elevation prompt (if needed).
///
/// `script` must be a complete shell script body (no shebang required).
/// On success the elevated process exit code is 0.
pub fn run_script_elevated(script_body: &str, purpose: &str) -> Result<(), String> {
    if is_currently_elevated() {
        return run_script_as_self(script_body);
    }
    if !elevation_prompt_available() {
        return Err(format!(
            "cannot elevate for {purpose}: no pkexec/sudo/osascript/UAC helper available"
        ));
    }

    let path = write_temp_script(script_body)?;
    let result = run_elevated_path(&path, purpose);
    let _ = fs::remove_file(&path);
    result
}

fn write_temp_script(body: &str) -> Result<PathBuf, String> {
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir();
    #[cfg(windows)]
    let path = dir.join(format!("taomni-sockscap-elev-{n}.cmd"));
    #[cfg(not(windows))]
    let path = dir.join(format!("taomni-sockscap-elev-{n}.sh"));

    let mut f = fs::File::create(&path).map_err(|e| format!("create elev script: {e}"))?;
    #[cfg(not(windows))]
    {
        writeln!(f, "#!/bin/sh").map_err(|e| e.to_string())?;
        writeln!(f, "set -e").map_err(|e| e.to_string())?;
        f.write_all(body.as_bytes()).map_err(|e| e.to_string())?;
        writeln!(f).map_err(|e| e.to_string())?;
        // Make executable for pkexec/sh.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = fs::metadata(&path).map_err(|e| e.to_string())?.permissions();
            perms.set_mode(0o700);
            fs::set_permissions(&path, perms).map_err(|e| e.to_string())?;
        }
    }
    #[cfg(windows)]
    {
        writeln!(f, "@echo off").map_err(|e| e.to_string())?;
        f.write_all(body.as_bytes()).map_err(|e| e.to_string())?;
        writeln!(f).map_err(|e| e.to_string())?;
    }
    Ok(path)
}

fn run_script_as_self(body: &str) -> Result<(), String> {
    let path = write_temp_script(body)?;
    #[cfg(windows)]
    let status = Command::new("cmd.exe")
        .args(["/C"])
        .arg(&path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .status();
    #[cfg(not(windows))]
    let status = Command::new("/bin/sh")
        .arg(&path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .status();
    let _ = fs::remove_file(&path);
    match status {
        Ok(s) if s.success() => Ok(()),
        Ok(s) => Err(format!("elevated script failed (exit {:?})", s.code())),
        Err(e) => Err(format!("run elevated script: {e}")),
    }
}

fn run_elevated_path(path: &Path, purpose: &str) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        // Prefer pkexec (GUI polkit dialog). Fall back to sudo.
        if which::which("pkexec").is_ok() {
            let out = Command::new("pkexec")
                .arg("/bin/sh")
                .arg(path)
                .output()
                .map_err(|e| format!("pkexec for {purpose}: {e}"))?;
            if out.status.success() {
                return Ok(());
            }
            let stderr = String::from_utf8_lossy(&out.stderr);
            // User cancelled polkit → clear message.
            if stderr.contains("dismissed")
                || stderr.contains("not authorized")
                || out.status.code() == Some(126)
                || out.status.code() == Some(127)
            {
                return Err(format!(
                    "administrator authorization cancelled or denied for {purpose}"
                ));
            }
            // Try sudo as fallback when pkexec binary exists but policy fails.
        }
        if which::which("sudo").is_ok() {
            // -A uses askpass if set; otherwise may prompt on TTY.
            // Prefer -n first? No — we want a prompt. Use plain sudo.
            let out = Command::new("sudo")
                .arg("-n")
                .arg("/bin/sh")
                .arg(path)
                .output();
            if let Ok(out) = out {
                if out.status.success() {
                    return Ok(());
                }
            }
            // Interactive sudo (may open terminal askpass on desktop).
            let out = Command::new("sudo")
                .arg("/bin/sh")
                .arg(path)
                .output()
                .map_err(|e| format!("sudo for {purpose}: {e}"))?;
            if out.status.success() {
                return Ok(());
            }
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(if stderr.is_empty() {
                format!("sudo elevation failed for {purpose}")
            } else {
                format!("sudo elevation failed for {purpose}: {stderr}")
            });
        }
        Err(format!("no pkexec/sudo available for {purpose}"))
    }

    #[cfg(target_os = "macos")]
    {
        // osascript prompts for admin password in a system dialog.
        let script_path = path.display().to_string().replace('\'', "'\\''");
        let osa = format!(
            "do shell script \"/bin/sh '{script_path}'\" with administrator privileges"
        );
        let out = Command::new("osascript")
            .arg("-e")
            .arg(&osa)
            .output()
            .map_err(|e| format!("osascript elevation for {purpose}: {e}"))?;
        if out.status.success() {
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            if stderr.contains("User canceled") || stderr.contains("-128") {
                Err(format!(
                    "administrator authorization cancelled for {purpose}"
                ))
            } else {
                Err(format!(
                    "macOS elevation failed for {purpose}: {stderr}"
                ))
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        // UAC prompt via PowerShell Start-Process -Verb RunAs -Wait.
        let path_str = path.display().to_string().replace('\'', "''");
        let ps = format!(
            "$p = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/C','{path_str}') -Verb RunAs -Wait -PassThru; exit $p.ExitCode"
        );
        let launcher = which::which("powershell.exe")
            .or_else(|_| which::which("powershell"))
            .unwrap_or_else(|_| PathBuf::from("powershell.exe"));
        let out = Command::new(launcher)
            .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command"])
            .arg(&ps)
            .output()
            .map_err(|e| format!("UAC elevation for {purpose}: {e}"))?;
        if out.status.success() {
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            if stderr.is_empty() {
                Err(format!(
                    "UAC elevation cancelled or failed for {purpose} (exit {:?})",
                    out.status.code()
                ))
            } else {
                Err(format!("UAC elevation failed for {purpose}: {stderr}"))
            }
        }
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        let _ = (path, purpose);
        Err("elevation not supported".into())
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn euid() -> u32 {
    if let Ok(status) = fs::read_to_string("/proc/self/status") {
        for line in status.lines() {
            if let Some(rest) = line.strip_prefix("Uid:") {
                let parts: Vec<&str> = rest.split_whitespace().collect();
                if parts.len() >= 2 {
                    if let Ok(euid) = parts[1].parse::<u32>() {
                        return euid;
                    }
                }
            }
        }
    }
    // macOS has no /proc — use libc.
    #[cfg(target_os = "macos")]
    {
        return unsafe { libc::geteuid() };
    }
    #[cfg(not(target_os = "macos"))]
    {
        1
    }
}

#[cfg(target_os = "windows")]
fn windows_is_admin() -> bool {
    // Lightweight check: open a handle that requires admin, or use net session.
    // `net session` returns 0 only when elevated.
    Command::new("net")
        .args(["session"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn elevation_status_is_non_empty() {
        assert!(!elevation_status_detail().is_empty());
    }

    #[test]
    fn run_script_as_self_echo() {
        // Always works without elevation.
        if is_currently_elevated() || cfg!(unix) {
            // trivial true script
            #[cfg(unix)]
            {
                run_script_as_self("true").unwrap();
            }
        }
    }
}
