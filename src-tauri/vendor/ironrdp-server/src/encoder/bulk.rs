//! The send history belongs to one connection and advances only for emitted
//! fragments. Estimation must always use a separate, disposable compressor.

use anyhow::Result;
use ironrdp_bulk::{BulkCompressor, CompressionType as BulkType, flags};
use ironrdp_pdu::rdp::client_info::CompressionType;
use tracing::warn;

pub(crate) struct BulkEncoder {
    pub(crate) compressor: Option<BulkCompressor>,
    kind: CompressionType,
    flush_next: bool,
}

impl BulkEncoder {
    pub(crate) fn max_fragment_size(&self) -> usize {
        if self.kind == CompressionType::K8 {
            8191
        } else {
            super::MAX_FASTPATH_UPDATE_SIZE
        }
    }

    pub(crate) fn new(kind: CompressionType) -> Result<Self> {
        Ok(Self {
            compressor: Some(BulkCompressor::new(match kind {
                CompressionType::K8 => BulkType::Rdp4,
                CompressionType::K64 => BulkType::Rdp5,
                CompressionType::Rdp6 => BulkType::Rdp6,
                CompressionType::Rdp61 => BulkType::Rdp61,
            })?),
            kind,
            flush_next: true,
        })
    }

    pub(crate) fn reset(&mut self) -> Result<()> {
        // A failed compressor stays disabled until the next connection.
        if self.compressor.is_some() {
            *self = Self::new(self.kind)?;
        }
        Ok(())
    }

    pub(crate) fn compress(&mut self, data: &[u8]) -> (Vec<u8>, u32) {
        let Some(compressor) = self.compressor.as_mut() else {
            return (data.to_vec(), 0);
        };
        let result = compressor.compress(data);
        self.finish_compression(data, result)
    }

    fn finish_compression(
        &mut self,
        data: &[u8],
        result: core::result::Result<(usize, u32), ironrdp_bulk::BulkError>,
    ) -> (Vec<u8>, u32) {
        match result {
            Ok((size, mut packet_flags)) => {
                if packet_flags & flags::PACKET_COMPRESSED != 0 {
                    let mut encoded = self
                        .compressor
                        .as_ref()
                        .expect("compressor enabled")
                        .compressed_data(size)
                        .to_vec();
                    if self.flush_next {
                        packet_flags |= flags::PACKET_FLUSHED;
                        if self.kind == CompressionType::Rdp61 {
                            // XCRUSH has a second, independent MPPC history. A
                            // reactivation must reset both histories at the peer.
                            encoded[1] |= flags::PACKET_FLUSHED as u8;
                        }
                        self.flush_next = false;
                    }
                    (encoded, packet_flags)
                } else {
                    (data.to_vec(), packet_flags)
                }
            }
            Err(error) => {
                warn!(%error, "RDP bulk compression failed; disabling it for this connection");
                self.compressor = None;
                (
                    data.to_vec(),
                    flags::PACKET_FLUSHED | u32::from(self.kind.as_u8()),
                )
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compression_error_flushes_the_peer_and_disables_the_connection() {
        let mut sender = BulkEncoder::new(CompressionType::Rdp61).unwrap();
        let mut receiver = BulkCompressor::new(BulkType::Rdp61).unwrap();
        let input = vec![42; 4096];
        let (packet, packet_flags) = sender.compress(&input);
        assert_eq!(receiver.decompress(&packet, packet_flags).unwrap(), input);
        let raw = b"uncompressed failure recovery";
        let (packet, packet_flags) = sender.finish_compression(
            raw,
            Err(ironrdp_bulk::BulkError::InvalidCompressedData(
                "injected codec failure",
            )),
        );
        assert_eq!(packet_flags, flags::PACKET_FLUSHED | 3);
        assert_eq!(receiver.decompress(&packet, packet_flags).unwrap(), raw);
        assert!(sender.compressor.is_none());
        sender.reset().unwrap();
        assert!(sender.compressor.is_none());
        assert_eq!(sender.compress(&input), (input, 0));
    }
}
