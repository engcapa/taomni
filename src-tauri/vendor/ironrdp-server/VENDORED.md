# ironrdp-server 0.13.0

Source: crates.io `ironrdp-server` 0.13.0, MIT OR Apache-2.0. This directory
also contains the pre-existing Taomni channel, lifecycle and desktop patches.

Encoder-adaptive patch (`docs-feature/rdp-server-parity/encoder-adaptive-design.md`):

- Opt-in per-connection negotiated MPPC/NCRUSH/XCRUSH, first-packet flush,
  resize reset and connection-local error fallback.
- Independent scratch MPPC estimate from at most four separated 1 KiB planar strips;
  select planar bitmap or default-quantization RemoteFX per dirty rectangle.
- Use raw lossless planar for noisy pixels, a single pass for its three colour
  planes with fixed pixel layouts, and a lightweight disposable MPPC estimator. Repeated colours and
  coherent vertical deltas retain planar RLE. Selected RemoteFX is sent without
  another bulk-compression attempt; raw fragments advance neither history.
- Reserve XCRUSH/fast-path overhead before advancing history; retain the
  cropped bitmap's final partial-stride row.
- Allocate bitmap and RemoteFX output for the actual cropped pixels rather
  than clearing a retained parent framebuffer tail for every rectangle.
- In the bulk path, write the bitmap header scan width in bytes. This permits
  odd-width damage rectangles without a forced RemoteFX fallback; legacy
  non-bulk headers retain their original bytes.
- Optional aggregate encoding counters and observation of static channels
  actually joined by the peer. Proprietary codec paths keep their wire format.
- Unit contracts enabled as Cargo workspace members alongside acceptor/bulk.

Taomni enables the patch by default; `TAOMNI_RDP_BULK_COMPRESSION=0` restores
the prior display encoder and fast-path bytes.
