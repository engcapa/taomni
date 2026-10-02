# ironrdp-server 0.13.0

Source: crates.io `ironrdp-server` 0.13.0, MIT OR Apache-2.0. This directory
also contains the pre-existing Taomni channel, lifecycle and desktop patches.

Encoder-adaptive patch (`docs-feature/rdp-server-parity/encoder-adaptive-design.md`):

- Opt-in per-connection negotiated MPPC/NCRUSH/XCRUSH, first-packet flush,
  resize reset and connection-local error fallback.
- Independent scratch MPPC estimate of at most one 16374-byte planar fragment;
  select planar bitmap or default-quantization RemoteFX per dirty rectangle.
- Reserve XCRUSH/fast-path overhead before advancing history; retain the
  cropped bitmap's final partial-stride row.
- Optional aggregate encoding counters and observation of static channels
  actually joined by the peer. Proprietary codec paths keep their wire format.
- Unit contracts enabled as Cargo workspace members alongside acceptor/bulk.

Taomni enables the patch by default; `TAOMNI_RDP_BULK_COMPRESSION=0` restores
the prior display encoder and fast-path bytes.
