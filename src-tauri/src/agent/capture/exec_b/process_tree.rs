//! Own the complete local capture process tree, including cancellation/unwind.
use tokio::process::{Child, Command};

pub(super) fn configure(command: &mut Command) {
    command.kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
}

#[cfg(windows)]
pub(super) struct ProcessTree(std::os::windows::io::OwnedHandle);

#[cfg(windows)]
impl ProcessTree {
    pub(super) fn attach(child: &Child) -> Result<Self, String> {
        use std::os::windows::io::{FromRawHandle, OwnedHandle};
        use windows::Win32::{
            Foundation::CloseHandle,
            System::{
                JobObjects::{
                    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
                    SetInformationJobObject,
                },
                Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE},
            },
        };
        let pid = child.id().ok_or("capture shell already reaped")?;
        unsafe {
            let job = CreateJobObjectW(None, None).map_err(|e| e.to_string())?;
            let owned = OwnedHandle::from_raw_handle(job.0);
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                std::mem::size_of_val(&limits) as u32,
            )
            .map_err(|e| e.to_string())?;
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid)
                .map_err(|e| e.to_string())?;
            let assigned = AssignProcessToJobObject(job, process);
            let _ = CloseHandle(process);
            assigned.map_err(|e| e.to_string())?;
            Ok(Self(owned))
        }
    }

    pub(super) fn terminate(&self) -> Result<(), String> {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::{Foundation::HANDLE, System::JobObjects::TerminateJobObject};
        unsafe { TerminateJobObject(HANDLE(self.0.as_raw_handle()), 1) }
            .map_err(|e| format!("failed to terminate capture process tree: {e}"))
    }
}

#[cfg(unix)]
pub(super) struct ProcessTree(libc::pid_t);

#[cfg(unix)]
impl ProcessTree {
    pub(super) fn attach(child: &Child) -> Result<Self, String> {
        Ok(Self(
            child.id().ok_or("capture shell already reaped")? as libc::pid_t
        ))
    }

    pub(super) fn terminate(&self) -> Result<(), String> {
        let result = unsafe { libc::kill(-self.0, libc::SIGKILL) };
        let error = std::io::Error::last_os_error();
        if result == 0 || error.raw_os_error() == Some(libc::ESRCH) {
            Ok(())
        } else {
            Err(format!(
                "failed to terminate capture process group: {error}"
            ))
        }
    }
}

#[cfg(unix)]
impl Drop for ProcessTree {
    fn drop(&mut self) {
        let _ = self.terminate();
    }
}
