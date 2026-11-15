//! CLIPRDR (Clipboard Virtual Channel Extension) — MS-RDPECLIP.
//!
//! What's implemented in this module (with round-trip unit tests):
//!
//! - Clipboard PDU header (`CLIPRDR_HEADER`) with msg type / flags.
//! - Format List PDU (long-form names, post-RDP 5.0).
//! - Clipboard caps PDU (general capability set).
//! - `FILEDESCRIPTORW` parsing for `CFSTR_FILEGROUPDESCRIPTORW`.
//! - File contents request / response framing (`CB_FILECONTENTS_REQUEST`,
//!   `CB_FILECONTENTS_RESPONSE`).
//!
//! All field encodings are little-endian per MS-RDPECLIP §2.2.

// ── Message types (CLIPRDR_HEADER.msgType) ──────────────────────────────

pub const CB_MONITOR_READY: u16 = 0x0001;
pub const CB_FORMAT_LIST: u16 = 0x0002;
pub const CB_FORMAT_LIST_RESPONSE: u16 = 0x0003;
pub const CB_FORMAT_DATA_REQUEST: u16 = 0x0004;
pub const CB_FORMAT_DATA_RESPONSE: u16 = 0x0005;
pub const CB_TEMP_DIRECTORY: u16 = 0x0006;
pub const CB_CLIP_CAPS: u16 = 0x0007;
pub const CB_FILECONTENTS_REQUEST: u16 = 0x0008;
pub const CB_FILECONTENTS_RESPONSE: u16 = 0x0009;
pub const CB_LOCK_CLIPDATA: u16 = 0x000A;
pub const CB_UNLOCK_CLIPDATA: u16 = 0x000B;

// ── Header flags ─────────────────────────────────────────────────────────

pub const CB_RESPONSE_OK: u16 = 0x0001;
pub const CB_RESPONSE_FAIL: u16 = 0x0002;
pub const CB_ASCII_NAMES: u16 = 0x0004;

// ── General capability flags (CB_CLIP_CAPS) ──────────────────────────────

pub const CB_USE_LONG_FORMAT_NAMES: u32 = 0x0000_0002;
pub const CB_STREAM_FILECLIP_ENABLED: u32 = 0x0000_0004;
pub const CB_FILECLIP_NO_FILE_PATHS: u32 = 0x0000_0008;
pub const CB_CAN_LOCK_CLIPDATA: u32 = 0x0000_0010;
pub const CB_HUGE_FILE_SUPPORT_ENABLED: u32 = 0x0000_0020;

// ── Standard Win32 clipboard format IDs ──────────────────────────────────

pub const CF_TEXT: u32 = 0x0001;
pub const CF_UNICODETEXT: u32 = 0x000D;
pub const CF_HDROP: u32 = 0x000F;

// File-clipboard format IDs are dynamic but conventionally use these
// when registered with their canonical names.
pub const FORMAT_NAME_FGW: &str = "FileGroupDescriptorW";
pub const FORMAT_NAME_FCONT: &str = "FileContents";

/// File contents request flags (`dwFlags`).
pub const FILECONTENTS_SIZE: u32 = 0x0000_0001;
pub const FILECONTENTS_RANGE: u32 = 0x0000_0002;

// ── PDU header ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClipHeader {
    pub msg_type: u16,
    pub msg_flags: u16,
    pub data_len: u32,
}

impl ClipHeader {
    pub const SIZE: usize = 8;

    pub fn encode(&self) -> [u8; Self::SIZE] {
        let mut out = [0u8; Self::SIZE];
        out[0..2].copy_from_slice(&self.msg_type.to_le_bytes());
        out[2..4].copy_from_slice(&self.msg_flags.to_le_bytes());
        out[4..8].copy_from_slice(&self.data_len.to_le_bytes());
        out
    }

    pub fn parse(buf: &[u8]) -> Result<Self, String> {
        if buf.len() < Self::SIZE {
            return Err(format!("CLIPRDR header truncated ({} bytes)", buf.len()));
        }
        Ok(Self {
            msg_type: u16::from_le_bytes([buf[0], buf[1]]),
            msg_flags: u16::from_le_bytes([buf[2], buf[3]]),
            data_len: u32::from_le_bytes([buf[4], buf[5], buf[6], buf[7]]),
        })
    }
}

// ── Format list ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClipFormat {
    pub id: u32,
    pub name: String, // empty for short-format / unnamed standard formats
}

/// Encode a long-form Format List PDU body. Each entry is
/// `(format_id : u32 LE)(format_name : null-terminated UTF-16 LE)`.
pub fn encode_format_list(formats: &[ClipFormat]) -> Vec<u8> {
    let mut body = Vec::new();
    for f in formats {
        body.extend_from_slice(&f.id.to_le_bytes());
        for u in f.name.encode_utf16() {
            body.extend_from_slice(&u.to_le_bytes());
        }
        body.extend_from_slice(&[0, 0]); // null terminator
    }
    body
}

/// Decode a long-form Format List PDU body.
pub fn decode_format_list(body: &[u8]) -> Result<Vec<ClipFormat>, String> {
    let mut out = Vec::new();
    let mut i = 0;
    while i + 4 <= body.len() {
        let id = u32::from_le_bytes([body[i], body[i + 1], body[i + 2], body[i + 3]]);
        i += 4;
        // Read UTF-16LE units until null terminator or buffer end.
        let mut units: Vec<u16> = Vec::new();
        loop {
            if i + 2 > body.len() {
                return Err("CLIPRDR format list: name not null-terminated".into());
            }
            let u = u16::from_le_bytes([body[i], body[i + 1]]);
            i += 2;
            if u == 0 {
                break;
            }
            units.push(u);
        }
        let name = String::from_utf16(&units).map_err(|e| format!("utf16 name: {}", e))?;
        out.push(ClipFormat { id, name });
    }
    if i != body.len() {
        return Err(format!(
            "CLIPRDR format list: trailing {} bytes",
            body.len() - i
        ));
    }
    Ok(out)
}

// ── Capability PDU (general only — others are uncommon) ─────────────────

pub fn build_caps_pdu(caps: u32, version: u32) -> Vec<u8> {
    // Wrapper: CB_CLIP_CAPS contains a `cCapabilitiesSets` u16, padding,
    // then capability sets. We emit a single general capability set:
    //   capabilitySetType u16   = 1 (CB_CAPSTYPE_GENERAL)
    //   lengthCapability u16    = 12
    //   version u32
    //   generalFlags u32
    let mut body = Vec::with_capacity(16);
    body.extend_from_slice(&1u16.to_le_bytes()); // cCapabilitiesSets
    body.extend_from_slice(&0u16.to_le_bytes()); // pad
    body.extend_from_slice(&1u16.to_le_bytes()); // capabilitySetType
    body.extend_from_slice(&12u16.to_le_bytes()); // lengthCapability
    body.extend_from_slice(&version.to_le_bytes());
    body.extend_from_slice(&caps.to_le_bytes());
    body
}

// ── FILEDESCRIPTORW (CFSTR_FILEGROUPDESCRIPTORW payload) ────────────────

/// Subset of `FILEDESCRIPTORW` we need for cross-OS clipboard copy/paste.
/// MS-RDPECLIP §2.2.5.2.3.1 — the on-the-wire struct is 592 bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileDescriptor {
    pub name: String,
    pub size: u64,
    pub is_directory: bool,
    pub attributes: u32,
}

pub const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x0000_0010;
pub const FILE_ATTRIBUTE_NORMAL: u32 = 0x0000_0080;
pub const FILE_DESCRIPTOR_BYTES: usize = 592;

const FILEDESCRIPTOR_FLAG_ATTRIBUTES: u32 = 0x0000_0004;
const FILEDESCRIPTOR_FLAG_FILESIZE: u32 = 0x0000_0040;

/// Decode a `FILEGROUPDESCRIPTORW` payload (a u32 count followed by
/// fixed-size descriptors).
pub fn decode_file_group(body: &[u8]) -> Result<Vec<FileDescriptor>, String> {
    if body.len() < 4 {
        return Err("FGW: truncated header".into());
    }
    let count = u32::from_le_bytes([body[0], body[1], body[2], body[3]]) as usize;
    let expected = 4 + count * FILE_DESCRIPTOR_BYTES;
    if body.len() < expected {
        return Err(format!(
            "FGW: {} bytes < expected {} for {} descriptors",
            body.len(),
            expected,
            count,
        ));
    }
    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        let off = 4 + i * FILE_DESCRIPTOR_BYTES;
        let chunk = &body[off..off + FILE_DESCRIPTOR_BYTES];
        out.push(decode_one_descriptor(chunk)?);
    }
    Ok(out)
}

fn decode_one_descriptor(buf: &[u8]) -> Result<FileDescriptor, String> {
    if buf.len() != FILE_DESCRIPTOR_BYTES {
        return Err(format!(
            "FILEDESCRIPTORW: bad length {} (expected {})",
            buf.len(),
            FILE_DESCRIPTOR_BYTES
        ));
    }
    // Layout (offset / size):
    //   0   dwFlags                       u32
    //   4   clsid                         16 bytes (unused)
    //   20  sizel (POINTL)                8 bytes
    //   28  pointl                        8 bytes
    //   36  dwFileAttributes              u32
    //   40  ftCreationTime                FILETIME (8)
    //   48  ftLastAccessTime              FILETIME (8)
    //   56  ftLastWriteTime               FILETIME (8)
    //   64  nFileSizeHigh                 u32
    //   68  nFileSizeLow                  u32
    //   72  cFileName                     520 bytes (260 UTF-16 LE chars, NUL-terminated)
    let flags = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]);
    let attrs = u32::from_le_bytes([buf[36], buf[37], buf[38], buf[39]]);
    let size_hi = u32::from_le_bytes([buf[64], buf[65], buf[66], buf[67]]);
    let size_lo = u32::from_le_bytes([buf[68], buf[69], buf[70], buf[71]]);
    let size = if flags & FILEDESCRIPTOR_FLAG_FILESIZE != 0 {
        ((size_hi as u64) << 32) | (size_lo as u64)
    } else {
        0
    };
    let attrs = if flags & FILEDESCRIPTOR_FLAG_ATTRIBUTES != 0 {
        attrs
    } else {
        FILE_ATTRIBUTE_NORMAL
    };
    let mut units: Vec<u16> = Vec::with_capacity(260);
    for chunk in buf[72..72 + 520].chunks_exact(2) {
        let u = u16::from_le_bytes([chunk[0], chunk[1]]);
        if u == 0 {
            break;
        }
        units.push(u);
    }
    let name =
        String::from_utf16(&units).map_err(|e| format!("FILEDESCRIPTORW name utf16: {}", e))?;
    Ok(FileDescriptor {
        name,
        size,
        is_directory: attrs & FILE_ATTRIBUTE_DIRECTORY != 0,
        attributes: attrs,
    })
}

/// Encode a list of [`FileDescriptor`] as a `FILEGROUPDESCRIPTORW` payload.
pub fn encode_file_group(files: &[FileDescriptor]) -> Result<Vec<u8>, String> {
    let count = files.len();
    if count > u32::MAX as usize {
        return Err("FGW: too many files".into());
    }
    let mut out = Vec::with_capacity(4 + count * FILE_DESCRIPTOR_BYTES);
    out.extend_from_slice(&(count as u32).to_le_bytes());
    for f in files {
        out.extend_from_slice(&encode_one_descriptor(f)?);
    }
    Ok(out)
}

fn encode_one_descriptor(f: &FileDescriptor) -> Result<[u8; FILE_DESCRIPTOR_BYTES], String> {
    let mut out = [0u8; FILE_DESCRIPTOR_BYTES];
    let flags = FILEDESCRIPTOR_FLAG_ATTRIBUTES | FILEDESCRIPTOR_FLAG_FILESIZE;
    out[0..4].copy_from_slice(&flags.to_le_bytes());
    let attrs = if f.is_directory {
        f.attributes | FILE_ATTRIBUTE_DIRECTORY
    } else {
        f.attributes
    };
    out[36..40].copy_from_slice(&attrs.to_le_bytes());
    let size_hi = (f.size >> 32) as u32;
    let size_lo = f.size as u32;
    out[64..68].copy_from_slice(&size_hi.to_le_bytes());
    out[68..72].copy_from_slice(&size_lo.to_le_bytes());
    let units: Vec<u16> = f.name.encode_utf16().collect();
    if units.len() >= 260 {
        return Err("FILEDESCRIPTORW name >= 260 UTF-16 units".into());
    }
    let mut i = 72;
    for u in &units {
        let bytes = u.to_le_bytes();
        out[i] = bytes[0];
        out[i + 1] = bytes[1];
        i += 2;
    }
    Ok(out)
}

// ── File contents request / response ───────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileContentsRequest {
    pub stream_id: u32,
    pub list_index: u32,
    pub flags: u32,
    pub position: u64,
    pub cb_requested: u32,
    pub clip_data_id: Option<u32>,
}

pub fn encode_file_contents_request(req: &FileContentsRequest) -> Vec<u8> {
    let mut out = Vec::with_capacity(28 + 4);
    out.extend_from_slice(&req.stream_id.to_le_bytes());
    out.extend_from_slice(&req.list_index.to_le_bytes());
    out.extend_from_slice(&req.flags.to_le_bytes());
    let pos_lo = req.position as u32;
    let pos_hi = (req.position >> 32) as u32;
    out.extend_from_slice(&pos_lo.to_le_bytes());
    out.extend_from_slice(&pos_hi.to_le_bytes());
    out.extend_from_slice(&req.cb_requested.to_le_bytes());
    if let Some(cid) = req.clip_data_id {
        out.extend_from_slice(&cid.to_le_bytes());
    }
    out
}

pub fn decode_file_contents_request(buf: &[u8]) -> Result<FileContentsRequest, String> {
    if buf.len() < 24 {
        return Err(format!("CB_FILECONTENTS_REQUEST: {} bytes < 24", buf.len()));
    }
    let stream_id = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]);
    let list_index = u32::from_le_bytes([buf[4], buf[5], buf[6], buf[7]]);
    let flags = u32::from_le_bytes([buf[8], buf[9], buf[10], buf[11]]);
    let pos_lo = u32::from_le_bytes([buf[12], buf[13], buf[14], buf[15]]) as u64;
    let pos_hi = u32::from_le_bytes([buf[16], buf[17], buf[18], buf[19]]) as u64;
    let position = (pos_hi << 32) | pos_lo;
    let cb_requested = u32::from_le_bytes([buf[20], buf[21], buf[22], buf[23]]);
    let clip_data_id = if buf.len() >= 28 {
        Some(u32::from_le_bytes([buf[24], buf[25], buf[26], buf[27]]))
    } else {
        None
    };
    Ok(FileContentsRequest {
        stream_id,
        list_index,
        flags,
        position,
        cb_requested,
        clip_data_id,
    })
}

/// `CB_FILECONTENTS_RESPONSE`: stream_id (u32) followed by the data bytes
/// (size response is 8 bytes, range response is up to `cbRequested`).
pub fn encode_file_contents_response(stream_id: u32, data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + data.len());
    out.extend_from_slice(&stream_id.to_le_bytes());
    out.extend_from_slice(data);
    out
}

#[cfg(test)]
#[path = "cliprdr_tests.rs"]
mod tests;
