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

Also accept the exact six-byte `DeactivateAll` Share Control header sent by
xrdp releases during desktop resizing. The generic header decoder requires
`shareId`, so it rejected this form before the existing optional descriptor
handling could run. Full PDUs keep their regular decoder; malformed short PDUs
still fail. Both valid forms trigger the normal reactivation sequence.

RemoteFX regions are intersected with the surface destination and current
desktop before applying tiles. A padded capture region must not cause the
entire repaint to be discarded after resizing to a non-tile-aligned desktop.
The regression decodes a real RLGR tile in a padded frame and checks visible
RGBA pixels and update bounds.

During reactivation, consume in-flight Fast-Path compression updates without
painting the deactivated surface. xrdp can send compressed pointer updates
between Demand Active and Synchronize; skipping them corrupts the shared MPPC
history and disconnects the next resize. A captured repeated-resize stream
reproduces the invalid Synchronize message type when these updates are skipped.
