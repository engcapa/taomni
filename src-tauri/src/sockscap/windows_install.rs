//! Bundle + UAC install of WinDivert for Windows Sockscap (plan Phase 5).
//!
//! Runtime files ship inside the app package under `resources/windivert/`.
//! On first Start we copy them into System32 (or the app data dir) and load the
//! signed driver via an elevated helper so the customer never downloads
//! WinDivert by hand.

#![cfg(windows)]

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::ptr;
use std::time::{Duration, Instant};

use winapi::shared::minwindef::{DWORD, FALSE, TRUE};
use winapi::um::handleapi::CloseHandle;
use winapi::um::processthreadsapi::{GetCurrentProcess, OpenProcessToken};
use winapi::um::securitybaseapi::GetTokenInformation;
use winapi::um::shellapi::ShellExecuteW;
use winapi::um::winnt::{TokenElevation, HANDLE, TOKEN_ELEVATION, TOKEN_QUERY};
use winapi::um::winuser::SW_HIDE;

const REQUIRED: &[&str] = &["WinDivert.dll", "WinDivert64.sys"];

/// Whether this process token is elevated (admin).
pub fn is_process_elevated() -> bool {
    unsafe {
        let mut token: HANDLE = ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == FALSE {
            return false;
        }
        let mut elev: TOKEN_ELEVATION = std::mem::zeroed();
        let mut ret_len: DWORD = 0;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            &mut elev as *mut _ as *mut _,
            std::mem::size_of::<TOKEN_ELEVATION>() as DWORD,
            &mut ret_len,
        );
        CloseHandle(token);
        ok != FALSE && elev.TokenIsElevated != 0
    }
}

/// Candidate directories that may hold the bundled WinDivert redistributable.
pub fn candidate_resource_dirs(resource_dir: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(r) = resource_dir {
        dirs.push(r.join("windivert"));
        dirs.push(r.to_path_buf());
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            dirs.push(dir.join("resources").join("windivert"));
            dirs.push(dir.join("windivert"));
            dirs.push(dir.to_path_buf());
        }
    }
    // Dev tree (`pnpm tauri dev` cwd = repo root or src-tauri).
    dirs.push(PathBuf::from("src-tauri/resources/windivert"));
    dirs.push(PathBuf::from("resources/windivert"));
    dirs
}

/// First directory that contains both WinDivert.dll and WinDivert64.sys.
pub fn find_bundled_windivert(resource_dir: Option<&Path>) -> Option<PathBuf> {
    for dir in candidate_resource_dirs(resource_dir) {
        if REQUIRED.iter().all(|f| dir.join(f).exists()) {
            return Some(dir);
        }
    }
    None
}

/// True when the runtime can load WinDivert (DLL present on PATH/System32 or
/// next to the exe). Does not prove the process is elevated.
pub fn windivert_files_installed() -> bool {
    let system = PathBuf::from(r"C:\Windows\System32");
    system.join("WinDivert.dll").exists() && system.join("WinDivert64.sys").exists()
        || find_bundled_windivert(None).is_some()
}

/// Ensure WinDivert is installed system-wide. If not elevated, relaunches an
/// elevated PowerShell installer that copies from `bundle_dir` into System32
/// and smoke-opens the driver. Returns Ok when files are in System32.
pub fn ensure_windivert_installed(bundle_dir: &Path) -> Result<(), String> {
    let sys = PathBuf::from(r"C:\Windows\System32");
    let dll_ok = sys.join("WinDivert.dll").exists();
    let sys_ok = sys.join("WinDivert64.sys").exists();
    if dll_ok && sys_ok {
        return Ok(());
    }
    if !REQUIRED.iter().all(|f| bundle_dir.join(f).exists()) {
        return Err(format!(
            "bundled WinDivert missing under {} (expected WinDivert.dll + WinDivert64.sys)",
            bundle_dir.display()
        ));
    }

    if is_process_elevated() {
        install_files_now(bundle_dir)?;
        return Ok(());
    }

    // Write a one-shot elevated installer script and wait for the marker.
    let marker = std::env::temp_dir().join(format!(
        "taomni-windivert-install-{}.ok",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&marker);
    let err_marker = marker.with_extension("err");
    let _ = std::fs::remove_file(&err_marker);

    let script = std::env::temp_dir().join(format!(
        "taomni-windivert-install-{}.ps1",
        std::process::id()
    ));
    let bundle = bundle_dir.display().to_string().replace('\'', "''");
    let marker_s = marker.display().to_string().replace('\'', "''");
    let err_s = err_marker.display().to_string().replace('\'', "''");
    let ps = format!(
        r#"$ErrorActionPreference = 'Stop'
try {{
  $src = '{bundle}'
  Copy-Item -Force (Join-Path $src 'WinDivert.dll') 'C:\Windows\System32\WinDivert.dll'
  Copy-Item -Force (Join-Path $src 'WinDivert64.sys') 'C:\Windows\System32\WinDivert64.sys'
  $code = @'
using System;
using System.Runtime.InteropServices;
public class WD {{
  [DllImport("WinDivert.dll", CallingConvention=CallingConvention.Cdecl, CharSet=CharSet.Ansi)]
  public static extern IntPtr WinDivertOpen(string filter, int layer, short priority, ulong flags);
  [DllImport("WinDivert.dll", CallingConvention=CallingConvention.Cdecl)]
  public static extern bool WinDivertClose(IntPtr handle);
}}
'@
  Add-Type -TypeDefinition $code
  $h = [WD]::WinDivertOpen('false', 0, 0, 0)
  if ($h -eq [IntPtr]::Zero -or $h -eq [IntPtr]::new(-1)) {{
    throw "WinDivertOpen failed err=$([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
  }}
  [void][WD]::WinDivertClose($h)
  Set-Content -Path '{marker_s}' -Value 'ok'
}} catch {{
  Set-Content -Path '{err_s}' -Value $_.Exception.Message
  exit 1
}}
"#
    );
    std::fs::write(&script, ps).map_err(|e| format!("write install script: {e}"))?;

    let status = shell_execute_runas(
        "powershell.exe",
        &format!(
            "-NoProfile -ExecutionPolicy Bypass -File \"{}\"",
            script.display()
        ),
    )?;
    if status < 32 {
        return Err(format!(
            "UAC elevation failed (ShellExecute status {status}). Allow the prompt to install the capture driver."
        ));
    }

    // Wait up to 60s for the elevated script to finish.
    let deadline = Instant::now() + Duration::from_secs(60);
    while Instant::now() < deadline {
        if marker.exists() {
            let _ = std::fs::remove_file(&script);
            return Ok(());
        }
        if err_marker.exists() {
            let msg = std::fs::read_to_string(&err_marker).unwrap_or_else(|_| "unknown".into());
            let _ = std::fs::remove_file(&script);
            return Err(format!("elevated WinDivert install failed: {msg}"));
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    Err("timed out waiting for elevated WinDivert install (UAC cancelled?)".into())
}

fn install_files_now(bundle_dir: &Path) -> Result<(), String> {
    let sys = PathBuf::from(r"C:\Windows\System32");
    for f in REQUIRED {
        let src = bundle_dir.join(f);
        let dst = sys.join(f);
        std::fs::copy(&src, &dst).map_err(|e| {
            format!(
                "copy {} → {}: {e} (need Administrator)",
                src.display(),
                dst.display()
            )
        })?;
    }
    Ok(())
}

/// ShellExecuteW "runas" — returns the HINSTANCE cast value (>=32 means success
/// launching the elevated process, not that the child succeeded).
fn shell_execute_runas(file: &str, params: &str) -> Result<isize, String> {
    let file_w = wide(file);
    let params_w = wide(params);
    let op = wide("runas");
    let rc = unsafe {
        ShellExecuteW(
            ptr::null_mut(),
            op.as_ptr(),
            file_w.as_ptr(),
            params_w.as_ptr(),
            ptr::null(),
            SW_HIDE,
        ) as isize
    };
    Ok(rc)
}

fn wide(s: &str) -> Vec<u16> {
    OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
}

/// Relaunch the current executable elevated (optional whole-app elevation).
#[allow(dead_code)]
pub fn relaunch_self_elevated() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let status = shell_execute_runas(&exe.to_string_lossy(), "")?;
    if status < 32 {
        return Err(format!("failed to relaunch elevated (status {status})"));
    }
    Ok(())
}
