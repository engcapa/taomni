//! Shared async-signal-safe helpers for re-execing Unix plugin watchdogs so
//! they shed the parent core process's CoW address space after `fork`.

use std::ffi::{CStr, CString};
use std::os::unix::ffi::OsStrExt;
use std::sync::atomic::{AtomicBool, Ordering};

pub(super) const WATCHDOG_ARGV0: &CStr = c"taomni-plugin-watchdog";
pub(super) const WATCHDOG_ARG: &CStr = c"--plugin-watchdog";

// Re-execing `current_exe()` is enabled only by binaries whose `main` handles
// `--plugin-watchdog` before initialization; unit-test harnesses keep running
// the inline post-fork monitor loop.
static REEXEC_WATCHDOG: AtomicBool = AtomicBool::new(false);

pub(super) fn enable_exec() {
    REEXEC_WATCHDOG.store(true, Ordering::Release);
}

pub(super) fn prepare_executable() -> Option<CString> {
    if !REEXEC_WATCHDOG.load(Ordering::Acquire) {
        return None;
    }
    let path = std::env::current_exe().ok()?;
    CString::new(path.as_os_str().as_bytes()).ok()
}

/// Format an unsigned integer into a caller-supplied stack buffer with a
/// trailing NUL byte without allocating, making it safe after `fork`.
#[allow(dead_code)]
pub(super) fn format_u64_nul(value: u64, buf: &mut [u8; 32]) -> *const libc::c_char {
    format_u64_nul_into(value, buf, false)
}

/// Format a signed `pid_t` into a caller-supplied stack buffer with a trailing
/// NUL byte without allocating, making it safe after `fork`.
pub(super) fn format_pid_nul(pid: libc::pid_t, buf: &mut [u8; 32]) -> *const libc::c_char {
    let magnitude = (pid as i64).unsigned_abs();
    format_u64_nul_into(magnitude, buf, pid < 0)
}

fn format_u64_nul_into(mut value: u64, buf: &mut [u8; 32], negative: bool) -> *const libc::c_char {
    let mut pos = buf.len() - 1;
    buf[pos] = 0;
    if value == 0 {
        pos -= 1;
        buf[pos] = b'0';
    } else {
        while value > 0 {
            pos -= 1;
            buf[pos] = b'0' + (value % 10) as u8;
            value /= 10;
        }
    }
    if negative {
        pos -= 1;
        buf[pos] = b'-';
    }
    buf[pos..].as_ptr().cast()
}

/// Attach stdin, stdout, and stderr to `/dev/null` using only async-signal-safe
/// syscalls so the watchdog survives `execv` with closed standard descriptors.
pub(super) unsafe fn redirect_stdio_to_devnull() {
    let devnull = unsafe { libc::open(c"/dev/null".as_ptr(), libc::O_RDWR) };
    if devnull >= 0 {
        for fd in 0..3 {
            unsafe {
                let _ = libc::dup2(devnull, fd);
            }
        }
        if devnull > 2 {
            unsafe {
                let _ = libc::close(devnull);
            }
        }
    } else {
        for fd in 0..3 {
            unsafe {
                let _ = libc::close(fd);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{format_pid_nul, format_u64_nul};
    use std::ffi::CStr;

    #[test]
    fn formats_unsigned_and_pid_values_without_allocation() {
        let mut buf = [0u8; 32];
        let zero = unsafe { CStr::from_ptr(format_u64_nul(0, &mut buf)) };
        assert_eq!(zero.to_str().unwrap(), "0");

        let max = unsafe { CStr::from_ptr(format_u64_nul(u64::MAX, &mut buf)) };
        assert_eq!(max.to_str().unwrap(), u64::MAX.to_string());

        let positive_pid = unsafe { CStr::from_ptr(format_pid_nul(42, &mut buf)) };
        assert_eq!(positive_pid.to_str().unwrap(), "42");

        let negative_pid = unsafe { CStr::from_ptr(format_pid_nul(-1, &mut buf)) };
        assert_eq!(negative_pid.to_str().unwrap(), "-1");

        let min_pid = unsafe { CStr::from_ptr(format_pid_nul(i32::MIN, &mut buf)) };
        assert_eq!(min_pid.to_str().unwrap(), i32::MIN.to_string());
    }
}
