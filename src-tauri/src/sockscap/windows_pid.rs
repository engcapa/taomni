//! Map local TCP source ports → owning PID / executable path (Windows).
//!
//! Used by the WinDivert NETWORK NAT path to apply application and runtime
//! process selectors without a SOCKET-layer divert (plan §5 / §16.4).

#![cfg(windows)]

use std::collections::HashMap;
use std::path::PathBuf;

use winapi::shared::minwindef::{DWORD, FALSE};
use winapi::shared::ntdef::HANDLE;
use winapi::shared::tcpmib::{MIB_TCPROW_OWNER_PID, MIB_TCPTABLE_OWNER_PID};
use winapi::shared::winerror::ERROR_INSUFFICIENT_BUFFER;
use winapi::um::errhandlingapi::GetLastError;
use winapi::um::handleapi::CloseHandle;
use winapi::um::iphlpapi::GetExtendedTcpTable;
use winapi::um::processthreadsapi::OpenProcess;
use winapi::um::winbase::QueryFullProcessImageNameW;
use winapi::um::winnt::{PROCESS_QUERY_LIMITED_INFORMATION, PVOID};

// TCP_TABLE_CLASS::TCP_TABLE_OWNER_PID_ALL = 5 (iphlpapi.h)
const TCP_TABLE_OWNER_PID_ALL: u32 = 5;

/// Snapshot of local TCP endpoints with owner PIDs.
pub fn tcp_owner_map() -> HashMap<u16, u32> {
    let mut map = HashMap::new();
    unsafe {
        let mut size: DWORD = 0;
        let mut ret = GetExtendedTcpTable(
            std::ptr::null_mut(),
            &mut size,
            FALSE,
            2, // AF_INET
            std::mem::transmute(TCP_TABLE_OWNER_PID_ALL),
            0,
        );
        if ret as u32 != ERROR_INSUFFICIENT_BUFFER && size == 0 {
            return map;
        }
        let mut buf = vec![0u8; size as usize];
        ret = GetExtendedTcpTable(
            buf.as_mut_ptr() as PVOID,
            &mut size,
            FALSE,
            2,
            std::mem::transmute(TCP_TABLE_OWNER_PID_ALL),
            0,
        );
        if ret != 0 {
            return map;
        }
        let table = &*(buf.as_ptr() as *const MIB_TCPTABLE_OWNER_PID);
        let n = table.dwNumEntries as usize;
        // MIB_TCPTABLE_OWNER_PID layout: dwNumEntries then table[1]
        let rows_ptr = std::ptr::addr_of!((*table).table) as *const MIB_TCPROW_OWNER_PID;
        for i in 0..n {
            let row = &*rows_ptr.add(i);
            // dwLocalPort is network byte order.
            let port = u16::from_be((row.dwLocalPort & 0xFFFF) as u16);
            if port != 0 && row.dwOwningPid != 0 {
                map.insert(port, row.dwOwningPid);
            }
        }
    }
    map
}

/// Best-effort full image path for a PID.
pub fn process_image_path(pid: u32) -> Option<PathBuf> {
    unsafe {
        let h: HANDLE = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
        if h.is_null() {
            return None;
        }
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as DWORD;
        let ok = QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut len);
        CloseHandle(h);
        if ok == FALSE || len == 0 {
            let _ = GetLastError();
            return None;
        }
        let s = String::from_utf16_lossy(&buf[..len as usize]);
        Some(PathBuf::from(s))
    }
}
