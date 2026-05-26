//! RemoteFX (RDP-RFX) bitstream framing.
//!
//! RFX uses a TLV envelope where each block has a 16-bit type, a 32-bit
//! length (including the header), and a payload. This module implements
//! the envelope parser and the well-known block types for the entry
//! layer — `WBT_HEADER`, `WBT_CONTEXT`, `WBT_FRAME_BEGIN`, `WBT_REGION`,
//! `WBT_TILESET`, `WBT_FRAME_END` — and the `RFX_RECT` and `TS_RFX_TILE`
//! sub-structures.
//!
//! The actual DWT + Quantization + RLGR decoder is staged for the
//! deeper IronRDP wiring step. This module provides the framing the
//! decoder will sit on top of, plus structural unit tests so the
//! envelope handling itself is correct.
//!
//! All multi-byte integers in RFX are little-endian.

pub const WBT_SYNC: u16 = 0xCCC0;
pub const WBT_CODEC_VERSIONS: u16 = 0xCCC1;
pub const WBT_CHANNELS: u16 = 0xCCC2;
pub const WBT_CONTEXT: u16 = 0xCCC3;
pub const WBT_FRAME_BEGIN: u16 = 0xCCC4;
pub const WBT_FRAME_END: u16 = 0xCCC5;
pub const WBT_REGION: u16 = 0xCCC6;
pub const WBT_EXTENSION: u16 = 0xCCC7;
pub const WBT_TILESET: u16 = 0xCAC2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RfxBlockHeader {
    pub block_type: u16,
    pub block_len: u32,
}

impl RfxBlockHeader {
    pub const SIZE: usize = 6;

    pub fn parse(buf: &[u8]) -> Result<Self, String> {
        if buf.len() < Self::SIZE {
            return Err(format!("RFX block: {} bytes < {}", buf.len(), Self::SIZE));
        }
        let block_type = u16::from_le_bytes([buf[0], buf[1]]);
        let block_len =
            u32::from_le_bytes([buf[2], buf[3], buf[4], buf[5]]);
        if (block_len as usize) < Self::SIZE {
            return Err(format!(
                "RFX block: declared length {} < header {}",
                block_len,
                Self::SIZE
            ));
        }
        Ok(Self {
            block_type,
            block_len,
        })
    }

    pub fn encode(&self) -> [u8; Self::SIZE] {
        let mut out = [0u8; Self::SIZE];
        out[0..2].copy_from_slice(&self.block_type.to_le_bytes());
        out[2..6].copy_from_slice(&self.block_len.to_le_bytes());
        out
    }
}

/// `RFX_RECT`: 4 × u16 (x, y, w, h) — the standard rectangle struct
/// used inside `WBT_REGION` and `WBT_TILESET`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RfxRect {
    pub x: u16,
    pub y: u16,
    pub width: u16,
    pub height: u16,
}

impl RfxRect {
    pub const SIZE: usize = 8;

    pub fn parse(buf: &[u8]) -> Result<Self, String> {
        if buf.len() < Self::SIZE {
            return Err(format!("RFX_RECT: {} bytes < {}", buf.len(), Self::SIZE));
        }
        Ok(Self {
            x: u16::from_le_bytes([buf[0], buf[1]]),
            y: u16::from_le_bytes([buf[2], buf[3]]),
            width: u16::from_le_bytes([buf[4], buf[5]]),
            height: u16::from_le_bytes([buf[6], buf[7]]),
        })
    }

    pub fn encode(&self) -> [u8; Self::SIZE] {
        let mut out = [0u8; Self::SIZE];
        out[0..2].copy_from_slice(&self.x.to_le_bytes());
        out[2..4].copy_from_slice(&self.y.to_le_bytes());
        out[4..6].copy_from_slice(&self.width.to_le_bytes());
        out[6..8].copy_from_slice(&self.height.to_le_bytes());
        out
    }
}

/// `TS_RFX_TILE` header. Tiles always carry three quantized colour
/// component streams; their lengths are advertised in this header so
/// the decoder can split the payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RfxTileHeader {
    pub block_type: u16, // 0xCAC3 (CBT_TILE)
    pub block_len: u32,
    pub quant_idx_y: u8,
    pub quant_idx_cb: u8,
    pub quant_idx_cr: u8,
    pub x_idx: u16,
    pub y_idx: u16,
    pub cb_y_data: u16,
    pub cb_cb_data: u16,
    pub cb_cr_data: u16,
}

impl RfxTileHeader {
    pub const SIZE: usize = 19;
    pub const CBT_TILE: u16 = 0xCAC3;

    pub fn parse(buf: &[u8]) -> Result<Self, String> {
        if buf.len() < Self::SIZE {
            return Err(format!(
                "RFX_TILE: {} bytes < {}",
                buf.len(),
                Self::SIZE
            ));
        }
        let block_type = u16::from_le_bytes([buf[0], buf[1]]);
        if block_type != Self::CBT_TILE {
            return Err(format!("RFX_TILE: bad blockType 0x{:04x}", block_type));
        }
        let block_len = u32::from_le_bytes([buf[2], buf[3], buf[4], buf[5]]);
        Ok(Self {
            block_type,
            block_len,
            quant_idx_y: buf[6],
            quant_idx_cb: buf[7],
            quant_idx_cr: buf[8],
            x_idx: u16::from_le_bytes([buf[9], buf[10]]),
            y_idx: u16::from_le_bytes([buf[11], buf[12]]),
            cb_y_data: u16::from_le_bytes([buf[13], buf[14]]),
            cb_cb_data: u16::from_le_bytes([buf[15], buf[16]]),
            cb_cr_data: u16::from_le_bytes([buf[17], buf[18]]),
        })
    }
}

/// Walk a buffer of one or more concatenated RFX blocks. Yields `(header,
/// body)` slices. Returns an error if any header is short or its
/// declared length runs past the end of the buffer.
pub fn iter_blocks(mut buf: &[u8]) -> Result<Vec<(RfxBlockHeader, &[u8])>, String> {
    let mut out = Vec::new();
    while !buf.is_empty() {
        let header = RfxBlockHeader::parse(buf)?;
        let total = header.block_len as usize;
        if total > buf.len() {
            return Err(format!(
                "RFX block: declared length {} > remaining {}",
                total,
                buf.len()
            ));
        }
        let body = &buf[RfxBlockHeader::SIZE..total];
        out.push((header, body));
        buf = &buf[total..];
    }
    Ok(out)
}

/// Encode an RFX block from its header + body bytes.
pub fn encode_block(block_type: u16, body: &[u8]) -> Vec<u8> {
    let total = (RfxBlockHeader::SIZE + body.len()) as u32;
    let header = RfxBlockHeader {
        block_type,
        block_len: total,
    };
    let mut out = Vec::with_capacity(total as usize);
    out.extend_from_slice(&header.encode());
    out.extend_from_slice(body);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn block_header_round_trip() {
        let h = RfxBlockHeader {
            block_type: WBT_SYNC,
            block_len: 12,
        };
        let buf = h.encode();
        let h2 = RfxBlockHeader::parse(&buf).unwrap();
        assert_eq!(h, h2);
    }

    #[test]
    fn block_header_rejects_short_block_len() {
        // block_len < SIZE → invalid (would self-overlap).
        let mut buf = RfxBlockHeader {
            block_type: WBT_SYNC,
            block_len: 4,
        }
        .encode();
        buf[2] = 4;
        assert!(RfxBlockHeader::parse(&buf).is_err());
    }

    #[test]
    fn block_header_rejects_truncated() {
        assert!(RfxBlockHeader::parse(&[1, 2, 3]).is_err());
    }

    #[test]
    fn rect_round_trip() {
        let r = RfxRect { x: 16, y: 32, width: 64, height: 64 };
        let parsed = RfxRect::parse(&r.encode()).unwrap();
        assert_eq!(r, parsed);
    }

    #[test]
    fn tile_header_round_trip() {
        let mut buf = vec![0u8; RfxTileHeader::SIZE];
        buf[0..2].copy_from_slice(&RfxTileHeader::CBT_TILE.to_le_bytes());
        buf[2..6].copy_from_slice(&100u32.to_le_bytes());
        buf[6] = 1;
        buf[7] = 2;
        buf[8] = 3;
        buf[9..11].copy_from_slice(&7u16.to_le_bytes());
        buf[11..13].copy_from_slice(&3u16.to_le_bytes());
        buf[13..15].copy_from_slice(&20u16.to_le_bytes());
        buf[15..17].copy_from_slice(&40u16.to_le_bytes());
        buf[17..19].copy_from_slice(&30u16.to_le_bytes());

        let parsed = RfxTileHeader::parse(&buf).unwrap();
        assert_eq!(parsed.block_len, 100);
        assert_eq!(parsed.x_idx, 7);
        assert_eq!(parsed.y_idx, 3);
        assert_eq!(parsed.cb_y_data, 20);
        assert_eq!(parsed.cb_cb_data, 40);
        assert_eq!(parsed.cb_cr_data, 30);
    }

    #[test]
    fn tile_header_rejects_wrong_type() {
        let buf = vec![0xAB, 0xCD, 100, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        assert!(RfxTileHeader::parse(&buf).is_err());
    }

    #[test]
    fn iter_blocks_emits_in_order() {
        let mut buf = encode_block(WBT_SYNC, &[1, 2, 3]);
        buf.extend(encode_block(WBT_CONTEXT, &[4, 5]));
        buf.extend(encode_block(WBT_FRAME_END, &[]));
        let parsed = iter_blocks(&buf).unwrap();
        assert_eq!(parsed.len(), 3);
        assert_eq!(parsed[0].0.block_type, WBT_SYNC);
        assert_eq!(parsed[0].1, &[1, 2, 3]);
        assert_eq!(parsed[1].0.block_type, WBT_CONTEXT);
        assert_eq!(parsed[1].1, &[4, 5]);
        assert_eq!(parsed[2].0.block_type, WBT_FRAME_END);
        assert!(parsed[2].1.is_empty());
    }

    #[test]
    fn iter_blocks_rejects_overrun() {
        // Header claims 100 bytes but buffer only has 10.
        let mut buf = vec![0u8; 10];
        buf[0..2].copy_from_slice(&WBT_SYNC.to_le_bytes());
        buf[2..6].copy_from_slice(&100u32.to_le_bytes());
        assert!(iter_blocks(&buf).is_err());
    }
}
