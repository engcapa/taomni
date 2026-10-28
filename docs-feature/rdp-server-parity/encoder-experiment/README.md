# Encoder experiment

Run the original registry-compressor experiment as an offline unit test:

```powershell
cargo test --release -- --nocapture
```

Check the actual vendored bulk patch and the current planar candidate/estimator:

```powershell
cargo test --release --features production-vendor -- --nocapture
```

Both runs preserve the historical 16352-byte fragment/header layout, assert
its E/F figures within 2%, check the production 16374-byte layout, and
decompress every transmitted bulk fragment to its original bytes. They also
require the UI budget and photo bandwidth to pass. The original registry
experiment remains available so a vendor fix cannot silently redefine its
historical baseline.

The experiment models payload sizes and uses a serial RemoteFX encoder; its
timings are not native desktop performance. To isolate costs in the actual
parallel server encoder, run this CPU-only unit from `src-tauri/`:

```powershell
cargo test --release -p ironrdp-server --lib profile_photo_encoder_costs -- --ignored --nocapture
```

It runs 16 identical generated photo frames through each path, reports encoder
and fragmentation/compression time separately, and requires RemoteFX selection.
Use GitHub `qa-ui-auto-platforms.yml` PERF-01/03 for native acceptance.

The optional `EncoderStats` handle also reports constant-space cumulative
`count/total/max` nanosecond counters for dirty-rectangle diffing, blocking-pool
queueing, codec work, the entire blocking round trip, adaptive selection,
RemoteFX work and fragmentation. Raw-sample/materialized-candidate counts
distinguish the two planar estimate paths. The normal five-second server log
contains these counters; no pixels or individual-frame traces are retained.
PERF-03 saves a baseline log before the second connection so deltas remain
available even when its original FPS or bandwidth assertion fails. Counters do
not alter codec selection, bulk history, pacing or the 15% acceptance budget.

Selection/estimator ownership now lives in `encoder/adaptive.rs`, telemetry in
`encoder/stats.rs`, and the pre-existing bulk tests in `encoder/bulk_tests.rs`.
The encoder facade remains existing size debt (about 1,000 lines); its remaining
protocol handlers can be extracted separately by codec ownership. This change
does not add another protocol/state responsibility to that facade. Retained
pixel/layout, first-header, resize/history and compressor-failure tests protect
the split, and a mixed UI/photo transmission test requires identical wire bytes
with the optional counters enabled and disabled.
