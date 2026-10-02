# ironrdp-bulk 0.1.1

Source: crates.io `ironrdp-bulk` 0.1.1, MIT OR Apache-2.0.

Local patch: XCRUSH decompression recognizes uncompressed packets carrying
`PACKET_FLUSHED`, resets both histories, and returns raw data. Those packets
have no XCRUSH L1/L2 header. This supports an orderly connection-local fallback
after a server compressor error and reference servers that emit raw flushes.

XCRUSH compression also keeps MPPC payloads marked COMPRESSED + FLUSHED.
Previously it discarded these payloads and reset again, leaving compression
stuck in raw mode after an incompressible packet. A sequence regression checks
recovery, the size reduction and exact decompression with continuing histories.

`BulkCompressor::estimate_mppc64k_size` allocates only an independent MPPC
context for the server's disposable size estimate. It avoids allocating all
six unrelated compression/decompression contexts for every dirty rectangle;
its estimates match a fresh RDP5 coordinator byte for byte.
