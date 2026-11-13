//! Explorer-compatible CF_HDROP with explicit native allocation/owner lifetime.

use super::super::clipboard::file_clipboard::{MAX_FILES, MAX_PATH_BYTES, error, hdrop};
use std::ptr;
use winapi::shared::minwindef::HGLOBAL;
use winapi::um::errhandlingapi::GetLastError;
use winapi::um::libloaderapi::GetModuleHandleW;
use winapi::um::shellapi::DragQueryFileW;
use winapi::um::winbase::{
    GMEM_MOVEABLE, GlobalAlloc, GlobalFree, GlobalLock, GlobalSize, GlobalUnlock,
};
use winapi::um::winuser::{
    CF_HDROP, CloseClipboard, CreateWindowExW, DestroyWindow, EmptyClipboard, GetClipboardData,
    HWND_MESSAGE, IsClipboardFormatAvailable, OpenClipboard, RegisterClipboardFormatW,
    SetClipboardData,
};

struct ClipboardGuard;
impl Drop for ClipboardGuard {
    fn drop(&mut self) {
        unsafe {
            CloseClipboard();
        }
    }
}

struct GlobalMemory(HGLOBAL);
impl Drop for GlobalMemory {
    fn drop(&mut self) {
        unsafe {
            GlobalFree(self.0);
        }
    }
}

struct OwnerWindow(winapi::shared::windef::HWND);
impl Drop for OwnerWindow {
    fn drop(&mut self) {
        unsafe {
            DestroyWindow(self.0);
        }
    }
}

fn last_error(detail: &str) -> String {
    let code = unsafe { GetLastError() };
    let kind = if code == 5 {
        "permission_denied"
    } else {
        "unavailable"
    };
    error(kind, format!("{detail} (Win32 {code})"))
}

pub fn clipboard_read_files() -> Result<Vec<String>, String> {
    if unsafe { OpenClipboard(ptr::null_mut()) } == 0 {
        return Err(last_error("cannot open Windows clipboard"));
    }
    let _clipboard = ClipboardGuard;
    let paths = read_files_locked()?;
    super::super::clipboard::file_clipboard::validate_paths(&paths)?;
    Ok(paths)
}

fn read_files_locked() -> Result<Vec<String>, String> {
    if unsafe { IsClipboardFormatAvailable(CF_HDROP) } == 0 {
        return Ok(Vec::new());
    }
    let handle = unsafe { GetClipboardData(CF_HDROP) };
    if handle.is_null() {
        return Err(last_error("advertised CF_HDROP data could not be read"));
    }
    let size = unsafe { GlobalSize(handle as HGLOBAL) };
    if size < hdrop::HEADER_BYTES
        || size > 2 * super::super::clipboard::file_clipboard::MAX_PAYLOAD_BYTES
    {
        return Err(error("invalid", "invalid CF_HDROP allocation size"));
    }
    let count = unsafe { DragQueryFileW(handle as _, u32::MAX, ptr::null_mut(), 0) };
    if count as usize > MAX_FILES {
        return Err(error(
            "invalid",
            format!("accepts at most {MAX_FILES} paths"),
        ));
    }
    let mut paths = Vec::with_capacity(count as usize);
    for index in 0..count {
        let len = unsafe { DragQueryFileW(handle as _, index, ptr::null_mut(), 0) };
        if len == 0 || len as usize > MAX_PATH_BYTES {
            return Err(error("invalid", "empty or oversized CF_HDROP path"));
        }
        let mut buf = vec![0u16; len as usize + 1];
        let written = unsafe { DragQueryFileW(handle as _, index, buf.as_mut_ptr(), len + 1) };
        if written != len {
            return Err(error(
                "unavailable",
                "CF_HDROP path could not be read completely",
            ));
        }
        paths.push(String::from_utf16(&buf[..written as usize]).map_err(|_| {
            error(
                "invalid",
                "CF_HDROP path cannot be represented losslessly in IPC",
            )
        })?);
    }
    Ok(paths)
}

pub fn clipboard_write_files(paths: &[String]) -> Result<(), String> {
    clipboard_write_files_with_cut(paths, false)
}

pub fn clipboard_write_files_with_cut(paths: &[String], cut: bool) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    write_files_conditionally(paths, cut, None).map(|_| ())
}

pub fn clipboard_update_cut_files(
    expected: &[String],
    remaining: &[String],
) -> Result<bool, String> {
    write_files_conditionally(remaining, true, Some(expected))
}

fn write_files_conditionally(
    paths: &[String],
    cut: bool,
    expected: Option<&[String]>,
) -> Result<bool, String> {
    let bytes = hdrop::encode(paths)?;
    let handle = unsafe { GlobalAlloc(GMEM_MOVEABLE, bytes.len()) };
    if handle.is_null() {
        return Err(last_error("CF_HDROP allocation failed"));
    }
    let allocation = GlobalMemory(handle);
    let memory = unsafe { GlobalLock(handle) };
    if memory.is_null() {
        return Err(last_error("CF_HDROP allocation could not be locked"));
    }
    unsafe {
        ptr::copy_nonoverlapping(bytes.as_ptr(), memory as *mut u8, bytes.len());
        GlobalUnlock(handle);
    }
    // OpenClipboard(NULL) + EmptyClipboard sets a NULL owner; per Win32 docs,
    // SetClipboardData then fails. Use a short-lived message-only native window
    // for the handoff. CF_HDROP is immediate data, so the system owns the HGLOBAL
    // afterwards and does not need a surviving delayed-rendering window.
    let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
    let hwnd = unsafe {
        CreateWindowExW(
            0,
            class.as_ptr(),
            ptr::null(),
            0,
            0,
            0,
            0,
            0,
            HWND_MESSAGE,
            ptr::null_mut(),
            GetModuleHandleW(ptr::null()),
            ptr::null_mut(),
        )
    };
    if hwnd.is_null() {
        return Err(last_error("clipboard owner window creation failed"));
    }
    let _owner = OwnerWindow(hwnd);
    if unsafe { OpenClipboard(hwnd) } == 0 {
        return Err(last_error("cannot open Windows clipboard"));
    }
    let _clipboard = ClipboardGuard;
    if let Some(expected) = expected {
        if read_files_locked()? != expected {
            return Ok(false);
        }
    }
    if unsafe { EmptyClipboard() } == 0 {
        return Err(last_error("cannot empty Windows clipboard"));
    }
    if paths.is_empty() {
        return Ok(true);
    }
    if unsafe { SetClipboardData(CF_HDROP, handle) }.is_null() {
        return Err(last_error("Windows rejected CF_HDROP"));
    }
    // The operating system, not our allocation guard, frees the published data.
    std::mem::forget(allocation);
    // Explorer consumes this standard DWORD format together with CF_HDROP.
    // MOVE=2 is only advertised for an explicit cut; legacy writers still copy.
    let format_name: Vec<u16> = "Preferred DropEffect\0".encode_utf16().collect();
    let format = unsafe { RegisterClipboardFormatW(format_name.as_ptr()) };
    if format == 0 {
        return Err(last_error("cannot register Preferred DropEffect"));
    }
    let effect_handle = unsafe { GlobalAlloc(GMEM_MOVEABLE, std::mem::size_of::<u32>()) };
    if effect_handle.is_null() {
        return Err(last_error("drop effect allocation failed"));
    }
    let effect_allocation = GlobalMemory(effect_handle);
    let effect_memory = unsafe { GlobalLock(effect_handle) };
    if effect_memory.is_null() {
        return Err(last_error("drop effect allocation could not be locked"));
    }
    unsafe {
        *(effect_memory as *mut u32) = if cut { 2 } else { 1 };
        GlobalUnlock(effect_handle);
    }
    if unsafe { SetClipboardData(format, effect_handle) }.is_null() {
        return Err(last_error("Windows rejected Preferred DropEffect"));
    }
    std::mem::forget(effect_allocation);
    Ok(true)
}
