pub(super) fn read_process_memory(
    pid: libc::pid_t,
    address: usize,
    bytes: &mut [u8],
) -> Result<(), String> {
    let local = libc::iovec {
        iov_base: bytes.as_mut_ptr().cast(),
        iov_len: bytes.len(),
    };
    let remote = libc::iovec {
        iov_base: address as *mut libc::c_void,
        iov_len: bytes.len(),
    };
    let count = unsafe { libc::process_vm_readv(pid, &local, 1, &remote, 1, 0) };
    if count == bytes.len() as isize {
        return Ok(());
    }
    ptrace_read_memory(pid, address, bytes)
}

pub(super) fn write_process_memory(
    pid: libc::pid_t,
    address: usize,
    bytes: &[u8],
) -> Result<(), String> {
    let local = libc::iovec {
        iov_base: bytes.as_ptr() as *mut libc::c_void,
        iov_len: bytes.len(),
    };
    let remote = libc::iovec {
        iov_base: address as *mut libc::c_void,
        iov_len: bytes.len(),
    };
    let count = unsafe { libc::process_vm_writev(pid, &local, 1, &remote, 1, 0) };
    if count == bytes.len() as isize {
        return Ok(());
    }
    ptrace_write_memory(pid, address, bytes)
}

pub(super) fn ptrace_read_memory(
    pid: libc::pid_t,
    address: usize,
    bytes: &mut [u8],
) -> Result<(), String> {
    let word_size = std::mem::size_of::<libc::c_long>();
    let mut copied = 0;
    while copied < bytes.len() {
        let remote_address = address + copied;
        let aligned_address = remote_address & !(word_size - 1);
        let word_offset = remote_address - aligned_address;
        let count = std::cmp::min(word_size - word_offset, bytes.len() - copied);
        let word = ptrace_peek_word(pid, aligned_address)?;
        let word_bytes = word.to_ne_bytes();
        bytes[copied..copied + count]
            .copy_from_slice(&word_bytes[word_offset..word_offset + count]);
        copied += count;
    }
    Ok(())
}

pub(super) fn ptrace_write_memory(
    pid: libc::pid_t,
    address: usize,
    bytes: &[u8],
) -> Result<(), String> {
    let word_size = std::mem::size_of::<libc::c_long>();
    let mut copied = 0;
    while copied < bytes.len() {
        let remote_address = address + copied;
        let aligned_address = remote_address & !(word_size - 1);
        let word_offset = remote_address - aligned_address;
        let count = std::cmp::min(word_size - word_offset, bytes.len() - copied);
        let mut word_bytes = if word_offset == 0 && count == word_size {
            [0u8; std::mem::size_of::<libc::c_long>()]
        } else {
            ptrace_peek_word(pid, aligned_address)?.to_ne_bytes()
        };
        word_bytes[word_offset..word_offset + count]
            .copy_from_slice(&bytes[copied..copied + count]);
        let word = libc::c_long::from_ne_bytes(word_bytes);
        ptrace_call(
            libc::PTRACE_POKEDATA,
            pid,
            aligned_address as *mut libc::c_void,
            word as usize as *mut libc::c_void,
        )
        .map_err(|error| format!("PTRACE_POKEDATA PID {pid} at 0x{aligned_address:x}: {error}"))?;
        copied += count;
    }
    Ok(())
}

pub(super) fn ptrace_peek_word(pid: libc::pid_t, address: usize) -> Result<libc::c_long, String> {
    unsafe { *libc::__errno_location() = 0 };
    let word = unsafe {
        libc::ptrace(
            libc::PTRACE_PEEKDATA,
            pid,
            address as *mut libc::c_void,
            std::ptr::null_mut::<libc::c_void>(),
        )
    };
    let error = std::io::Error::last_os_error();
    if word == -1 && error.raw_os_error().unwrap_or(0) != 0 {
        Err(format!(
            "PTRACE_PEEKDATA PID {pid} at 0x{address:x}: {error}"
        ))
    } else {
        Ok(word)
    }
}

pub(super) fn ptrace_resume(
    pid: libc::pid_t,
    request: libc::c_uint,
    signal: libc::c_int,
) -> Result<(), String> {
    ptrace_call(
        request,
        pid,
        std::ptr::null_mut(),
        signal as usize as *mut libc::c_void,
    )
    .map(|_| ())
    .map_err(|error| format!("ptrace resume PID {pid}: {error}"))
}

pub(super) fn ptrace_call(
    request: libc::c_uint,
    pid: libc::pid_t,
    address: *mut libc::c_void,
    data: *mut libc::c_void,
) -> std::io::Result<libc::c_long> {
    let result = unsafe { libc::ptrace(request, pid, address, data) };
    if result < 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(result)
    }
}

pub(super) fn kill_tracee(pid: libc::pid_t) {
    unsafe { libc::kill(pid, libc::SIGKILL) };
    let _ = ptrace_resume(pid, libc::PTRACE_CONT, libc::SIGKILL);
}
