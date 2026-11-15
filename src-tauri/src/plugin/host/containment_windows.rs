use std::io;
use std::mem::size_of;
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::process::{Child, Command};

use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject,
};
use windows::Win32::System::Threading::CREATE_SUSPENDED;

#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtResumeProcess(process: HANDLE) -> i32;
}

/// KILL_ON_JOB_CLOSE also applies when Windows closes the handle after an
/// abnormal core exit. The child starts suspended and cannot spawn a process
/// before it has entered the job.
#[derive(Debug)]
pub(crate) struct ProcessContainment {
    job: HANDLE,
}

// A job is a kernel handle, never a pointer to thread-local data.
unsafe impl Send for ProcessContainment {}

impl ProcessContainment {
    pub(crate) fn prepare(command: &mut Command) -> io::Result<Self> {
        let job = unsafe { CreateJobObjectW(None, None) }.map_err(io::Error::other)?;
        let containment = Self { job };
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        }
        .map_err(io::Error::other)?;
        command.creation_flags(CREATE_SUSPENDED.0);
        Ok(containment)
    }

    pub(crate) fn attach(&mut self, child: &Child) -> io::Result<()> {
        let process = HANDLE(child.as_raw_handle());
        unsafe { AssignProcessToJobObject(self.job, process) }.map_err(io::Error::other)?;
        let status = unsafe { NtResumeProcess(process) };
        if status < 0 {
            return Err(io::Error::other(format!(
                "NtResumeProcess failed with NTSTATUS {status:#x}"
            )));
        }
        Ok(())
    }

    pub(crate) fn terminate(&mut self) {
        if !self.job.is_invalid() {
            unsafe {
                let _ = TerminateJobObject(self.job, 1);
                let _ = CloseHandle(self.job);
            }
            self.job = HANDLE::default();
        }
    }
}

impl Drop for ProcessContainment {
    fn drop(&mut self) {
        self.terminate();
    }
}
