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
