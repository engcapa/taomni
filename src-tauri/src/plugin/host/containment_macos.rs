use std::io;
use std::mem::{MaybeUninit, size_of};
use std::os::unix::process::CommandExt;
use std::process::{Child, Command};
#[path = "termination_unix.rs"]
mod termination;

/// kqueue watches the original core process, independent of pipe handles
/// inherited by unrelated concurrent spawns. A birth-time check closes the
/// race where the core exits and its PID is reused before registration.
#[derive(Debug, Default)]
pub(crate) struct ProcessContainment {
    process_group: Option<libc::pid_t>,
    terminating: bool,
}

impl ProcessContainment {
    pub(crate) fn prepare(command: &mut Command) -> io::Result<Self> {
        let core_pid = unsafe { libc::getpid() };
        let core_birth = unsafe { process_birth(core_pid) }.ok_or_else(io::Error::last_os_error)?;
        let mut limit = MaybeUninit::<libc::rlimit>::uninit();
        if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, limit.as_mut_ptr()) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let descriptor_limit = unsafe { limit.assume_init() }.rlim_cur;
        // The fork child runs only low-level libc calls and never enters the
        // allocator, ObjC runtime, logging, or any application mutex.
        unsafe {
            command.pre_exec(move || {
                if libc::setsid() == -1 {
                    return Err(io::Error::last_os_error());
                }
                if libc::getppid() != core_pid {
                    return Err(io::Error::from_raw_os_error(libc::ESRCH));
                }
                let group = libc::getpid();
                match libc::fork() {
                    -1 => return Err(io::Error::last_os_error()),
                    0 => watchdog(group, core_pid, core_birth, descriptor_limit),
                    _ => {}
                }
                Ok(())
            });
        }
        Ok(Self::default())
    }

    pub(crate) fn attach(&mut self, child: &Child) -> io::Result<()> {
        self.process_group = Some(child.id() as libc::pid_t);
        Ok(())
    }

    pub(crate) fn terminate(&mut self) {
        if !self.terminating
            && let Some(group) = self.process_group
        {
            unsafe { libc::kill(-group, libc::SIGKILL) };
        }
        self.terminating = true;
    }

    pub(crate) fn terminate_confirmed(
        &mut self,
        child: &mut Child,
        deadline: std::time::Instant,
    ) -> io::Result<()> {
        self.terminate();
        termination::wait(child, self.process_group, deadline)?;
        self.process_group.take();
        Ok(())
    }
}

impl Drop for ProcessContainment {
    fn drop(&mut self) {
        self.terminate();
    }
}

unsafe fn process_birth(pid: libc::pid_t) -> Option<(u64, u64)> {
    let mut info = MaybeUninit::<libc::proc_bsdinfo>::uninit();
    let count = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            size_of::<libc::proc_bsdinfo>() as i32,
        )
    };
    if count != size_of::<libc::proc_bsdinfo>() as i32 {
        return None;
    }
    let info = unsafe { info.assume_init() };
    Some((info.pbi_start_tvsec, info.pbi_start_tvusec))
}

unsafe fn watchdog(
    group: libc::pid_t,
    core_pid: libc::pid_t,
    core_birth: (u64, u64),
    descriptor_limit: libc::rlim_t,
) -> ! {
    // Close the exec-error pipe as well as all inherited stdio. Keeping the
    // error pipe open here would prevent std::process::Command::spawn returning.
    for descriptor in 0..descriptor_limit.min(libc::c_int::MAX as libc::rlim_t) {
        unsafe { libc::close(descriptor as libc::c_int) };
    }
    let queue = unsafe { libc::kqueue() };
    if queue >= 0 {
        let event = libc::kevent {
            ident: core_pid as libc::uintptr_t,
            filter: libc::EVFILT_PROC,
            flags: libc::EV_ADD | libc::EV_ENABLE | libc::EV_ONESHOT,
            fflags: libc::NOTE_EXIT,
            data: 0,
            udata: std::ptr::null_mut(),
        };
        let registered =
            unsafe { libc::kevent(queue, &event, 1, std::ptr::null_mut(), 0, std::ptr::null()) }
                == 0;
        if registered && unsafe { process_birth(core_pid) } == Some(core_birth) {
            let mut result = MaybeUninit::<libc::kevent>::uninit();
            loop {
                let count = unsafe {
                    libc::kevent(
                        queue,
                        std::ptr::null(),
                        0,
                        result.as_mut_ptr(),
                        1,
                        std::ptr::null(),
                    )
                };
                if count >= 0 || io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
                    break;
                }
            }
        }
    }
    // A failed monitor cannot leave an unowned process tree alive.
    unsafe {
        libc::kill(-group, libc::SIGKILL);
        libc::_exit(0);
    }
}
