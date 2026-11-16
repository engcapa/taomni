use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::process::CommandExt;
use std::process::{Child, Command};
#[path = "termination_unix.rs"]
mod termination;

/// The write end belongs only to the core. A tiny watchdog in the host's
/// process group waits for EOF and kills that group if the core disappears.
/// Keeping the watchdog in the group also reserves its ID until cleanup, so a
/// reaped leader's PID cannot redirect cleanup to a later, unrelated group.
#[derive(Debug)]
pub(crate) struct ProcessContainment {
    owner: Option<OwnedFd>,
    reader: Option<OwnedFd>,
    process_group: Option<libc::pid_t>,
    terminating: bool,
}

impl ProcessContainment {
    pub(crate) fn prepare(command: &mut Command) -> io::Result<Self> {
        let mut descriptors = [-1; 2];
        // CLOEXEC is set before spawning, preventing unrelated concurrent
        // execs from retaining the core's ownership handle.
        let result = unsafe { libc::pipe2(descriptors.as_mut_ptr(), libc::O_CLOEXEC) };
        if result != 0 {
            return Err(io::Error::last_os_error());
        }
        let reader = unsafe { OwnedFd::from_raw_fd(descriptors[0]) };
        let owner = unsafe { OwnedFd::from_raw_fd(descriptors[1]) };
        let core_pid = unsafe { libc::getpid() };
        let mut limit = std::mem::MaybeUninit::<libc::rlimit>::uninit();
        if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, limit.as_mut_ptr()) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let descriptor_limit = unsafe { limit.assume_init() }.rlim_cur;
        let reader_fd = reader.as_raw_fd();
        let owner_fd = owner.as_raw_fd();
        // Only async-signal-safe libc operations run after fork. The watchdog
        // never returns to Rust, allocates, locks, logs, or touches ObjC.
        unsafe {
            command.pre_exec(move || {
                libc::close(owner_fd);
                if libc::setsid() == -1 {
                    return Err(io::Error::last_os_error());
                }
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
                    return Err(io::Error::last_os_error());
                }
                if libc::getppid() != core_pid {
                    return Err(io::Error::from_raw_os_error(libc::ESRCH));
                }
                let group = libc::getpid();
                match libc::fork() {
                    -1 => return Err(io::Error::last_os_error()),
                    0 => watchdog(reader_fd, group, descriptor_limit),
                    _ => {
                        libc::close(reader_fd);
                    }
                }
                Ok(())
            });
        }
        Ok(Self {
            owner: Some(owner),
            reader: Some(reader),
            process_group: None,
            terminating: false,
        })
    }

    pub(crate) fn attach(&mut self, child: &Child) -> io::Result<()> {
        self.process_group = Some(child.id() as libc::pid_t);
        self.reader.take();
        Ok(())
    }

    pub(crate) fn terminate(&mut self) {
        if !self.terminating
            && let Some(group) = self.process_group
        {
            // Explicit cleanup is immediate; the ownership pipe covers abrupt
            // core death when this code cannot run.
            unsafe { libc::kill(-group, libc::SIGKILL) };
        }
        self.terminating = true;
        self.owner.take();
        self.reader.take();
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

unsafe fn watchdog(reader: RawFd, group: libc::pid_t, descriptor_limit: libc::rlim_t) -> ! {
    // The std::process exec-error pipe must not survive here: Command::spawn
    // waits for it to close. Do not preserve inherited stdin/stdout either.
    if reader != 3 && unsafe { libc::dup2(reader, 3) } == -1 {
        unsafe {
            libc::kill(-group, libc::SIGKILL);
            libc::_exit(127);
        }
    }
    for descriptor in 0..3 {
        unsafe { libc::close(descriptor) };
    }
    let closed = unsafe { libc::syscall(libc::SYS_close_range, 4u32, u32::MAX, 0u32) } == 0;
    if !closed {
        for descriptor in 4..descriptor_limit.min(libc::c_int::MAX as libc::rlim_t) {
            unsafe { libc::close(descriptor as libc::c_int) };
        }
    }
    let mut byte = 0u8;
    loop {
        let read = unsafe { libc::read(3, (&mut byte as *mut u8).cast(), 1) };
        if read == -1 && io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
            continue;
        }
        if read <= 0 {
            unsafe {
                libc::kill(-group, libc::SIGKILL);
                libc::_exit(0);
            }
        }
    }
}
