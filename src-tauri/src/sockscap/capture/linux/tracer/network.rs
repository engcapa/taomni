use super::flows::FlowQueue;
use super::flows::ProcessIdentity;
use super::flows::TracedFlow;
use super::limits::FLOW_CLAIM_TIMEOUT;
use super::limits::LINUX_SOCK_TYPE_MASK;
use super::process::ptrace_resume;
use super::process::write_process_memory;
#[cfg(any(
    target_arch = "x86_64",
    target_arch = "aarch64",
    not(any(target_arch = "x86_64", target_arch = "aarch64"))
))]
use super::registers::SyscallRegisters;
#[cfg(any(
    target_arch = "x86_64",
    target_arch = "aarch64",
    not(any(target_arch = "x86_64", target_arch = "aarch64"))
))]
use super::registers::syscall_registers;
use super::sockets::encode_loopback;
use super::sockets::read_socket_address;
use super::sockets::socket_inode;
use super::sockets::socket_is_stream;
use std::collections::HashMap;
use std::fs;

pub(super) fn handle_connect(
    pid: libc::pid_t,
    identity: &ProcessIdentity,
    socket_types: &HashMap<String, libc::c_int>,
    flows: &FlowQueue,
    relay_port: u16,
    ipv6_ready: bool,
) -> Result<(), String> {
    let registers = syscall_registers(pid)?;
    let arguments = registers.connect_arguments()?;
    if arguments.address == 0
        || arguments.length < 2
        || !socket_is_stream(pid, arguments.fd, socket_types)
    {
        return ptrace_resume(pid, libc::PTRACE_CONT, 0);
    }

    let target = read_socket_address(pid, arguments.address, arguments.length)?;
    let Some((destination, original)) = target else {
        return ptrace_resume(pid, libc::PTRACE_CONT, 0);
    };
    if destination.ip().is_loopback() {
        return ptrace_resume(pid, libc::PTRACE_CONT, 0);
    }
    // A host with IPv6 disabled cannot accept the rewritten connection. Route
    // that attempt to the reserved local port 0 so the kernel returns a normal
    // connection error and Happy Eyeballs clients can fall back to IPv4.
    let ingress_port = if destination.is_ipv6() && !ipv6_ready {
        0
    } else {
        relay_port
    };
    let replacement = encode_loopback(destination, ingress_port, original.len())?;

    if ingress_port == 0 {
        write_process_memory(pid, arguments.address, &replacement)?;
        if let Err(error) = ptrace_resume(pid, libc::PTRACE_SYSCALL, 0) {
            let _ = write_process_memory(pid, arguments.address, &original);
            return Err(error);
        }
        let syscall_result = wait_for_syscall_exit(pid);
        let restore_result = write_process_memory(pid, arguments.address, &original);
        syscall_result?;
        restore_result?;
        return ptrace_resume(pid, libc::PTRACE_CONT, 0);
    }

    let process_path = fs::read_link(format!("/proc/{pid}/exe"))
        .ok()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|| identity.configured_path.clone());
    let flow_id = flows.push(TracedFlow {
        destination,
        pid: pid as u32,
        process_path,
        profile_id: identity.profile_id.clone(),
    })?;

    if let Err(error) = write_process_memory(pid, arguments.address, &replacement) {
        flows.cancel(flow_id);
        return Err(error);
    }
    if let Err(error) = ptrace_resume(pid, libc::PTRACE_SYSCALL, 0) {
        let _ = write_process_memory(pid, arguments.address, &original);
        flows.cancel(flow_id);
        return Err(error);
    }

    let syscall_result = wait_for_syscall_exit(pid);
    let restore_result = write_process_memory(pid, arguments.address, &original);
    let syscall_result = syscall_result?;
    restore_result?;

    if connect_started(syscall_result) {
        if !flows.wait_claimed(flow_id, FLOW_CLAIM_TIMEOUT) {
            flows.cancel(flow_id);
            return Err(format!(
                "loopback ingress did not accept the rewritten connection to {destination}"
            ));
        }
    } else {
        flows.cancel(flow_id);
    }
    ptrace_resume(pid, libc::PTRACE_CONT, 0)
}

pub(super) fn handle_socket(
    pid: libc::pid_t,
    registers: &SyscallRegisters,
    socket_types: &mut HashMap<String, libc::c_int>,
) -> Result<(), String> {
    let arguments = registers.socket_arguments()?;
    ptrace_resume(pid, libc::PTRACE_SYSCALL, 0)?;
    let fd = wait_for_syscall_exit(pid)?;
    if fd >= 0
        && matches!(arguments.domain, libc::AF_INET | libc::AF_INET6)
        && let Some(inode) = socket_inode(pid, fd as libc::c_int)
    {
        if socket_types.len() >= 65_536 {
            socket_types.clear();
        }
        socket_types.insert(inode, arguments.socket_type & LINUX_SOCK_TYPE_MASK);
    }
    ptrace_resume(pid, libc::PTRACE_CONT, 0)
}

pub(super) fn wait_for_syscall_exit(pid: libc::pid_t) -> Result<i64, String> {
    loop {
        let mut status = 0;
        if unsafe { libc::waitpid(pid, &mut status, libc::__WALL) } < 0 {
            return Err(format!(
                "wait for connect syscall exit: {}",
                std::io::Error::last_os_error()
            ));
        }
        if libc::WIFEXITED(status) || libc::WIFSIGNALED(status) {
            return Err("application exited during connect syscall".into());
        }
        if !libc::WIFSTOPPED(status) {
            continue;
        }
        let signal = libc::WSTOPSIG(status);
        if signal == libc::SIGTRAP | 0x80 {
            return syscall_registers(pid)?.result();
        }
        let delivered_signal = if signal == libc::SIGSTOP || signal == libc::SIGTRAP {
            0
        } else {
            signal
        };
        ptrace_resume(pid, libc::PTRACE_SYSCALL, delivered_signal)?;
    }
}

pub(super) fn connect_started(result: i64) -> bool {
    result == 0 || result == -(libc::EINPROGRESS as i64)
}

pub(super) struct ConnectArguments {
    pub(super) fd: libc::c_int,
    pub(super) address: usize,
    pub(super) length: usize,
}

pub(super) struct SocketArguments {
    pub(super) domain: libc::c_int,
    pub(super) socket_type: libc::c_int,
}
