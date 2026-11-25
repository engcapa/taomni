//! Start the first GUI after an NSIS update through the interactive desktop.
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use windows::Win32::System::Com::{
    CLSCTX_LOCAL_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
    CoUninitialize, IDispatch, IServiceProvider,
};
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::UI::Shell::{
    CSIDL_DESKTOP, IShellBrowser, IShellDispatch2, IShellFolderViewDual, IShellWindows,
    PathGetArgsW, SID_STopLevelBrowser, SVGIO_BACKGROUND, SWC_DESKTOP, SWFO_NEEDDISPATCH,
    ShellWindows,
};
use windows::core::{BSTR, Interface, PCWSTR};

const INSTALLER_PID: &str = "TAOMNI_UPDATE_INSTALLER_PID";

fn parent_pid() -> Option<u32> {
    use winapi::um::handleapi::{CloseHandle, INVALID_HANDLE_VALUE};
    use winapi::um::tlhelp32::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
        TH32CS_SNAPPROCESS,
    };

    // The parent's PID remains in our entry after the installer exits.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return None;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of_val(&entry) as u32;
        let mut ok = Process32FirstW(snapshot, &mut entry);
        let mut parent = None;
        while ok != 0 {
            if entry.th32ProcessID == std::process::id() {
                parent = Some(entry.th32ParentProcessID);
                break;
            }
            ok = Process32NextW(snapshot, &mut entry);
        }
        CloseHandle(snapshot);
        parent
    }
}

fn shell_launch(exe: &Path, directory: &Path, args: BSTR) -> windows::core::Result<()> {
    let wide_path = |p: &Path| BSTR::from_wide(&p.as_os_str().encode_wide().collect::<Vec<_>>());
    // Find the desktop even when Explorer has no folder windows open. Its
    // automation object executes in the shell process and inherits its PATH.
    unsafe {
        let windows: IShellWindows = CoCreateInstance(&ShellWindows, None, CLSCTX_LOCAL_SERVER)?;
        let mut hwnd = 0;
        let desktop = windows.FindWindowSW(
            &VARIANT::from(CSIDL_DESKTOP as i32),
            &VARIANT::default(),
            SWC_DESKTOP,
            &mut hwnd,
            SWFO_NEEDDISPATCH,
        )?;
        let services: IServiceProvider = desktop.cast()?;
        let browser: IShellBrowser = services.QueryService(&SID_STopLevelBrowser)?;
        let view = browser.QueryActiveShellView()?;
        let background: IDispatch = view.GetItemObject(SVGIO_BACKGROUND)?;
        let folder: IShellFolderViewDual = background.cast()?;
        let shell: IShellDispatch2 = folder.Application()?.cast()?;
        shell.ShellExecute(
            &wide_path(exe),
            &VARIANT::from(args),
            &VARIANT::from(wide_path(directory)),
            &VARIANT::from("open"),
            &VARIANT::from(1),
        )
    }
}

pub(super) fn handoff_to_desktop() -> bool {
    let Ok(marker) = std::env::var(INSTALLER_PID) else {
        return false;
    };
    // Before Tauri/worker threads start. The marker belongs to this launch
    // only, including when a desktop shell is unavailable and we continue here.
    unsafe { std::env::remove_var(INSTALLER_PID) };
    let Ok(installer) = marker.parse::<u32>() else {
        return false;
    };
    if parent_pid() != Some(installer) {
        return false;
    }
    let Ok(exe) = std::env::current_exe() else {
        return false;
    };
    let Some(directory) = exe.parent() else {
        return false;
    };
    unsafe {
        if CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_err() {
            return false;
        }
        // Forward the original UTF-16 argument tail, including quotes and
        // empty arguments, directly to ShellExecute.
        let command = winapi::um::processenv::GetCommandLineW();
        let args = BSTR::from_wide(PathGetArgsW(PCWSTR(command)).as_wide());
        let result = shell_launch(&exe, directory, args);
        CoUninitialize();
        result.is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    use std::process::Command;
    use std::time::{Duration, Instant};
    use windows::Win32::UI::WindowsAndMessaging::{GetShellWindow, GetWindowThreadProcessId};

    // The test executable acts as the installed GUI. A second positional test
    // filter carries the receipt path through the shell without using the
    // installer's environment or creating a Tauri profile.
    #[test]
    #[ignore = "child of desktop_environment_after_update"]
    fn record_relaunch() {
        let args: Vec<OsString> = std::env::args_os().collect();
        let Some(path) = args.last().map(Path::new) else {
            return;
        };
        if path.file_name() != Some("relaunch receipt.json".as_ref()) || !path.is_absolute() {
            return;
        }
        if handoff_to_desktop() {
            return;
        }
        let receipt = serde_json::json!({
            "parent": parent_pid(),
            "privateEnv": std::env::var_os("TAOMNI_TEST_INSTALLER_ONLY").is_some(),
            "args": args[1..].iter().map(|arg| arg.to_string_lossy()).collect::<Vec<_>>(),
        });
        let pending = path.with_extension("tmp");
        std::fs::write(&pending, receipt.to_string()).unwrap();
        std::fs::rename(pending, path).unwrap();
    }

    #[test]
    #[ignore = "requires an interactive Windows Explorer desktop"]
    fn desktop_environment_after_update() {
        let mut shell_pid = 0;
        unsafe { GetWindowThreadProcessId(GetShellWindow(), Some(&mut shell_pid)) };
        assert_ne!(shell_pid, 0, "interactive Explorer required");
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("relaunch receipt.json");
        let args = [
            "--ignored",
            "--exact",
            "windows_update_relaunch::tests::record_relaunch",
            "space 中文",
            "quoted \"value\"",
            "",
            path.to_str().unwrap(),
        ];
        let run = Command::new(std::env::current_exe().unwrap())
            .args(args)
            .env(INSTALLER_PID, std::process::id().to_string())
            .env("TAOMNI_TEST_INSTALLER_ONLY", "1")
            .current_dir(dir.path())
            .status()
            .unwrap();
        assert!(run.success());
        let start = Instant::now();
        while !path.is_file() && start.elapsed() < Duration::from_secs(15) {
            std::thread::sleep(Duration::from_millis(50));
        }
        let receipt: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(receipt["parent"], shell_pid);
        assert_eq!(receipt["privateEnv"], false);
        assert_eq!(receipt["args"], serde_json::json!(args));
    }
}
