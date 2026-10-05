# ironrdp-session 0.11.0

Source: crates.io `ironrdp-session` 0.11.0, MIT OR Apache-2.0.

Local patch: decompress slow-path Share Data before typed PDU decoding. Its
compression flags were previously discarded by `decode_io_channel`, so compressed
graphics were interpreted as bitmap headers. Both fast and slow paths use the
same connection-owned `BulkCompressor`, preserving MPPC/NCRUSH/XCRUSH histories
when a peer switches paths. Compression is still negotiated normally.

Uncompressed FLUSHED/AT_FRONT packets also reach the shared decompressor. Routing
for virtual channels, DeactivateAll and multitransport remains in the existing
decoder. Invalid compressed lengths and compressed input without negotiation
fail explicitly. Regression tests exercise decoded pixels, path interleaving,
typed PDUs, history resets and uncompressed peers.
