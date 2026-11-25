//! Darwin kill(-pgid, 0) can return EPERM for a group containing only zombies.
//! Enumerate kernel group members instead; inspection failures never confirm
//! termination. Reused PIDs are checked against their current group.
use std::{
    io,
    mem::{MaybeUninit, size_of},
};

pub(super) fn group_has_live_processes(group: libc::pid_t) -> io::Result<bool> {
    for pid in group_members(group)? {
        let mut info = MaybeUninit::<libc::proc_bsdinfo>::uninit();
        unsafe { *libc::__error() = 0 };
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
            let error = io::Error::last_os_error();
            if count == 0 && error.raw_os_error() == Some(libc::ESRCH) {
                continue; // Exited between enumeration and inspection.
            }
            return Err(if count == 0 && error.raw_os_error() != Some(0) {
                error
            } else {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    "incomplete plugin process status",
                )
            });
        }
        let info = unsafe { info.assume_init() };
        if member_is_live(group, info.pbi_pgid, info.pbi_status) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn member_is_live(group: libc::pid_t, current_group: u32, status: u32) -> bool {
    current_group == group as u32 && status != libc::SZOMB
}

fn group_members(group: libc::pid_t) -> io::Result<Vec<libc::pid_t>> {
    let mut members = vec![0; 64];
    loop {
        unsafe { *libc::__error() = 0 };
        // libproc's proc_listpgrppids returns a PID count, not a byte count.
        let count = unsafe {
            libc::proc_listpgrppids(
                group,
                members.as_mut_ptr().cast(),
                (members.len() * size_of::<libc::pid_t>()) as i32,
            )
        };
        let error = io::Error::last_os_error();
        if count < 0 || (count == 0 && !matches!(error.raw_os_error(), Some(0 | libc::ESRCH))) {
            return Err(error);
        }
        if (count as usize) < members.len() {
            members.truncate(count as usize);
            return Ok(members);
        }
        // A full buffer can omit live descendants; never accept that as an
        // empty group. Bound allocation even if a host is forking rapidly.
        if members.len() >= 131_072 {
            return Err(io::Error::other(
                "plugin process group exceeds inspection limit",
            ));
        }
        members.resize(members.len() * 2, 0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zombie_in_the_owned_group_holds_no_live_address_space() {
        assert!(!member_is_live(42, 42, libc::SZOMB));
    }

    #[test]
    fn live_member_in_the_owned_group_blocks_confirmation() {
        assert!(member_is_live(42, 42, libc::SRUN));
    }

    #[test]
    fn reused_pid_in_another_group_is_not_a_descendant() {
        assert!(!member_is_live(42, 43, libc::SRUN));
    }
}
