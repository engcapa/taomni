use super::plan::CapturePlan;
use crate::proc_info::ProcessTree;
use crate::proc_info::SharedTree;
use crate::proc_info::path_matches_selector;
use winapi::um::winnt::HANDLE;

pub(super) fn process_in_scope(
    plan: &CapturePlan,
    pid: u32,
    path: &str,
    tree: &SharedTree,
) -> bool {
    tree.with(|t| process_in_scope_tree(plan, pid, path, t))
        .unwrap_or(false)
}

/// True when a flow's process should be bypassed by executable path. Restart-
/// proof (matches the current path, not a snapshot PID). Empty path never matches.
pub(super) fn path_bypassed(plan: &CapturePlan, path: &str) -> bool {
    if path.is_empty() || plan.bypass_paths.is_empty() {
        return false;
    }
    plan.bypass_paths
        .iter()
        .any(|sel| path_matches_selector(path, sel))
}

pub(super) fn process_in_scope_tree(
    plan: &CapturePlan,
    pid: u32,
    path: &str,
    tree: &ProcessTree,
) -> bool {
    if plan.bypass_pids.contains(&pid) {
        return false;
    }
    if path_bypassed(plan, path) {
        return false;
    }
    if !plan.mode_apps {
        return true;
    }
    let mut candidates: Vec<String> = Vec::new();
    if !path.is_empty() {
        candidates.push(path.to_string());
    }
    candidates.extend(tree.ancestor_paths(pid));
    if candidates.is_empty() {
        return false;
    }
    plan.app_paths
        .iter()
        .any(|sel| candidates.iter().any(|p| path_matches_selector(p, sel)))
}

pub(super) fn process_path(pid: u32) -> Option<String> {
    use std::os::windows::ffi::OsStringExt;
    use winapi::shared::minwindef::{DWORD, FALSE, MAX_PATH};
    use winapi::um::handleapi::CloseHandle;
    use winapi::um::processthreadsapi::OpenProcess;
    use winapi::um::winnt::PROCESS_QUERY_LIMITED_INFORMATION;

    if pid == 0 {
        return None;
    }
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
        if h.is_null() {
            return None;
        }
        let mut buf = vec![0u16; MAX_PATH as usize * 4];
        let mut size = buf.len() as DWORD;
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn QueryFullProcessImageNameW(
                h: HANDLE,
                flags: DWORD,
                buf: *mut u16,
                size: *mut DWORD,
            ) -> i32;
        }
        let ok = QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut size);
        CloseHandle(h);
        if ok == 0 {
            return None;
        }
        let os = std::ffi::OsString::from_wide(&buf[..size as usize]);
        Some(os.to_string_lossy().to_string())
    }
}
