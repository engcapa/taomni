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
