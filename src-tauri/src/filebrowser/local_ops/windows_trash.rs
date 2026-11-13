//! Do not let Shell's ordinary delete silently fall back to permanent removal
//! on an un-recyclable volume. Explorer's UI must obtain confirmation first.
use super::model::{OpError, OpResult};
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use windows::Win32::Foundation::RPC_E_CHANGED_MODE;
use windows::Win32::System::Com::{
    CLSCTX_ALL, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx, CoUninitialize,
};
use windows::Win32::UI::Shell::{
    FOF_ALLOWUNDO, FOF_NO_UI, FOF_WANTNUKEWARNING, FOFX_EARLYFAILURE, FOFX_RECYCLEONDELETE,
    FileOperation, IFileOperation, IShellItem, SHCreateItemFromParsingName, SHQUERYRBINFO,
    SHQueryRecycleBinW,
};
use windows::core::PCWSTR;

struct Apartment(bool);
impl Drop for Apartment {
    fn drop(&mut self) {
        if self.0 {
            unsafe { CoUninitialize() };
        }
    }
}

pub(super) fn shell_path(path: &Path) -> String {
    let value = path.to_string_lossy().replace('/', "\\");
    value
        .strip_prefix(r"\\?\UNC\")
        .map(|p| format!(r"\\{p}"))
        .unwrap_or_else(|| value.strip_prefix(r"\\?\").unwrap_or(&value).to_string())
}

fn wide(path: &str) -> Vec<u16> {
    std::ffi::OsStr::new(path)
        .encode_wide()
        .chain(Some(0))
        .collect()
}

pub(super) fn delete(path: &Path) -> OpResult<()> {
    let init = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    if init.is_err() && init != RPC_E_CHANGED_MODE {
        return Err(OpError::new(
            "trash_unavailable",
            format!("Cannot initialize recycle-bin access: {init}"),
        ));
    }
    let _apartment = Apartment(init.is_ok());
    let value = shell_path(path);
    let path_wide = wide(&value);
    let mut volume = vec![0u16; 32_768];
    if unsafe {
        winapi::um::fileapi::GetVolumePathNameW(
            path_wide.as_ptr(),
            volume.as_mut_ptr(),
            volume.len() as u32,
        )
    } == 0
    {
        return Err(OpError::io(
            "resolve recycle volume",
            path,
            std::io::Error::last_os_error(),
        ));
    }
    // A missing/network recycle bin must fail before DeleteItem is scheduled.
    let mut query = SHQUERYRBINFO::default();
    query.cbSize = std::mem::size_of::<SHQUERYRBINFO>() as u32;
    unsafe { SHQueryRecycleBinW(PCWSTR(volume.as_ptr()), &mut query) }.map_err(|error| {
        OpError::new(
            "trash_unavailable",
            format!("This volume has no available Recycle Bin: {error}"),
        )
    })?;
    unsafe {
        let operation: IFileOperation = CoCreateInstance(&FileOperation, None, CLSCTX_ALL)
            .map_err(|e| {
                OpError::new(
                    "trash_unavailable",
                    format!("Cannot create recycle operation: {e}"),
                )
            })?;
        operation
            .SetOperationFlags(
                FOF_NO_UI
                    | FOF_ALLOWUNDO
                    | FOFX_RECYCLEONDELETE
                    | FOF_WANTNUKEWARNING
                    | FOFX_EARLYFAILURE,
            )
            .map_err(|e| {
                OpError::new(
                    "trash_unavailable",
                    format!("Cannot configure safe recycle operation: {e}"),
                )
            })?;
        let item: IShellItem = SHCreateItemFromParsingName(PCWSTR(path_wide.as_ptr()), None)
            .map_err(|e| {
                OpError::new(
                    "trash_unavailable",
                    format!("Cannot access recycle source: {e}"),
                )
            })?;
        operation.DeleteItem(&item, None).map_err(|e| {
            OpError::new(
                "trash_unavailable",
                format!("Cannot schedule recycle operation: {e}"),
            )
        })?;
        operation.PerformOperations().map_err(|e| {
            OpError::new(
                "trash_unavailable",
                format!("Recycle operation failed: {e}"),
            )
        })?;
        if operation
            .GetAnyOperationsAborted()
            .map_err(|e| OpError::new("trash_unavailable", e.to_string()))?
            .as_bool()
            || std::fs::symlink_metadata(path).is_ok()
        {
            return Err(OpError::new(
                "trash_unavailable",
                "Windows could not recycle this item; permanent deletion requires confirmation",
            ));
        }
    }
    Ok(())
}
