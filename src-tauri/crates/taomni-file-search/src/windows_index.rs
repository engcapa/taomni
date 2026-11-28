//! Read Windows Search through its OLE DB provider under the desktop user.
use crate::providers::{Indexed, collect};
use crate::{Provider, check_cancelled};
use base64::{Engine, engine::general_purpose::STANDARD};
use std::ffi::OsString;
use std::os::windows::ffi::OsStringExt;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::time::Duration;
use tokio::process::Command;
use windows::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives};
use windows::Win32::System::Services::{
    CloseServiceHandle, OpenSCManagerW, OpenServiceW, QueryServiceStatus, SC_HANDLE,
    SC_MANAGER_CONNECT, SERVICE_QUERY_STATUS, SERVICE_RUNNING, SERVICE_STATUS,
};
use windows::Win32::System::SystemInformation::GetSystemDirectoryW;
use windows::Win32::System::Threading::{BELOW_NORMAL_PRIORITY_CLASS, CREATE_NO_WINDOW};
use windows::core::{PCWSTR, w};

pub(super) fn fixed_drive_mask() -> u32 {
    // SAFETY: The OS call takes no arguments. GetDriveTypeW receives a
    // temporary NUL-terminated drive root valid for the call.
    let logical = unsafe { GetLogicalDrives() };
    (0..26)
        .filter(|&i| logical & (1 << i) != 0)
        .fold(0, |mask, i| {
            let root = [u16::from(b'A' + i), 58, 92, 0];
            match unsafe { GetDriveTypeW(PCWSTR(root.as_ptr())) } {
                3 | 6 => mask | (1 << i),
                _ => mask,
            }
        })
}

struct ServiceHandle(SC_HANDLE);

impl Drop for ServiceHandle {
    fn drop(&mut self) {
        // SAFETY: Only live handles returned by the service manager are stored.
        let _ = unsafe { CloseServiceHandle(self.0) };
    }
}

fn index_running() -> bool {
    // SAFETY: A null server and database select the local default manager.
    // QueryServiceStatus writes into an initialized, writable SERVICE_STATUS.
    unsafe {
        let Ok(manager) = OpenSCManagerW(PCWSTR::null(), PCWSTR::null(), SC_MANAGER_CONNECT) else {
            return false;
        };
        let manager = ServiceHandle(manager);
        let Ok(service) = OpenServiceW(manager.0, w!("WSearch"), SERVICE_QUERY_STATUS) else {
            return false;
        };
        let service = ServiceHandle(service);
        let mut status = SERVICE_STATUS::default();
        QueryServiceStatus(service.0, &mut status).is_ok()
            && status.dwCurrentState == SERVICE_RUNNING
    }
}

fn executable() -> Option<PathBuf> {
    let mut directory = [0; 32768];
    // SAFETY: The slice is a writable UTF-16 buffer for the duration of the call.
    let len = unsafe { GetSystemDirectoryW(Some(&mut directory)) } as usize;
    if len == 0 || len >= directory.len() {
        return None;
    }
    let directory = PathBuf::from(OsString::from_wide(&directory[..len]));
    Some(directory.join("WindowsPowerShell/v1.0/powershell.exe"))
}

fn search_pattern(query: &str, separator: &str) -> String {
    let mut pattern = "%".to_owned();
    for (i, c) in query.chars().enumerate() {
        if i != 0 {
            pattern.push_str(separator);
        }
        match c {
            '\'' => pattern.push_str("''"),
            '%' => pattern.push_str("[%]"),
            '_' => pattern.push_str("[_]"),
            '[' => pattern.push_str("[[]"),
            ']' => pattern.push_str("[]]"),
            _ => pattern.push(c),
        }
    }
    pattern.push('%');
    pattern
}

pub(super) async fn lookup(query: &str, cancelled: &AtomicBool) -> Result<Indexed, String> {
    check_cancelled(cancelled)?;
    // A stopped or unavailable service needs neither a subprocess nor a disk crawl.
    let Some(program) = executable().filter(|_| index_running()) else {
        return Ok(Indexed::unavailable());
    };
    let mut command = Command::new(program);
    // The encoded command is fixed. The query travels only as escaped data for LIKE.
    let encoded = STANDARD.encode(
        include_str!("windows_search.ps1")
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>(),
    );
    command
        .creation_flags(CREATE_NO_WINDOW.0 | BELOW_NORMAL_PRIORITY_CLASS.0)
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
        ])
        .arg(encoded)
        .env("TAOMNI_FILE_SEARCH_LITERAL", search_pattern(query, ""))
        .env("TAOMNI_FILE_SEARCH_FUZZY", search_pattern(query, "%"));
    collect(
        command,
        Provider::WindowsSearch,
        Duration::from_millis(1600),
        cancelled,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_wildcards_and_quotes_for_search_sql() {
        assert_eq!(search_pattern("a'b[%_]", ""), "%a''b[[][%][_][]]%");
        assert_eq!(search_pattern("ac", "%"), "%a%c%");
    }
}
