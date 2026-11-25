//! An SCM handle to the driver's service created by this helper. Keeping the
//! handle lets us stop the service even after marking it for deletion.

use std::{
    io,
    os::windows::ffi::OsStrExt,
    path::Path,
    ptr::{null, null_mut},
    time::{Duration, Instant},
};
use winapi::{
    shared::winerror::{
        ERROR_SERVICE_ALREADY_RUNNING, ERROR_SERVICE_EXISTS, ERROR_SERVICE_NOT_ACTIVE,
    },
    um::{
        winnt::{DELETE, SERVICE_DEMAND_START, SERVICE_ERROR_NORMAL, SERVICE_KERNEL_DRIVER},
        winsvc::{
            CloseServiceHandle, ControlService, CreateServiceW, DeleteService, OpenSCManagerW,
            OpenServiceW, QueryServiceStatus, SC_HANDLE, SC_MANAGER_CONNECT,
            SC_MANAGER_CREATE_SERVICE, SERVICE_CONTROL_STOP, SERVICE_QUERY_STATUS, SERVICE_START,
            SERVICE_STATUS, SERVICE_STOP, SERVICE_STOP_PENDING, SERVICE_STOPPED, StartServiceW,
        },
    },
};

struct Handle(SC_HANDLE);

impl Handle {
    fn new(handle: SC_HANDLE) -> io::Result<Self> {
        if handle.is_null() {
            Err(io::Error::last_os_error())
        } else {
            Ok(Self(handle))
        }
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        unsafe { CloseServiceHandle(self.0) };
    }
}

pub(super) struct OwnedDriver {
    service: Handle,
}

// A process-wide SCM handle can move to the helper's watchdog. Its lifetime
// and operations are serialized by the WinDivert API's driver lock.
unsafe impl Send for OwnedDriver {}

impl OwnedDriver {
    /// Use a registered driver when another application already owns the
    /// service. Only a newly created service grants a stop handle.
    pub(super) fn start(path: &Path) -> io::Result<Option<Self>> {
        let manager = Handle::new(unsafe {
            OpenSCManagerW(
                null(),
                null(),
                SC_MANAGER_CONNECT | SC_MANAGER_CREATE_SERVICE,
            )
        })?;
        let name: Vec<u16> = "WinDivert\0".encode_utf16().collect();
        let binary: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
        let service = Handle::new(unsafe {
            CreateServiceW(
                manager.0,
                name.as_ptr(),
                name.as_ptr(),
                SERVICE_START | SERVICE_STOP | SERVICE_QUERY_STATUS | DELETE,
                SERVICE_KERNEL_DRIVER,
                SERVICE_DEMAND_START,
                SERVICE_ERROR_NORMAL,
                binary.as_ptr(),
                null(),
                null_mut(),
                null(),
                null(),
                null(),
            )
        });
        match service {
            Ok(service) => {
                let started = start_service(&service);
                // SCM retains a deletion-marked driver until it is stopped
                // and this handle is closed, including after an interrupted start.
                if unsafe { DeleteService(service.0) } == 0 {
                    let error = io::Error::last_os_error();
                    let _ = Self { service }.stop();
                    return Err(error);
                }
                started?;
                Ok(Some(Self { service }))
            }
            Err(error) if error.raw_os_error() == Some(ERROR_SERVICE_EXISTS as i32) => {
                let existing =
                    Handle::new(unsafe { OpenServiceW(manager.0, name.as_ptr(), SERVICE_START) })?;
                start_service(&existing)?;
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }

    pub(super) fn stop(&self) -> io::Result<()> {
        let mut status: SERVICE_STATUS = unsafe { std::mem::zeroed() };
        read_status(&self.service, &mut status)?;
        if !matches!(
            status.dwCurrentState,
            SERVICE_STOPPED | SERVICE_STOP_PENDING
        ) && unsafe { ControlService(self.service.0, SERVICE_CONTROL_STOP, &mut status) } == 0
        {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(ERROR_SERVICE_NOT_ACTIVE as i32) {
                return Err(error);
            }
        }
        let deadline = Instant::now() + Duration::from_secs(4);
        loop {
            read_status(&self.service, &mut status)?;
            if status.dwCurrentState == SERVICE_STOPPED {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "WinDivert service still active",
                ));
            }
            std::thread::sleep(Duration::from_millis(40));
        }
    }
}

fn start_service(service: &Handle) -> io::Result<()> {
    if unsafe { StartServiceW(service.0, 0, null_mut()) } != 0 {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(ERROR_SERVICE_ALREADY_RUNNING as i32) {
        Ok(())
    } else {
        Err(error)
    }
}

fn read_status(service: &Handle, status: &mut SERVICE_STATUS) -> io::Result<()> {
    if unsafe { QueryServiceStatus(service.0, status) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
