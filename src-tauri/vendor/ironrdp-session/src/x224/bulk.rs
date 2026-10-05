use std::borrow::Cow;

use ironrdp_bulk::{BulkCompressor, flags};
use tracing::debug;

use crate::{SessionResult, reason_err};

// MS-RDPBCGR 2.2.8.1.1.1.1 / 2.2.8.1.1.1.2: the six-byte
// ShareControlHeader precedes the twelve-byte ShareDataHeader. Compression
// starts after both headers; typed PDU parsing must happen after decompression.
const SHARE_DATA_HEADER_SIZE: usize = 18;
const DATA_PDU_TYPE: u16 = 0x0017;
const COMPRESSION_FLAGS: u8 =
    (flags::PACKET_COMPRESSED | flags::PACKET_AT_FRONT | flags::PACKET_FLUSHED) as u8;

pub(super) fn decompress_share_data<'a>(
    user_data: &'a [u8],
    decompressor: Option<&mut BulkCompressor>,
) -> SessionResult<Cow<'a, [u8]>> {
    // Non-data IO PDUs (e.g. DeactivateAll / multitransport) keep their existing
    // decoder. Leave incomplete headers to that decoder too.
    if user_data.len() < SHARE_DATA_HEADER_SIZE
        || u16::from_le_bytes([user_data[2], user_data[3]]) != DATA_PDU_TYPE
        || user_data[15] & COMPRESSION_FLAGS == 0
    {
        return Ok(Cow::Borrowed(user_data));
    }

    let total_length = usize::from(u16::from_le_bytes([user_data[0], user_data[1]]));
    if total_length != user_data.len() {
        return Err(reason_err!(
            "SlowPath",
            "invalid compressed Share Control length"
        ));
    }
    let compressed_length = usize::from(u16::from_le_bytes([user_data[16], user_data[17]]));
    if user_data[15] & flags::PACKET_COMPRESSED as u8 != 0 && compressed_length != total_length {
        return Err(reason_err!(
            "SlowPath",
            "invalid compressed Share Data length"
        ));
    }
    let decompressor = decompressor.ok_or_else(|| {
        reason_err!(
            "SlowPath",
            "received bulk compression without a negotiated decompressor"
        )
    })?;
    let payload = decompressor
        .decompress(
            &user_data[SHARE_DATA_HEADER_SIZE..],
            u32::from(user_data[15]),
        )
        .map_err(|e| reason_err!("SlowPath", "bulk decompression failed: {}", e))?;
    let normalized_length =
        u16::try_from(SHARE_DATA_HEADER_SIZE + payload.len()).map_err(|_| {
            reason_err!(
                "SlowPath",
                "decompressed Share Data exceeds the PDU length limit"
            )
        })?;

    let mut normalized = Vec::with_capacity(usize::from(normalized_length));
    normalized.extend_from_slice(&user_data[..SHARE_DATA_HEADER_SIZE]);
    normalized.extend_from_slice(payload);
    normalized[0..2].copy_from_slice(&normalized_length.to_le_bytes());
    normalized[12..14].copy_from_slice(&normalized_length.to_le_bytes());
    normalized[15] = 0;
    normalized[16..18].copy_from_slice(&0u16.to_le_bytes());
    debug!(
        pdu_type = user_data[14],
        compression_flags = user_data[15],
        compressed_size = user_data.len() - SHARE_DATA_HEADER_SIZE,
        decompressed_size = payload.len(),
        "Decompressed slow-path Share Data"
    );
    Ok(Cow::Owned(normalized))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ironrdp_bulk::CompressionType;
    use ironrdp_core::encode_vec;
    use ironrdp_pdu::gcc::{Monitor, MonitorFlags};
    use ironrdp_pdu::mcs::SendDataIndicationCtx;
    use ironrdp_pdu::rdp::finalization_messages::MonitorLayoutPdu;
    use ironrdp_pdu::rdp::headers::{IoChannelPdu, ShareDataPdu, decode_io_channel};

    #[test]
    fn typed_monitor_layout_is_decompressed_before_its_monitor_count_is_parsed() {
        let layout = MonitorLayoutPdu {
            monitors: (0..4)
                .map(|index| Monitor {
                    left: index * 320,
                    top: 0,
                    right: (index + 1) * 320 - 1,
                    bottom: 239,
                    flags: if index == 0 {
                        MonitorFlags::PRIMARY
                    } else {
                        MonitorFlags::empty()
                    },
                })
                .collect(),
        };
        let raw = encode_vec(&layout).unwrap();
        let mut sender = BulkCompressor::new(CompressionType::Rdp5).unwrap();
        let (length, flags) = sender.compress(&raw).unwrap();
        assert_ne!(flags & flags::PACKET_COMPRESSED, 0);
        let compressed = sender.compressed_data(length);
        let mut user_data = Vec::new();
        user_data.extend_from_slice(&u16::try_from(18 + length).unwrap().to_le_bytes());
        user_data.extend_from_slice(&0x17u16.to_le_bytes());
        user_data.extend_from_slice(&1003u16.to_le_bytes());
        user_data.extend_from_slice(&0x1234u32.to_le_bytes());
        user_data.extend_from_slice(&[0, 1]);
        user_data.extend_from_slice(&u16::try_from(18 + raw.len()).unwrap().to_le_bytes());
        user_data.extend_from_slice(&[55, u8::try_from(flags).unwrap()]);
        user_data.extend_from_slice(&u16::try_from(18 + length).unwrap().to_le_bytes());
        user_data.extend_from_slice(compressed);
        let mut receiver = BulkCompressor::new(CompressionType::Rdp5).unwrap();
        let decoded = decompress_share_data(&user_data, Some(&mut receiver)).unwrap();
        let IoChannelPdu::Data(ctx) = decode_io_channel(SendDataIndicationCtx {
            initiator_id: 1007,
            channel_id: 1003,
            user_data: &decoded,
        })
        .unwrap() else {
            panic!("expected Share Data");
        };
        assert_eq!(ctx.pdu, ShareDataPdu::MonitorLayout(layout));
    }
}
