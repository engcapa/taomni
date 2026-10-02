# ironrdp-bulk 0.1.1

Source: crates.io `ironrdp-bulk` 0.1.1, MIT OR Apache-2.0.

Local patch: XCRUSH decompression recognizes uncompressed packets carrying
`PACKET_FLUSHED`, resets both histories, and returns raw data. Those packets
have no XCRUSH L1/L2 header. This supports an orderly connection-local fallback
after a server compressor error and reference servers that emit raw flushes.
