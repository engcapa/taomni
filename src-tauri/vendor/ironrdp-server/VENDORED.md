# ironrdp-server 0.13.0

Source: crates.io `ironrdp-server` 0.13.0, MIT OR Apache-2.0. This directory
also contains the pre-existing Taomni channel, lifecycle and desktop patches.

Encoder-adaptive patch (`docs-feature/rdp-server-parity/encoder-adaptive-design.md`):

- Opt-in per-connection negotiated MPPC/NCRUSH/XCRUSH, first-packet flush,
  resize reset and connection-local error fallback.
- Independent scratch MPPC estimate from at most four separated 256-byte planar strips;
  select planar bitmap or default-quantization RemoteFX per dirty rectangle.
- For raw planar candidates, derive the exact length and those same sample bytes
  directly from the cropped pixels; materialize all planes only if planar wins.
  Byte-layout tests cover eight pixel formats, parent strides and split bitmaps.
- Use raw lossless planar for noisy pixels, vectorizable channel loops with
  fixed pixel layouts, and a lightweight disposable MPPC estimator. Repeated colours and
  coherent vertical deltas retain planar RLE. Selected RemoteFX is sent without
  another bulk-compression attempt; raw fragments advance neither history.
- Reserve XCRUSH/fast-path overhead before advancing history; retain the
  cropped bitmap's final partial-stride row.
- In the adaptive path, allocate bitmap and RemoteFX output for the actual
  cropped pixels rather than clearing a retained parent framebuffer tail.
  Legacy RemoteFX retains its original reserve and retry behavior byte for byte.
- Honor the peer's General NO_BITMAP_COMPRESSION_HDR capability in the bulk
  path. Omit TS_CD_HEADER for peers supporting it, including odd-width damage;
  otherwise cbScanWidth is pixels divisible by four, and odd-width adaptive
  rectangles use RemoteFX. Legacy non-bulk headers retain their original bytes.
  See MS-RDPBCGR 2.2.9.1.1.3.1.2.3 and the capability/byte-layout unit contracts.
- Optional aggregate encoding counters and observation of static channels
  actually joined by the peer. Proprietary codec paths keep their wire format.
- Unit contracts enabled as Cargo workspace members alongside acceptor/bulk.

Taomni enables the patch by default; `TAOMNI_RDP_BULK_COMPRESSION=0` restores
the prior display encoder and fast-path bytes.
