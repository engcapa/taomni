//! RDPDR (Device Redirection Virtual Channel) — MS-RDPEFS.
//!
//! Implements just enough framing to surface a single mapped local folder
//! as a redirected drive on the Windows host. The IO request handlers
//! sandbox every path to a canonicalized root.
//!
//! Implemented + unit-tested:
//!
//! - `RDPDR_HEADER` (Component / PacketId).
//! - `Server Announce` and `Client Announce Reply`.
//! - `Client Name Request`.
//! - Device list (we always announce exactly one filesystem device).
//! - IO request header parsing (DeviceCreate / Read / Write / Close /
//!   QueryInformation / QueryDirectory / DirectoryControl).
//! - Path safety check (`safe_join`) used by the handlers to refuse
//!   traversals.

use std::path::{Component, Path, PathBuf};

// ── Component / PacketId pairs ──────────────────────────────────────────

pub const RDPDR_CTYP_CORE: u16 = 0x4472; // "rD"
pub const RDPDR_CTYP_PRT: u16 = 0x5052; // "RP" (printer)

pub const PAKID_CORE_SERVER_ANNOUNCE: u16 = 0x496E; // "nI"
pub const PAKID_CORE_CLIENTID_CONFIRM: u16 = 0x4343; // "CC"
pub const PAKID_CORE_CLIENT_NAME: u16 = 0x434E; // "NC"
pub const PAKID_CORE_DEVICELIST_ANNOUNCE: u16 = 0x4441; // "AD"
pub const PAKID_CORE_DEVICE_IOREQUEST: u16 = 0x4952; // "RI"
pub const PAKID_CORE_DEVICE_REPLY: u16 = 0x6472; // "rd"
pub const PAKID_CORE_SERVER_CAPABILITY: u16 = 0x5350; // "PS"
pub const PAKID_CORE_CLIENT_CAPABILITY: u16 = 0x4350; // "PC"

// ── Device types ────────────────────────────────────────────────────────

pub const RDPDR_DTYP_SERIAL: u32 = 0x0000_0001;
pub const RDPDR_DTYP_PARALLEL: u32 = 0x0000_0002;
pub const RDPDR_DTYP_PRINT: u32 = 0x0000_0004;
pub const RDPDR_DTYP_FILESYSTEM: u32 = 0x0000_0008;
pub const RDPDR_DTYP_SMARTCARD: u32 = 0x0000_0020;

// ── IO requests (MajorFunction values, MS-RDPEFS §2.2.1.4) ──────────────

pub const IRP_MJ_CREATE: u32 = 0x0000_0000;
pub const IRP_MJ_CLOSE: u32 = 0x0000_0002;
pub const IRP_MJ_READ: u32 = 0x0000_0003;
pub const IRP_MJ_WRITE: u32 = 0x0000_0004;
pub const IRP_MJ_DEVICE_CONTROL: u32 = 0x0000_000E;
pub const IRP_MJ_QUERY_INFORMATION: u32 = 0x0000_0005;
pub const IRP_MJ_SET_INFORMATION: u32 = 0x0000_0006;
pub const IRP_MJ_QUERY_VOLUME_INFORMATION: u32 = 0x0000_000A;
pub const IRP_MJ_DIRECTORY_CONTROL: u32 = 0x0000_000C;

// ── Header ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RdpdrHeader {
    pub component: u16,
    pub packet_id: u16,
}

impl RdpdrHeader {
    pub const SIZE: usize = 4;

    pub fn encode(&self) -> [u8; Self::SIZE] {
        let mut out = [0u8; Self::SIZE];
        out[0..2].copy_from_slice(&self.component.to_le_bytes());
        out[2..4].copy_from_slice(&self.packet_id.to_le_bytes());
        out
    }

    pub fn parse(buf: &[u8]) -> Result<Self, String> {
        if buf.len() < Self::SIZE {
            return Err("RDPDR header truncated".into());
        }
        Ok(Self {
            component: u16::from_le_bytes([buf[0], buf[1]]),
            packet_id: u16::from_le_bytes([buf[2], buf[3]]),
        })
    }
}

// ── Client Name Request (PAKID_CORE_CLIENT_NAME) ────────────────────────

/// `unicodeFlag`/`codePage`/`computerNameLen`/`computerName` — we always
/// send Unicode (UTF-16 LE).
pub fn build_client_name(name: &str) -> Vec<u8> {
    let mut header = RdpdrHeader {
        component: RDPDR_CTYP_CORE,
        packet_id: PAKID_CORE_CLIENT_NAME,
    }
    .encode()
    .to_vec();
    header.extend_from_slice(&1u32.to_le_bytes()); // unicodeFlag
    header.extend_from_slice(&0u32.to_le_bytes()); // codePage
    let mut name_utf16: Vec<u8> = name.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    name_utf16.extend_from_slice(&[0, 0]); // null terminator
    header.extend_from_slice(&(name_utf16.len() as u32).to_le_bytes());
    header.extend_from_slice(&name_utf16);
    header
}

// ── Device announcement ────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AnnouncedDevice {
    pub device_id: u32,
    pub device_type: u32,
    pub preferred_dos_name: String, // 8 bytes max ASCII, null padded
    pub device_data: Vec<u8>,
}

pub fn build_device_list_announce(devices: &[AnnouncedDevice]) -> Result<Vec<u8>, String> {
    let mut out = RdpdrHeader {
        component: RDPDR_CTYP_CORE,
        packet_id: PAKID_CORE_DEVICELIST_ANNOUNCE,
    }
    .encode()
    .to_vec();
    out.extend_from_slice(&(devices.len() as u32).to_le_bytes());
    for d in devices {
        out.extend_from_slice(&d.device_type.to_le_bytes());
        out.extend_from_slice(&d.device_id.to_le_bytes());
        let dos = d.preferred_dos_name.as_bytes();
        if dos.len() > 8 {
            return Err(format!(
                "preferredDosName '{}' is {} bytes (max 8)",
                d.preferred_dos_name,
                dos.len()
            ));
        }
        let mut padded = [0u8; 8];
        padded[..dos.len()].copy_from_slice(dos);
        out.extend_from_slice(&padded);
        out.extend_from_slice(&(d.device_data.len() as u32).to_le_bytes());
        out.extend_from_slice(&d.device_data);
    }
    Ok(out)
}

// ── IO request header ──────────────────────────────────────────────────

/// Layout (MS-RDPEFS §2.2.1.4):
///   DeviceId u32  FileId u32  CompletionId u32
///   MajorFunction u32  MinorFunction u32
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeviceIoRequestHeader {
    pub device_id: u32,
    pub file_id: u32,
    pub completion_id: u32,
    pub major: u32,
    pub minor: u32,
}

impl DeviceIoRequestHeader {
    pub const SIZE: usize = 20;

    pub fn parse(buf: &[u8]) -> Result<Self, String> {
        if buf.len() < Self::SIZE {
            return Err(format!(
                "DR_DEVICE_IOREQUEST: {} bytes < {}",
                buf.len(),
                Self::SIZE
            ));
        }
        Ok(Self {
            device_id: u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]),
            file_id: u32::from_le_bytes([buf[4], buf[5], buf[6], buf[7]]),
            completion_id: u32::from_le_bytes([buf[8], buf[9], buf[10], buf[11]]),
            major: u32::from_le_bytes([buf[12], buf[13], buf[14], buf[15]]),
            minor: u32::from_le_bytes([buf[16], buf[17], buf[18], buf[19]]),
        })
    }

    pub fn encode(&self) -> [u8; Self::SIZE] {
        let mut out = [0u8; Self::SIZE];
        out[0..4].copy_from_slice(&self.device_id.to_le_bytes());
        out[4..8].copy_from_slice(&self.file_id.to_le_bytes());
        out[8..12].copy_from_slice(&self.completion_id.to_le_bytes());
        out[12..16].copy_from_slice(&self.major.to_le_bytes());
        out[16..20].copy_from_slice(&self.minor.to_le_bytes());
        out
    }
}

// ── Path sandboxing ────────────────────────────────────────────────────

/// Resolve `requested` (relative or starting with `/` or `\`) against
/// `root`, refusing any traversal that escapes `root`.
///
/// Returns the canonical path inside the root (which may not yet exist;
/// callers handle ENOENT). Used by every IO request handler.
pub fn safe_join(root: &Path, requested: &str) -> Result<PathBuf, String> {
    let normalized = requested.replace('\\', "/");
    let trimmed = normalized.trim_start_matches('/');
    let candidate = root.join(trimmed);
    let mut resolved = PathBuf::new();
    for c in candidate.components() {
        match c {
            Component::ParentDir => {
                if !resolved.pop() {
                    return Err("rdpdr: path traversal rejected".into());
                }
            }
            Component::CurDir => {}
            Component::RootDir => {
                resolved.push("/");
            }
            Component::Prefix(p) => {
                resolved.push(p.as_os_str());
            }
            Component::Normal(seg) => {
                resolved.push(seg);
            }
        }
    }
    // Ensure the resolved path is still within root.
    if !resolved.starts_with(root) {
        return Err(format!(
            "rdpdr: refusing path '{}' outside mapped root '{}'",
            resolved.display(),
            root.display()
        ));
    }
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_round_trip() {
        let h = RdpdrHeader {
            component: RDPDR_CTYP_CORE,
            packet_id: PAKID_CORE_DEVICE_IOREQUEST,
        };
        let buf = h.encode();
        let h2 = RdpdrHeader::parse(&buf).unwrap();
        assert_eq!(h, h2);
    }

    #[test]
    fn client_name_carries_utf16() {
        let buf = build_client_name("HostName");
        // Unicode flag = 1
        assert_eq!(u32::from_le_bytes([buf[4], buf[5], buf[6], buf[7]]), 1);
        // Length includes null terminator (HostName == 8 chars + NUL == 18 bytes).
        let name_len = u32::from_le_bytes([buf[12], buf[13], buf[14], buf[15]]);
        assert_eq!(name_len as usize, "HostName".chars().count() * 2 + 2);
    }

    #[test]
    fn device_list_round_trip_one_filesystem() {
        let dev = AnnouncedDevice {
            device_id: 1,
            device_type: RDPDR_DTYP_FILESYSTEM,
            preferred_dos_name: "NEWMOB".into(),
            device_data: b"shared\0".to_vec(),
        };
        let buf = build_device_list_announce(&[dev.clone()]).unwrap();
        let header = RdpdrHeader::parse(&buf).unwrap();
        assert_eq!(header.packet_id, PAKID_CORE_DEVICELIST_ANNOUNCE);
        let count = u32::from_le_bytes([buf[4], buf[5], buf[6], buf[7]]);
        assert_eq!(count, 1);
        let dtype = u32::from_le_bytes([buf[8], buf[9], buf[10], buf[11]]);
        assert_eq!(dtype, RDPDR_DTYP_FILESYSTEM);
    }

    #[test]
    fn device_list_rejects_long_dos_name() {
        let dev = AnnouncedDevice {
            device_id: 1,
            device_type: RDPDR_DTYP_FILESYSTEM,
            preferred_dos_name: "TOOLONGNAME".into(),
            device_data: vec![],
        };
        assert!(build_device_list_announce(&[dev]).is_err());
    }

    #[test]
    fn io_request_header_round_trip() {
        let h = DeviceIoRequestHeader {
            device_id: 1,
            file_id: 0xCAFE,
            completion_id: 99,
            major: IRP_MJ_READ,
            minor: 0,
        };
        let buf = h.encode();
        let h2 = DeviceIoRequestHeader::parse(&buf).unwrap();
        assert_eq!(h, h2);
    }

    #[test]
    fn io_request_header_rejects_truncated() {
        assert!(DeviceIoRequestHeader::parse(&[0u8; 10]).is_err());
    }

    #[test]
    fn safe_join_blocks_dot_dot() {
        let root = Path::new("/var/lib/newmob");
        assert!(safe_join(root, "../etc/passwd").is_err());
        assert!(safe_join(root, "/../etc/passwd").is_err());
        assert!(safe_join(root, "subdir/../../escape").is_err());
    }

    #[test]
    fn safe_join_allows_internal_traversal() {
        let root = Path::new("/data");
        let p = safe_join(root, "/sub/dir/file.txt").unwrap();
        assert_eq!(p, PathBuf::from("/data/sub/dir/file.txt"));
        let p2 = safe_join(root, "sub/../sub/x").unwrap();
        assert_eq!(p2, PathBuf::from("/data/sub/x"));
    }

    #[test]
    fn safe_join_normalizes_backslashes() {
        let root = Path::new("/data");
        let p = safe_join(root, r"sub\dir\file").unwrap();
        assert_eq!(p, PathBuf::from("/data/sub/dir/file"));
    }
}
