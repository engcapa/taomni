use super::network::ConnectArguments;
use super::network::SocketArguments;
use super::process::ptrace_call;

#[cfg(target_arch = "x86_64")]
pub(super) struct SyscallRegisters(pub(super) libc::user_regs_struct);

#[cfg(target_arch = "x86_64")]
pub(super) fn syscall_registers(pid: libc::pid_t) -> Result<SyscallRegisters, String> {
    let mut registers = std::mem::MaybeUninit::<libc::user_regs_struct>::zeroed();
    ptrace_call(
        libc::PTRACE_GETREGS,
        pid,
        std::ptr::null_mut(),
        registers.as_mut_ptr().cast(),
    )
    .map_err(|error| format!("read x86_64 syscall registers: {error}"))?;
    Ok(SyscallRegisters(unsafe { registers.assume_init() }))
}

#[cfg(target_arch = "x86_64")]
impl SyscallRegisters {
    pub(super) fn number(&self) -> libc::c_long {
        self.0.orig_rax as libc::c_long
    }

    pub(super) fn connect_arguments(&self) -> Result<ConnectArguments, String> {
        Ok(ConnectArguments {
            fd: self.0.rdi as libc::c_int,
            address: self.0.rsi as usize,
            length: self.0.rdx as usize,
        })
    }

    pub(super) fn result(&self) -> Result<i64, String> {
        Ok(self.0.rax as i64)
    }

    pub(super) fn socket_arguments(&self) -> Result<SocketArguments, String> {
        Ok(SocketArguments {
            domain: self.0.rdi as libc::c_int,
            socket_type: self.0.rsi as libc::c_int,
        })
    }
}

#[cfg(target_arch = "aarch64")]
pub(super) struct SyscallRegisters(pub(super) [u64; 34]);

#[cfg(target_arch = "aarch64")]
pub(super) fn syscall_registers(pid: libc::pid_t) -> Result<SyscallRegisters, String> {
    let mut registers = [0u64; 34];
    let mut io = libc::iovec {
        iov_base: registers.as_mut_ptr().cast(),
        iov_len: std::mem::size_of_val(&registers),
    };
    ptrace_call(
        libc::PTRACE_GETREGSET,
        pid,
        libc::NT_PRSTATUS as usize as *mut libc::c_void,
        (&mut io as *mut libc::iovec).cast(),
    )
    .map_err(|error| format!("read aarch64 syscall registers: {error}"))?;
    Ok(SyscallRegisters(registers))
}

#[cfg(target_arch = "aarch64")]
impl SyscallRegisters {
    pub(super) fn number(&self) -> libc::c_long {
        self.0[8] as libc::c_long
    }

    pub(super) fn connect_arguments(&self) -> Result<ConnectArguments, String> {
        Ok(ConnectArguments {
            fd: self.0[0] as libc::c_int,
            address: self.0[1] as usize,
            length: self.0[2] as usize,
        })
    }

    pub(super) fn result(&self) -> Result<i64, String> {
        Ok(self.0[0] as i64)
    }

    pub(super) fn socket_arguments(&self) -> Result<SocketArguments, String> {
        Ok(SocketArguments {
            domain: self.0[0] as libc::c_int,
            socket_type: self.0[1] as libc::c_int,
        })
    }
}

#[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
pub(super) struct SyscallRegisters;

#[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
pub(super) fn syscall_registers(_pid: libc::pid_t) -> Result<SyscallRegisters, String> {
    Err(format!(
        "Linux rootless capture does not support {} syscall registers",
        std::env::consts::ARCH
    ))
}

#[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
impl SyscallRegisters {
    pub(super) fn number(&self) -> libc::c_long {
        -1
    }

    pub(super) fn connect_arguments(&self) -> Result<ConnectArguments, String> {
        Err("unsupported Linux rootless capture architecture".into())
    }

    pub(super) fn result(&self) -> Result<i64, String> {
        Err("unsupported Linux rootless capture architecture".into())
    }

    pub(super) fn socket_arguments(&self) -> Result<SocketArguments, String> {
        Err("unsupported Linux rootless capture architecture".into())
    }
}
