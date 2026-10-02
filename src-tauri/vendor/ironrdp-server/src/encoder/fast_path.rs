use super::{EncoderStats, bulk::BulkEncoder};
use anyhow::{Context as _, Result};
use core::sync::atomic::Ordering;
use core::{cmp, fmt};
use ironrdp_pdu::rdp::client_info::CompressionType;
use ironrdp_pdu::rdp::headers::CompressionFlags;

use ironrdp_pdu::fast_path::{
    EncryptionFlags, FastPathHeader, FastPathUpdatePdu, Fragmentation, UpdateCode,
};
use ironrdp_pdu::{Encode as _, WriteCursor};

// this is the maximum amount of data (not including headers) we can send in a single TS_FP_UPDATE_PDU
pub(crate) const MAX_FASTPATH_UPDATE_SIZE: usize = 16_374;

const FASTPATH_HEADER_SIZE: usize = 7;

#[expect(
    clippy::allow_attributes,
    reason = "Unfortunately, expect attribute doesn't work when above or after visibility::make attribute"
)]
#[allow(unreachable_pub)]
#[expect(
    clippy::partial_pub_fields,
    reason = "public field is not a part of the public API and is used by benchmarks"
)]
#[cfg_attr(feature = "__bench", visibility::make(pub))]
pub(crate) struct UpdateFragmenter {
    pub(super) code: UpdateCode,
    index: usize,
    #[doc(hidden)] // not part of the public API, used by benchmarks
    pub data: Vec<u8>,
    position: usize,
}

impl fmt::Debug for UpdateFragmenter {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("UpdateFragmenter")
            .field("len", &self.data.len())
            .finish()
    }
}

impl UpdateFragmenter {
    pub(crate) fn new(code: UpdateCode, data: Vec<u8>) -> Self {
        Self {
            code,
            index: 0,
            data,
            position: 0,
        }
    }

    pub(crate) fn size_hint(&self) -> usize {
        // XCRUSH may return an equal-sized inner block plus its two-byte
        // header, and a compressed update has an extra flags byte.
        FASTPATH_HEADER_SIZE + 3 + cmp::min(self.data.len(), MAX_FASTPATH_UPDATE_SIZE)
    }

    pub(crate) fn next(
        &mut self,
        dst: &mut [u8],
        bulk: Option<&mut BulkEncoder>,
        stats: Option<&EncoderStats>,
    ) -> Result<Option<usize>> {
        let remaining = self.data.len() - self.position;
        if remaining == 0 {
            return Ok(None);
        }
        // Validate capacity before advancing compression history.
        anyhow::ensure!(
            dst.len() >= self.size_hint(),
            "fast-path output buffer is too small"
        );
        let consumed = remaining.min(
            bulk.as_ref()
                .map_or(MAX_FASTPATH_UPDATE_SIZE, |bulk| bulk.max_fragment_size()),
        );
        let frag = match (self.index == 0, consumed == remaining) {
            (true, true) => Fragmentation::Single,
            (true, false) => Fragmentation::First,
            (false, true) => Fragmentation::Last,
            (false, false) => Fragmentation::Next,
        };
        let written = self.encode_fastpath(
            frag,
            &self.data[self.position..self.position + consumed],
            dst,
            bulk,
            stats,
        )?;
        self.position += consumed;
        self.index += 1;
        Ok(Some(written))
    }

    fn encode_fastpath(
        &self,
        frag: Fragmentation,
        raw: &[u8],
        dst: &mut [u8],
        bulk: Option<&mut BulkEncoder>,
        stats: Option<&EncoderStats>,
    ) -> Result<usize> {
        let mut cursor = WriteCursor::new(dst);

        let encoded = bulk.map(|bulk| bulk.compress(raw));
        let (data, flags) = encoded
            .as_ref()
            .map_or((raw, 0), |(data, flags)| (data.as_slice(), *flags));
        let compression_flags =
            (flags & 0xE0 != 0).then(|| CompressionFlags::from_bits_retain((flags & 0xE0) as u8));
        let compression_type = compression_flags.map(|_| match flags & 0x0F {
            0 => CompressionType::K8,
            1 => CompressionType::K64,
            2 => CompressionType::Rdp6,
            _ => CompressionType::Rdp61,
        });

        let update = FastPathUpdatePdu {
            fragmentation: frag,
            update_code: self.code,
            compression_flags,
            compression_type,
            data,
        };

        let header = FastPathHeader::new(EncryptionFlags::empty(), update.size());

        header.encode(&mut cursor).context("fast-path header")?;
        update.encode(&mut cursor).context("fast-path update")?;
        if let Some(stats) = stats {
            stats
                .bytes_before_bulk
                .fetch_add(raw.len() as u64, Ordering::Relaxed);
            stats.bytes_after_bulk.fetch_add(
                data.len() as u64 + u64::from(compression_flags.is_some()),
                Ordering::Relaxed,
            );
        }
        Ok(cursor.pos())
    }
}

#[cfg(test)]
mod tests {
    use ironrdp_core::{ReadCursor, decode_cursor};

    use super::*;

    #[test]
    fn all_bulk_levels_round_trip_fragments_and_signal_reactivation() {
        use ironrdp_bulk::{BulkCompressor, CompressionType as BulkType, flags};
        for (kind, bulk_kind) in [
            (CompressionType::K8, BulkType::Rdp4),
            (CompressionType::K64, BulkType::Rdp5),
            (CompressionType::Rdp6, BulkType::Rdp6),
            (CompressionType::Rdp61, BulkType::Rdp61),
        ] {
            let mut sender = BulkEncoder::new(kind).unwrap();
            let mut receiver = BulkCompressor::new(bulk_kind).unwrap();
            for round in 0..3 {
                if round == 2 {
                    sender.reset().unwrap();
                }
                let original: Vec<u8> =
                    (0..40_000).map(|i| ((i + round * 13) % 29) as u8).collect();
                let mut fragmenter = UpdateFragmenter::new(UpdateCode::Bitmap, original.clone());
                let mut output = vec![0; fragmenter.size_hint()];
                let mut decoded = Vec::new();
                let mut first = true;
                while let Some(written) = fragmenter
                    .next(&mut output, Some(&mut sender), None)
                    .unwrap()
                {
                    let mut cursor = ReadCursor::new(&output[..written]);
                    let _: FastPathHeader = decode_cursor(&mut cursor).unwrap();
                    let update: FastPathUpdatePdu<'_> = decode_cursor(&mut cursor).unwrap();
                    assert_eq!(update.compression_type, Some(kind));
                    let compression = update.compression_flags.unwrap();
                    if first && (round == 0 || round == 2) {
                        assert!(
                            compression.contains(CompressionFlags::FLUSHED),
                            "{kind:?} reset"
                        );
                    }
                    let packet_flags = u32::from(compression.bits()) | u32::from(kind.as_u8());
                    decoded
                        .extend_from_slice(receiver.decompress(update.data, packet_flags).unwrap());
                    first = false;
                }
                assert_eq!(decoded, original, "{kind:?}, round {round}");
                assert!(!first);
                assert!(flags::PACKET_COMPRESSED != 0);
            }
        }
    }

    #[test]
    fn a_short_output_buffer_never_advances_the_bulk_history() {
        let mut sender = BulkEncoder::new(CompressionType::Rdp61).unwrap();
        let mut fragmenter = UpdateFragmenter::new(UpdateCode::Bitmap, vec![42; 500]);
        assert!(
            fragmenter
                .next(&mut [0; 10], Some(&mut sender), None)
                .is_err()
        );
        assert_eq!(fragmenter.position, 0);
        let mut buffer = vec![0; fragmenter.size_hint()];
        let size = fragmenter
            .next(&mut buffer, Some(&mut sender), None)
            .unwrap()
            .unwrap();
        let mut cursor = ReadCursor::new(&buffer[..size]);
        let _: FastPathHeader = decode_cursor(&mut cursor).unwrap();
        let update: FastPathUpdatePdu<'_> = decode_cursor(&mut cursor).unwrap();
        assert!(
            update
                .compression_flags
                .unwrap()
                .contains(CompressionFlags::FLUSHED)
        );
    }

    #[test]
    fn test_single_fragment() {
        let data = vec![1, 2, 3, 4];
        let mut fragmenter = UpdateFragmenter::new(UpdateCode::Bitmap, data);
        let mut buffer = vec![0; 100];
        let written = fragmenter.next(&mut buffer, None, None).unwrap().unwrap();
        assert!(written > 0);
        assert_eq!(fragmenter.index, 1);

        let mut cursor = ReadCursor::new(&buffer);
        let header: FastPathHeader = decode_cursor(&mut cursor).unwrap();
        let update: FastPathUpdatePdu<'_> = decode_cursor(&mut cursor).unwrap();
        assert!(matches!(header, FastPathHeader { data_length: 7, .. }));
        assert!(matches!(
            update,
            FastPathUpdatePdu {
                fragmentation: Fragmentation::Single,
                ..
            }
        ));

        assert!(fragmenter.next(&mut buffer, None, None).unwrap().is_none());
    }

    #[test]
    fn test_multi_fragment() {
        let data = vec![0u8; MAX_FASTPATH_UPDATE_SIZE * 2 + 10];
        let mut fragmenter = UpdateFragmenter::new(UpdateCode::Bitmap, data);
        let mut buffer = vec![0u8; fragmenter.size_hint()];
        let written = fragmenter.next(&mut buffer, None, None).unwrap().unwrap();
        assert!(written > 0);
        assert_eq!(fragmenter.index, 1);

        let mut cursor = ReadCursor::new(&buffer);
        let _header: FastPathHeader = decode_cursor(&mut cursor).unwrap();
        let update: FastPathUpdatePdu<'_> = decode_cursor(&mut cursor).unwrap();
        assert!(matches!(
            update,
            FastPathUpdatePdu {
                fragmentation: Fragmentation::First,
                ..
            }
        ));
        assert_eq!(update.data.len(), MAX_FASTPATH_UPDATE_SIZE);

        let written = fragmenter.next(&mut buffer, None, None).unwrap().unwrap();
        assert!(written > 0);
        assert_eq!(fragmenter.index, 2);
        let mut cursor = ReadCursor::new(&buffer);
        let _header: FastPathHeader = decode_cursor(&mut cursor).unwrap();
        let update: FastPathUpdatePdu<'_> = decode_cursor(&mut cursor).unwrap();
        assert!(matches!(
            update,
            FastPathUpdatePdu {
                fragmentation: Fragmentation::Next,
                ..
            }
        ));
        assert_eq!(update.data.len(), MAX_FASTPATH_UPDATE_SIZE);

        let written = fragmenter.next(&mut buffer, None, None).unwrap().unwrap();
        assert!(written > 0);
        assert_eq!(fragmenter.index, 3);
        let mut cursor = ReadCursor::new(&buffer);
        let _header: FastPathHeader = decode_cursor(&mut cursor).unwrap();
        let update: FastPathUpdatePdu<'_> = decode_cursor(&mut cursor).unwrap();
        assert!(matches!(
            update,
            FastPathUpdatePdu {
                fragmentation: Fragmentation::Last,
                ..
            }
        ));
        assert_eq!(update.data.len(), 10);

        assert!(fragmenter.next(&mut buffer, None, None).unwrap().is_none());
    }
}
