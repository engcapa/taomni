use super::paths::{existing_file_from, initial_dir_from};
use std::ffi::OsStr;
use std::mem::{size_of, zeroed};
use std::os::windows::ffi::OsStrExt;
use std::ptr;
use winapi::um::commdlg::{
    CommDlgExtendedError, GetOpenFileNameW, OFN_ALLOWMULTISELECT, OFN_EXPLORER, OFN_FILEMUSTEXIST,
    OFN_HIDEREADONLY, OFN_NOCHANGEDIR, OFN_PATHMUSTEXIST, OPENFILENAMEW,
};
use winapi::um::shellapi::DragQueryFileW;
use winapi::um::winbase::{
    GMEM_MOVEABLE, GMEM_ZEROINIT, GlobalAlloc, GlobalFree, GlobalLock, GlobalUnlock,
};
use winapi::um::winuser::{
    CF_HDROP, CloseClipboard, EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable,
    OpenClipboard, SetClipboardData,
};

#[repr(C)]
struct DropFiles {
    p_files: u32,
    x: i32,
    y: i32,
    f_nc: i32,
    f_wide: i32,
}

pub fn select_private_key_file(current_path: Option<&str>) -> Result<Option<String>, String> {
    let mut file_buf = [0u16; 32768];
    if let Some(file) = existing_file_from(current_path) {
        let wide = wide_os(file.as_os_str());
        let len = wide.len().saturating_sub(1).min(file_buf.len() - 1);
        file_buf[..len].copy_from_slice(&wide[..len]);
    }
    let filter = wide_filter(&[
        ("Private key files", "*.pem;*.key;id_*;*.ppk;*"),
        ("All files", "*"),
    ]);
    let title = wide("Select private key");
    let initial_dir = initial_dir_from(current_path).map(|path| wide_os(path.as_os_str()));
    open_file_dialog(&mut file_buf, &filter, &title, initial_dir.as_ref())
}

pub fn select_upload_file() -> Result<Vec<String>, String> {
    // Use a large buffer: Windows multi-select format is
    // "dir\0file1\0file2\0\0" so we need plenty of space.
    let mut file_buf = [0u16; 65536];
    let filter = wide_filter(&[("All files", "*")]);
    let title = wide("Select files to send");
    let initial_dir = dirs::home_dir().map(|p| wide_os(p.as_os_str()));

    let mut ofn: OPENFILENAMEW = unsafe { zeroed() };
    ofn.lStructSize = size_of::<OPENFILENAMEW>() as u32;
    ofn.lpstrFilter = filter.as_ptr();
    ofn.lpstrFile = file_buf.as_mut_ptr();
    ofn.nMaxFile = file_buf.len() as u32;
    ofn.lpstrTitle = title.as_ptr();
    ofn.lpstrInitialDir = initial_dir
        .as_ref()
        .map(|dir| dir.as_ptr())
        .unwrap_or(ptr::null());
    ofn.Flags = OFN_EXPLORER
        | OFN_FILEMUSTEXIST
        | OFN_PATHMUSTEXIST
        | OFN_HIDEREADONLY
        | OFN_NOCHANGEDIR
        | OFN_ALLOWMULTISELECT;

    let ok = unsafe { GetOpenFileNameW(&mut ofn) };
    if ok == 0 {
        let err = unsafe { CommDlgExtendedError() };
        return if err == 0 {
            Ok(vec![])
        } else {
            Err(format!("Windows file dialog failed: 0x{err:04x}"))
        };
    }

    // Parse the result buffer.
    // Single file: one null-terminated string.
    // Multiple files: "dir\0file1\0file2\0\0"
    let segments: Vec<String> = file_buf
        .split(|&c| c == 0)
        .filter(|s| !s.is_empty())
        .map(|s| String::from_utf16_lossy(s))
        .collect();

    Ok(match segments.as_slice() {
        [] => vec![],
        [single] => vec![single.clone()],
        [dir, files @ ..] => files.iter().map(|f| format!("{}\\{}", dir, f)).collect(),
    })
}

fn open_file_dialog(
    file_buf: &mut [u16; 32768],
    filter: &[u16],
    title: &[u16],
    initial_dir: Option<&Vec<u16>>,
) -> Result<Option<String>, String> {
    let mut ofn: OPENFILENAMEW = unsafe { zeroed() };
    ofn.lStructSize = size_of::<OPENFILENAMEW>() as u32;
    ofn.lpstrFilter = filter.as_ptr();
    ofn.lpstrFile = file_buf.as_mut_ptr();
    ofn.nMaxFile = file_buf.len() as u32;
    ofn.lpstrTitle = title.as_ptr();
    ofn.lpstrInitialDir = initial_dir.map(|dir| dir.as_ptr()).unwrap_or(ptr::null());
    ofn.Flags =
        OFN_EXPLORER | OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_HIDEREADONLY | OFN_NOCHANGEDIR;

    let ok = unsafe { GetOpenFileNameW(&mut ofn) };
    if ok != 0 {
        let len = file_buf
            .iter()
            .position(|&ch| ch == 0)
            .unwrap_or(file_buf.len());
        return Ok(Some(String::from_utf16_lossy(&file_buf[..len])));
    }

    let err = unsafe { CommDlgExtendedError() };
    if err == 0 {
        Ok(None)
    } else {
        Err(format!("Windows file dialog failed: 0x{err:04x}"))
    }
}

fn wide(value: &str) -> Vec<u16> {
    wide_os(OsStr::new(value))
}

fn wide_os(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(std::iter::once(0)).collect()
}

fn wide_filter(filters: &[(&str, &str)]) -> Vec<u16> {
    let mut out = Vec::new();
    for (name, pattern) in filters {
        out.extend(OsStr::new(name).encode_wide());
        out.push(0);
        out.extend(OsStr::new(pattern).encode_wide());
        out.push(0);
    }
    out.push(0);
    out
}

pub fn select_save_directory(current_path: Option<&str>) -> Result<Option<String>, String> {
    use std::process::Command;
    let initial = super::paths::initial_dir_from(current_path)
        .or_else(dirs::download_dir)
        .or_else(dirs::home_dir)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let script = format!(
        r#"Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = 'Select save directory'; $d.SelectedPath = '{}'; if ($d.ShowDialog() -eq 'OK') {{ $d.SelectedPath }} else {{ '' }}"#,
        initial.replace('\'', "''")
    );
    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .map_err(|e| format!("powershell: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("powershell: {}", stderr.trim()));
    }
    let path = String::from_utf8_lossy(&output.stdout)
        .trim_end_matches(&['\r', '\n'][..])
        .to_string();
    Ok((!path.is_empty()).then_some(path))
}

pub fn select_folder_path(current_path: Option<&str>) -> Result<Option<String>, String> {
    // Folder pickers reuse the same PowerShell FolderBrowserDialog as
    // select_save_directory; only the dialog title differs.
    use std::process::Command;
    let initial = super::paths::initial_dir_from(current_path)
        .or_else(dirs::home_dir)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let script = format!(
        r#"Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = 'Select folder to open'; $d.SelectedPath = '{}'; if ($d.ShowDialog() -eq 'OK') {{ $d.SelectedPath }} else {{ '' }}"#,
        initial.replace('\'', "''")
    );
    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .map_err(|e| format!("powershell: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("powershell: {}", stderr.trim()));
    }
    let path = String::from_utf8_lossy(&output.stdout)
        .trim_end_matches(&['\r', '\n'][..])
        .to_string();
    Ok((!path.is_empty()).then_some(path))
}

pub fn select_file_path(current_path: Option<&str>) -> Result<Option<String>, String> {
    let mut file_buf = [0u16; 32768];
    if let Some(file) = existing_file_from(current_path) {
        let wide = wide_os(file.as_os_str());
        let len = wide.len().saturating_sub(1).min(file_buf.len() - 1);
        file_buf[..len].copy_from_slice(&wide[..len]);
    }
    let filter = wide_filter(&[("All files", "*")]);
    let title = wide("Select file to open");
    let initial_dir = initial_dir_from(current_path).map(|path| wide_os(path.as_os_str()));
    open_file_dialog(&mut file_buf, &filter, &title, initial_dir.as_ref())
}

pub fn select_save_file_path(
    default_name: Option<&str>,
    current_path: Option<&str>,
) -> Result<Option<String>, String> {
    use winapi::um::commdlg::{GetSaveFileNameW, OFN_OVERWRITEPROMPT};

    let mut file_buf = [0u16; 32768];
    if let Some(name) = default_name {
        let wide = wide(name);
        let len = wide.len().saturating_sub(1).min(file_buf.len() - 1);
        file_buf[..len].copy_from_slice(&wide[..len]);
    }
    let filter = wide_filter(&[("All files", "*")]);
    let title = wide("Save as");
    let initial_dir = super::paths::initial_dir_from(current_path)
        .or_else(dirs::download_dir)
        .or_else(dirs::home_dir)
        .map(|p| wide_os(p.as_os_str()));

    let mut ofn: OPENFILENAMEW = unsafe { zeroed() };
    ofn.lStructSize = size_of::<OPENFILENAMEW>() as u32;
    ofn.lpstrFilter = filter.as_ptr();
    ofn.lpstrFile = file_buf.as_mut_ptr();
    ofn.nMaxFile = file_buf.len() as u32;
    ofn.lpstrTitle = title.as_ptr();
    ofn.lpstrInitialDir = initial_dir
        .as_ref()
        .map(|dir| dir.as_ptr())
        .unwrap_or(ptr::null());
    ofn.Flags =
        OFN_EXPLORER | OFN_PATHMUSTEXIST | OFN_HIDEREADONLY | OFN_NOCHANGEDIR | OFN_OVERWRITEPROMPT;

    let ok = unsafe { GetSaveFileNameW(&mut ofn) };
    if ok != 0 {
        let len = file_buf
            .iter()
            .position(|&ch| ch == 0)
            .unwrap_or(file_buf.len());
        return Ok(Some(String::from_utf16_lossy(&file_buf[..len])));
    }

    let err = unsafe { CommDlgExtendedError() };
    if err == 0 {
        Ok(None)
    } else {
        Err(format!("Windows save dialog failed: 0x{err:04x}"))
    }
}

pub fn clipboard_read_files() -> Result<Vec<String>, String> {
    struct ClipboardGuard;
    impl Drop for ClipboardGuard {
        fn drop(&mut self) {
            unsafe {
                CloseClipboard();
            }
        }
    }

    let opened = unsafe { OpenClipboard(ptr::null_mut()) };
    if opened == 0 {
        return Err("clipboard open failed".to_string());
    }
    let _guard = ClipboardGuard;

    if unsafe { IsClipboardFormatAvailable(CF_HDROP) } == 0 {
        return Ok(Vec::new());
    }
    let handle = unsafe { GetClipboardData(CF_HDROP) };
    if handle.is_null() {
        return Ok(Vec::new());
    }

    let count = unsafe { DragQueryFileW(handle as _, u32::MAX, ptr::null_mut(), 0) };
    let mut out = Vec::with_capacity(count as usize);
    for i in 0..count {
        let len = unsafe { DragQueryFileW(handle as _, i, ptr::null_mut(), 0) };
        if len == 0 {
            continue;
        }
        let mut buf = vec![0u16; len as usize + 1];
        let written = unsafe { DragQueryFileW(handle as _, i, buf.as_mut_ptr(), len + 1) };
        if written == 0 {
            continue;
        }
        out.push(String::from_utf16_lossy(&buf[..written as usize]));
    }
    Ok(out)
}

pub fn clipboard_write_files(paths: &[String]) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }

    let mut wide_paths = Vec::new();
    for path in paths {
        wide_paths.extend(OsStr::new(path).encode_wide());
        wide_paths.push(0);
    }
    wide_paths.push(0);

    let header_size = size_of::<DropFiles>();
    let total_bytes = header_size + wide_paths.len() * size_of::<u16>();
    let handle = unsafe { GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, total_bytes) };
    if handle.is_null() {
        return Err("clipboard file drop allocation failed".to_string());
    }

    let memory = unsafe { GlobalLock(handle) };
    if memory.is_null() {
        unsafe {
            GlobalFree(handle);
        }
        return Err("clipboard file drop lock failed".to_string());
    }

    let mut drop_files: DropFiles = unsafe { zeroed() };
    drop_files.p_files = header_size as u32;
    drop_files.f_wide = 1;
    unsafe {
        ptr::copy_nonoverlapping(
            &drop_files as *const DropFiles as *const u8,
            memory as *mut u8,
            header_size,
        );
        ptr::copy_nonoverlapping(
            wide_paths.as_ptr(),
            (memory as *mut u8).add(header_size) as *mut u16,
            wide_paths.len(),
        );
        GlobalUnlock(handle);
    }

    struct ClipboardGuard;
    impl Drop for ClipboardGuard {
        fn drop(&mut self) {
            unsafe {
                CloseClipboard();
            }
        }
    }

    let opened = unsafe { OpenClipboard(ptr::null_mut()) };
    if opened == 0 {
        unsafe {
            GlobalFree(handle);
        }
        return Err("clipboard open failed".to_string());
    }
    let _guard = ClipboardGuard;

    if unsafe { EmptyClipboard() } == 0 {
        unsafe {
            GlobalFree(handle);
        }
        return Err("clipboard empty failed".to_string());
    }
    if unsafe { SetClipboardData(CF_HDROP, handle) }.is_null() {
        unsafe {
            GlobalFree(handle);
        }
        return Err("clipboard set file drop failed".to_string());
    }
    Ok(())
}
