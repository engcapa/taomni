//! Process enumeration for the App-mode picker + path normalization.

use serde::{Deserialize, Serialize};

use crate::sockscap::paths::normalize_exe_path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub pid: u32,
    pub name: String,
    pub path: String,
}

/// Best-effort process list (deduped by path, capped).
pub fn list_processes() -> Result<Vec<ProcessInfo>, String> {
    #[cfg(windows)]
    {
        list_processes_windows()
    }
    #[cfg(not(windows))]
    {
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
    use std::collections::HashSet;
    use std::mem::{size_of, zeroed};
    use std::os::windows::ffi::OsStringExt;
    use winapi::shared::minwindef::{DWORD, FALSE, MAX_PATH};
    use winapi::um::handleapi::{CloseHandle, INVALID_HANDLE_VALUE};
    use winapi::um::processthreadsapi::OpenProcess;
    use winapi::um::tlhelp32::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use winapi::um::winnt::{HANDLE, PROCESS_QUERY_LIMITED_INFORMATION};

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn QueryFullProcessImageNameW(
            h: HANDLE,
            flags: DWORD,
            buf: *mut u16,
            size: *mut DWORD,
        ) -> i32;
    }

    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return Err(format!(
                "CreateToolhelp32Snapshot failed: {}",
                std::io::Error::last_os_error()
            ));
        }

        let mut pe: PROCESSENTRY32W = zeroed();
        pe.dwSize = size_of::<PROCESSENTRY32W>() as DWORD;

        let mut out: Vec<ProcessInfo> = Vec::new();
        let mut seen_paths: HashSet<String> = HashSet::new();

        let mut ok = Process32FirstW(snap, &mut pe);
        while ok != FALSE {
            let pid = pe.th32ProcessID;
            if pid != 0 {
                let name = {
                    let len = pe
                        .szExeFile
                        .iter()
                        .position(|&c| c == 0)
                        .unwrap_or(pe.szExeFile.len());
                    String::from_utf16_lossy(&pe.szExeFile[..len])
                };

                let path = {
                    let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
                    if h.is_null() {
                        String::new()
                    } else {
                        let mut buf = vec![0u16; MAX_PATH as usize * 4];
                        let mut size = buf.len() as DWORD;
                        let q = QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut size);
                        CloseHandle(h);
                        if q != 0 && size > 0 {
                            let os = std::ffi::OsString::from_wide(&buf[..size as usize]);
                            os.to_string_lossy().to_string()
                        } else {
                            String::new()
                        }
                    }
                };

                let path_norm = if path.is_empty() {
                    String::new()
                } else {
                    normalize_exe_path(&path)
                };

                // Prefer entries with a full path; dedupe by normalized path.
                if !path_norm.is_empty() {
                    if seen_paths.insert(path_norm.clone()) {
                        out.push(ProcessInfo {
                            pid,
                            name: if name.is_empty() {
                                path_norm
                                    .rsplit('\\')
                                    .next()
                                    .unwrap_or("unknown")
                                    .to_string()
                            } else {
                                name
                            },
                            path,
                        });
                    }
                } else if !name.is_empty() {
                    out.push(ProcessInfo {
                        pid,
                        name,
                        path: String::new(),
                    });
                }
            }

            if out.len() >= 800 {
                break;
            }
            ok = Process32NextW(snap, &mut pe);
        }

        CloseHandle(snap);
        out.sort_by(|a, b| {
            a.name
                .to_ascii_lowercase()
                .cmp(&b.name.to_ascii_lowercase())
        });
        Ok(out)
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sockscap::paths::{normalize_exe_path, paths_match_exe};

    #[test]
    fn normalize_slashes_and_case() {
        assert_eq!(
            normalize_exe_path(r"C:\Program Files\App\app.EXE"),
            r"c:\program files\app\app.exe"
        );
        assert!(paths_match_exe(
            r"C:\Program Files\App\chrome.exe",
            r"chrome.exe"
        ));
    }
}
