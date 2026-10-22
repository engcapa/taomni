use super::process::read_process_memory;
use std::collections::HashMap;
use std::fs;
use std::net::Ipv4Addr;
use std::net::Ipv6Addr;
use std::net::SocketAddr;
use std::net::SocketAddrV4;
use std::net::SocketAddrV6;
use std::os::fd::AsRawFd;
use std::os::fd::FromRawFd;
use std::os::fd::OwnedFd;

pub(super) fn read_socket_address(
    pid: libc::pid_t,
    address: usize,
    supplied_length: usize,
) -> Result<Option<(SocketAddr, Vec<u8>)>, String> {
    let mut family_bytes = [0u8; 2];
    read_process_memory(pid, address, &mut family_bytes)?;
    let family = u16::from_ne_bytes(family_bytes) as libc::c_int;
    let required = match family {
        libc::AF_INET => std::mem::size_of::<libc::sockaddr_in>(),
        libc::AF_INET6 => std::mem::size_of::<libc::sockaddr_in6>(),
        _ => return Ok(None),
    };
    if supplied_length < required {
        return Err(format!(
            "connect sockaddr length {supplied_length} is shorter than required {required}"
        ));
    }
    let mut original = vec![0u8; required];
    read_process_memory(pid, address, &mut original)?;
    let destination = decode_socket_address(&original)?;
    Ok(Some((destination, original)))
}

pub(super) fn decode_socket_address(bytes: &[u8]) -> Result<SocketAddr, String> {
    let family = u16::from_ne_bytes(
        bytes
            .get(..2)
            .ok_or_else(|| "missing sockaddr family".to_string())?
            .try_into()
            .unwrap(),
    ) as libc::c_int;
    let port = u16::from_be_bytes(
        bytes
            .get(2..4)
            .ok_or_else(|| "missing sockaddr port".to_string())?
            .try_into()
            .unwrap(),
    );
    match family {
        libc::AF_INET => {
            let octets: [u8; 4] = bytes
                .get(4..8)
                .ok_or_else(|| "missing IPv4 sockaddr address".to_string())?
                .try_into()
                .unwrap();
            Ok(SocketAddr::V4(SocketAddrV4::new(octets.into(), port)))
        }
        libc::AF_INET6 => {
            let octets: [u8; 16] = bytes
                .get(8..24)
                .ok_or_else(|| "missing IPv6 sockaddr address".to_string())?
                .try_into()
                .unwrap();
            let flowinfo = u32::from_ne_bytes(bytes[4..8].try_into().unwrap());
            let scope_id = u32::from_ne_bytes(bytes[24..28].try_into().unwrap());
            Ok(SocketAddr::V6(SocketAddrV6::new(
                Ipv6Addr::from(octets),
                port,
                flowinfo,
                scope_id,
            )))
        }
        _ => Err(format!("unsupported sockaddr family {family}")),
    }
}

pub(super) fn encode_loopback(
    destination: SocketAddr,
    relay_port: u16,
    length: usize,
) -> Result<Vec<u8>, String> {
    let mut bytes = vec![0u8; length];
    match destination {
        SocketAddr::V4(_) => {
            bytes[..2].copy_from_slice(&(libc::AF_INET as u16).to_ne_bytes());
            bytes[4..8].copy_from_slice(&Ipv4Addr::LOCALHOST.octets());
        }
        SocketAddr::V6(_) => {
            bytes[..2].copy_from_slice(&(libc::AF_INET6 as u16).to_ne_bytes());
            bytes[8..24].copy_from_slice(&Ipv6Addr::LOCALHOST.octets());
        }
    }
    bytes[2..4].copy_from_slice(&relay_port.to_be_bytes());
    Ok(bytes)
}

pub(super) fn socket_is_stream(
    pid: libc::pid_t,
    fd: libc::c_int,
    socket_types: &HashMap<String, libc::c_int>,
) -> bool {
    if let Some(socket_type) = duplicate_socket_type(pid, fd) {
        return socket_type == libc::SOCK_STREAM;
    }
    let Some(inode) = socket_inode(pid, fd) else {
        return false;
    };
    if let Some(socket_type) = socket_types.get(&inode) {
        return *socket_type == libc::SOCK_STREAM;
    }
    for protocol in ["udp", "udp6", "raw", "raw6"] {
        if socket_table_contains(pid, protocol, &inode) {
            return false;
        }
    }
    // Unconnected TCP sockets are not consistently listed in /proc/net/tcp.
    // Any socket not identified as datagram/raw is therefore treated as TCP.
    true
}

pub(super) fn duplicate_socket_type(pid: libc::pid_t, fd: libc::c_int) -> Option<libc::c_int> {
    let pidfd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) } as libc::c_int;
    if pidfd < 0 {
        return None;
    }
    let duplicated = unsafe { libc::syscall(libc::SYS_pidfd_getfd, pidfd, fd, 0) } as libc::c_int;
    unsafe { libc::close(pidfd) };
    if duplicated < 0 {
        return None;
    }
    let duplicated = unsafe { OwnedFd::from_raw_fd(duplicated) };
    let mut socket_type: libc::c_int = 0;
    let mut length = std::mem::size_of::<libc::c_int>() as libc::socklen_t;
    let result = unsafe {
        libc::getsockopt(
            std::os::fd::AsRawFd::as_raw_fd(&duplicated),
            libc::SOL_SOCKET,
            libc::SO_TYPE,
            (&mut socket_type as *mut libc::c_int).cast(),
            &mut length,
        )
    };
    (result == 0).then_some(socket_type)
}

pub(super) fn socket_inode(pid: libc::pid_t, fd: libc::c_int) -> Option<String> {
    let target = fs::read_link(format!("/proc/{pid}/fd/{fd}")).ok()?;
    let text = target.to_str()?;
    text.strip_prefix("socket:[")
        .and_then(|value| value.strip_suffix(']'))
        .map(str::to_string)
}

pub(super) fn socket_table_contains(pid: libc::pid_t, protocol: &str, inode: &str) -> bool {
    fs::read_to_string(format!("/proc/{pid}/net/{protocol}"))
        .ok()
        .is_some_and(|table| {
            table.lines().skip(1).any(|line| {
                line.split_ascii_whitespace()
                    .nth(9)
                    .is_some_and(|value| value == inode)
            })
        })
}
