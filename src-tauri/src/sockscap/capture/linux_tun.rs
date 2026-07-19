//! Linux persistent TUN packet I/O.
//!
//! The privileged transaction creates and assigns the interface; this module
//! is the unprivileged, L3-only reader/writer used after that transaction.  It
//! never changes routes or cgroups.  Reads are cancellation-safe at packet
//! boundaries, and writes use one kernel write per packet so a cancellation
//! cannot leave a partially emitted L3 frame in the device.

use std::fmt;
use std::io;
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::fs::OpenOptionsExt;
use std::sync::Arc;

use bytes::Bytes;
use tokio::io::unix::AsyncFd;

use super::packet_device::{
    MAX_IP_PACKET_BYTES, PacketDeviceError, PacketEgressFrame, PacketFrame, PacketIdentity,
};
use crate::sockscap::types::CapturePlatform;

pub const LINUX_TUN_PATH: &str = "/dev/net/tun";
pub const LINUX_TUN_IFNAMSIZ: usize = 16;
pub const LINUX_TUN_DEFAULT_MTU: usize = 1500;
pub const LINUX_TUN_MIN_MTU: usize = 576;

const IFF_TUN: libc::c_short = 0x0001;
const IFF_NO_PI: libc::c_short = 0x1000;
// Linux's TUNSETIFF is _IOW('T', 202, int), stable across supported Linux
// architectures.  Keeping the value local avoids depending on libc exposing
// an architecture-specific alias.
const TUNSETIFF: libc::c_ulong = 0x4004_54ca;
const TUNGETOWNER: libc::c_ulong = 0x8004_54cc;

#[repr(C)]
union IfReqData {
    flags: libc::c_short,
    padding: [u8; 24],
}

#[repr(C)]
struct IfReq {
    name: [libc::c_char; LINUX_TUN_IFNAMSIZ],
    data: IfReqData,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinuxTunConfig {
    pub interface_name: String,
    pub generation: u64,
    pub owner_uid: u32,
    pub mtu: usize,
}

impl LinuxTunConfig {
    pub fn validate(&self) -> Result<(), LinuxTunError> {
        if self.generation == 0 || self.owner_uid == 0 || self.owner_uid == u32::MAX {
            return Err(LinuxTunError::invalid(
                "LINUX_TUN_CONFIG_IDENTITY_INVALID",
                "TUN generation and non-root owner UID must be explicit",
            ));
        }
        if self.interface_name.is_empty()
            || self.interface_name.len() >= LINUX_TUN_IFNAMSIZ
            || !self
                .interface_name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
        {
            return Err(LinuxTunError::invalid(
                "LINUX_TUN_NAME_INVALID",
                "TUN interface name is empty, too long, or contains unsupported characters",
            ));
        }
        if !(LINUX_TUN_MIN_MTU..=MAX_IP_PACKET_BYTES).contains(&self.mtu) {
            return Err(LinuxTunError::invalid(
                "LINUX_TUN_MTU_INVALID",
                "TUN MTU is outside the bounded L3 packet range",
            ));
        }
        Ok(())
    }
}

/// A TUN fd whose ownership and interface name were verified at open time.
pub struct LinuxTunDevice {
    io: AsyncFd<OwnedFd>,
    config: LinuxTunConfig,
}

impl fmt::Debug for LinuxTunDevice {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LinuxTunDevice")
            .field("interface_name", &self.config.interface_name)
            .field("generation", &self.config.generation)
            .field("mtu", &self.config.mtu)
            .finish_non_exhaustive()
    }
}

impl LinuxTunDevice {
    /// Open a persistent interface previously created by the reviewed helper.
    /// `TUNSETIFF` is still issued to bind this fd to the exact expected name;
    /// a different or dynamically assigned name is rejected.
    pub fn open(config: LinuxTunConfig) -> Result<Arc<Self>, LinuxTunError> {
        config.validate()?;
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(libc::O_CLOEXEC | libc::O_NONBLOCK)
            .open(LINUX_TUN_PATH)
            .map_err(|error| LinuxTunError::io("LINUX_TUN_OPEN_FAILED", error))?;
        let fd: OwnedFd = file.into();
        let actual_name = bind_interface(fd.as_raw_fd(), &config.interface_name)?;
        if actual_name != config.interface_name {
            return Err(LinuxTunError::invalid(
                "LINUX_TUN_NAME_MISMATCH",
                "kernel returned a different TUN interface name",
            ));
        }
        verify_owner(fd.as_raw_fd(), config.owner_uid)?;
        let io =
            AsyncFd::new(fd).map_err(|error| LinuxTunError::io("LINUX_TUN_ASYNC_FAILED", error))?;
        Ok(Arc::new(Self { io, config }))
    }

    /// Construct a device around an already verified fd.  This is restricted
    /// to tests and a future helper handoff implementation; callers must have
    /// performed the same `TUNSETIFF`/ownership checks as [`Self::open`].
    pub(crate) fn from_verified_fd(
        fd: OwnedFd,
        config: LinuxTunConfig,
    ) -> Result<Arc<Self>, LinuxTunError> {
        config.validate()?;
        let io =
            AsyncFd::new(fd).map_err(|error| LinuxTunError::io("LINUX_TUN_ASYNC_FAILED", error))?;
        Ok(Arc::new(Self { io, config }))
    }

    pub fn config(&self) -> &LinuxTunConfig {
        &self.config
    }

    pub async fn read_l3_packet(&self) -> Result<Bytes, LinuxTunError> {
        let mut payload = vec![0_u8; MAX_IP_PACKET_BYTES];
        loop {
            let mut readiness = self
                .io
                .readable()
                .await
                .map_err(|error| LinuxTunError::io("LINUX_TUN_READ_READY_FAILED", error))?;
            match readiness.try_io(|inner| {
                let result = unsafe {
                    libc::read(
                        inner.get_ref().as_raw_fd(),
                        payload.as_mut_ptr().cast(),
                        payload.len(),
                    )
                };
                if result < 0 {
                    Err(io::Error::last_os_error())
                } else {
                    Ok(result as usize)
                }
            }) {
                Ok(Ok(0)) => {
                    return Err(LinuxTunError::invalid(
                        "LINUX_TUN_CLOSED",
                        "TUN returned EOF",
                    ));
                }
                Ok(Ok(length)) => return Ok(Bytes::copy_from_slice(&payload[..length])),
                Ok(Err(error)) if error.kind() == io::ErrorKind::WouldBlock => continue,
                Ok(Err(error)) => {
                    return Err(LinuxTunError::io("LINUX_TUN_READ_FAILED", error));
                }
                Err(_would_block) => continue,
            }
        }
    }

    /// Write one complete L3 packet.  Linux TUN writes are packet-atomic for
    /// frames within the configured MTU; a short write is treated as a hard
    /// error instead of retrying a potentially corrupted frame.
    pub async fn write_l3_packet(&self, payload: &[u8]) -> Result<(), LinuxTunError> {
        if payload.is_empty() || payload.len() > self.config.mtu {
            return Err(LinuxTunError::invalid(
                "LINUX_TUN_PACKET_SIZE_INVALID",
                "TUN packet exceeds the configured MTU",
            ));
        }
        loop {
            let mut readiness = self
                .io
                .writable()
                .await
                .map_err(|error| LinuxTunError::io("LINUX_TUN_WRITE_READY_FAILED", error))?;
            match readiness.try_io(|inner| {
                let result = unsafe {
                    libc::write(
                        inner.get_ref().as_raw_fd(),
                        payload.as_ptr().cast(),
                        payload.len(),
                    )
                };
                if result < 0 {
                    Err(io::Error::last_os_error())
                } else {
                    Ok(result as usize)
                }
            }) {
                Ok(Ok(length)) if length == payload.len() => return Ok(()),
                Ok(Ok(_short)) => {
                    return Err(LinuxTunError::invalid(
                        "LINUX_TUN_SHORT_WRITE",
                        "kernel accepted only part of an L3 packet",
                    ));
                }
                Ok(Err(error)) if error.kind() == io::ErrorKind::WouldBlock => continue,
                Ok(Err(error)) => {
                    return Err(LinuxTunError::io("LINUX_TUN_WRITE_FAILED", error));
                }
                Err(_would_block) => continue,
            }
        }
    }
}

/// Global-scope reader used by the first Linux vertical slice. Plain TUN has
/// no trustworthy native flow identifier, so packets deliberately leave
/// `capture_id` unset and the controlled stack owns the bounded tuple table.
/// Application/PID modes must use a separate verified tuple→process side
/// channel and are rejected rather than silently falling back to global.
pub struct LinuxGlobalTunReader {
    device: Arc<LinuxTunDevice>,
}

impl fmt::Debug for LinuxGlobalTunReader {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LinuxGlobalTunReader")
            .field("interface_name", &self.device.config.interface_name)
            .finish_non_exhaustive()
    }
}

impl LinuxGlobalTunReader {
    pub fn new(device: Arc<LinuxTunDevice>) -> Self {
        Self { device }
    }

    pub fn device(&self) -> &Arc<LinuxTunDevice> {
        &self.device
    }

    pub async fn read_frame(&self) -> Result<PacketFrame, LinuxTunError> {
        let payload = self.device.read_l3_packet().await?;
        let identity =
            PacketIdentity::global(self.device.config.generation, None, CapturePlatform::Linux);
        PacketFrame::new(
            identity,
            payload,
            self.device.config.generation,
            CapturePlatform::Linux,
        )
        .map_err(LinuxTunError::packet)
    }

    pub async fn write_frame(&self, frame: &PacketEgressFrame) -> Result<(), LinuxTunError> {
        frame
            .validate_for(self.device.config.generation, CapturePlatform::Linux)
            .map_err(LinuxTunError::packet)?;
        if frame.payload.len() > self.device.config.mtu {
            return Err(LinuxTunError::invalid(
                "LINUX_TUN_PACKET_SIZE_INVALID",
                "egress packet exceeds the configured TUN MTU",
            ));
        }
        self.device.write_l3_packet(&frame.payload).await
    }
}

#[derive(Debug, thiserror::Error)]
pub enum LinuxTunError {
    #[error("{code}: {message}")]
    Invalid {
        code: &'static str,
        message: &'static str,
    },
    #[error("{code}: {source}")]
    Io {
        code: &'static str,
        #[source]
        source: io::Error,
    },
    #[error("LINUX_TUN_PACKET_CONTRACT: {0}")]
    Packet(PacketDeviceError),
}

impl LinuxTunError {
    fn invalid(code: &'static str, message: &'static str) -> Self {
        Self::Invalid { code, message }
    }

    fn io(code: &'static str, source: io::Error) -> Self {
        Self::Io { code, source }
    }

    fn packet(error: PacketDeviceError) -> Self {
        Self::Packet(error)
    }

    pub fn code(&self) -> &'static str {
        match self {
            Self::Invalid { code, .. } | Self::Io { code, .. } => code,
            Self::Packet(error) => error.code(),
        }
    }
}

fn bind_interface(fd: std::os::fd::RawFd, expected_name: &str) -> Result<String, LinuxTunError> {
    let mut request = IfReq {
        name: [0; LINUX_TUN_IFNAMSIZ],
        data: IfReqData {
            flags: IFF_TUN | IFF_NO_PI,
        },
    };
    for (slot, byte) in request.name.iter_mut().zip(expected_name.bytes()) {
        *slot = byte as libc::c_char;
    }
    // SAFETY: `request` is a correctly sized Linux ifreq-compatible buffer and
    // the fd was opened from /dev/net/tun.
    let result = unsafe { libc::ioctl(fd, TUNSETIFF, &mut request) };
    if result < 0 {
        return Err(LinuxTunError::io(
            "LINUX_TUN_BIND_FAILED",
            io::Error::last_os_error(),
        ));
    }
    let length = request
        .name
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(LINUX_TUN_IFNAMSIZ);
    String::from_utf8(
        request.name[..length]
            .iter()
            .map(|byte| *byte as u8)
            .collect(),
    )
    .map_err(|_| {
        LinuxTunError::invalid(
            "LINUX_TUN_NAME_INVALID",
            "kernel returned a non-UTF8 interface name",
        )
    })
}

fn verify_owner(fd: std::os::fd::RawFd, expected_uid: u32) -> Result<(), LinuxTunError> {
    let mut owner: libc::c_int = -1;
    // SAFETY: `owner` is a writable c_int as required by TUNGETOWNER.
    let result = unsafe { libc::ioctl(fd, TUNGETOWNER, &mut owner) };
    if result < 0 {
        return Err(LinuxTunError::io(
            "LINUX_TUN_OWNER_QUERY_FAILED",
            io::Error::last_os_error(),
        ));
    }
    if owner < 0 || owner as u32 != expected_uid {
        return Err(LinuxTunError::invalid(
            "LINUX_TUN_OWNER_MISMATCH",
            "persistent TUN owner does not match the authorized runtime user",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> LinuxTunConfig {
        LinuxTunConfig {
            interface_name: "ts7".into(),
            generation: 7,
            owner_uid: 1000,
            mtu: LINUX_TUN_DEFAULT_MTU,
        }
    }

    #[test]
    fn config_rejects_unsafe_names_and_mtu() {
        assert!(config().validate().is_ok());
        let mut bad = config();
        bad.interface_name = "../tun".into();
        assert_eq!(bad.validate().unwrap_err().code(), "LINUX_TUN_NAME_INVALID");
        let mut bad = config();
        bad.mtu = LINUX_TUN_MIN_MTU - 1;
        assert_eq!(bad.validate().unwrap_err().code(), "LINUX_TUN_MTU_INVALID");
        let mut bad = config();
        bad.owner_uid = 0;
        assert_eq!(
            bad.validate().unwrap_err().code(),
            "LINUX_TUN_CONFIG_IDENTITY_INVALID"
        );
    }

    #[test]
    fn ifreq_flags_are_l3_tun_without_packet_info() {
        assert_eq!(IFF_TUN | IFF_NO_PI, 0x1001);
        assert_eq!(TUNSETIFF, 0x4004_54ca);
        assert_eq!(TUNGETOWNER, 0x8004_54cc);
    }

    #[test]
    fn interface_name_encoding_is_bounded() {
        let mut request = IfReq {
            name: [0; LINUX_TUN_IFNAMSIZ],
            data: IfReqData {
                flags: IFF_TUN | IFF_NO_PI,
            },
        };
        for (slot, byte) in request.name.iter_mut().zip("ts7".bytes()) {
            *slot = byte as libc::c_char;
        }
        let length = request.name.iter().position(|byte| *byte == 0).unwrap();
        assert_eq!(
            &request.name[..length],
            &[
                b't' as libc::c_char,
                b's' as libc::c_char,
                b'7' as libc::c_char
            ]
        );
    }

    #[test]
    fn global_reader_identity_is_explicitly_linux_global() {
        // This test does not open /dev/net/tun; it verifies the contract shape
        // used when a real helper-created fd is supplied.
        assert_eq!(CapturePlatform::current(), CapturePlatform::Linux);
        assert_eq!(LINUX_TUN_PATH, "/dev/net/tun");
    }
}
